/**
 * Shared state, settings, audio plumbing and speech output for the voice engine (split from
 * VoiceEngine.ts to keep files under the size limit, Audit I-22). See VoiceEngine.ts for the design.
 * VoiceRecognition adds the browser recogniser and recorder; VoiceEngine adds turn taking.
 */
import { synthesizeSpeech } from "../api";
import { AdaptiveVad } from "../vad";
import { cloudSpeechAllowed, liveLevels, voiceStore } from "./voiceStore";
import { SentenceChunker, toSpeakable } from "./speechText";
import { vlog } from "./voiceLog";
import { QueuedSpeech, StoredSettings, TICK_MS, TTS_PREFETCH, TTS_TIMEOUT_MS, readSettings, writeSettings, DEFAULT_LOCALE } from "./voiceConfig";

export interface VoiceEngineHandlers {
  /** A finished user utterance. The page should run the query and feed the answer back. */
  onUtterance: (text: string) => void;
  /** The user stopped the assistant mid-answer; the page should abort the in-flight answer. */
  onInterrupt?: () => void;
}

export abstract class VoiceEngineCore {
  protected handlers: VoiceEngineHandlers;
  protected ctx: AudioContext | null = null;
  protected stream: MediaStream | null = null;
  protected micSource: MediaStreamAudioSourceNode | null = null;
  protected micAnalyser: AnalyserNode | null = null;
  protected outAnalyser: AnalyserNode | null = null;
  protected outGain: GainNode | null = null;
  protected micBuffer = new Float32Array(1024);
  protected outBuffer = new Float32Array(1024);
  protected tickTimer: ReturnType<typeof setInterval> | null = null;
  protected vad = new AdaptiveVad();

  // listening state
  protected recognition: any = null;
  protected recognitionFailed = false;
  protected finalText = "";
  protected interimText = "";
  protected lastResultAt = 0;
  protected recorder: MediaRecorder | null = null;
  protected recordedChunks: Blob[] = [];
  protected listenStartedAt = 0;
  protected heardSpeech = false;
  protected finishing = false;
  protected standby = false;
  protected wakeWordTriggered = false;
  protected wakeWordTimeout: ReturnType<typeof setTimeout> | null = null;
  protected lastStandbyCheck = 0;

  // speaking state
  protected queue: QueuedSpeech[] = [];
  protected chunker = new SentenceChunker();
  protected responseOpen = false;
  protected playing = false;
  /** Assistant audio is audible right now (a buffer is playing or the browser voice is talking). */
  protected audible = false;
  protected currentSource: AudioBufferSourceNode | null = null;
  protected audibleSince = 0;
  protected bargeInVoicedMs = 0;
  /** Upper envelope of mic level per unit of assistant output (speaker → mic echo). */
  protected echoEnvelope = 0;
  protected generation = 0;
  protected syntheticLevelUntil = 0;
  protected abort: AbortController | null = null;
  /** After repeated API TTS failures, speak with the browser voice instead of retrying each sentence. */
  protected serverTtsFailures = 0;
  protected settingsExplicit: StoredSettings = {};

  ttsVoice: string | undefined;

  constructor(handlers: VoiceEngineHandlers) {
    this.handlers = handlers;
    if (typeof window !== "undefined") {
      this.settingsExplicit = readSettings();
      voiceStore.set({
        bargeIn: this.settingsExplicit.bargeIn ?? false,
        sttMode: this.settingsExplicit.sttMode ?? "auto",
        // Wake word is opt-in: it keeps the mic open and needs browser (possibly third-party) recognition
        wakeWordEnabled: this.settingsExplicit.wakeWordEnabled ?? false,
        browserSpeechOptIn: this.settingsExplicit.browserSpeechOptIn ?? false,
        ttsVoice: this.settingsExplicit.ttsVoice ?? null,
      });
      this.ttsVoice = this.settingsExplicit.ttsVoice || undefined;
    }
  }

  /** Persisted assistant voice; null returns to the server's configured default (VOICE_ID). */
  setTtsVoice(voice: string | null) {
    this.ttsVoice = voice || undefined;
    this.settingsExplicit = { ...this.settingsExplicit, ttsVoice: voice || undefined };
    writeSettings(this.settingsExplicit);
    voiceStore.set({ ttsVoice: voice });
  }

  get phase() {
    return voiceStore.get().phase;
  }

  get inConversation() {
    return voiceStore.get().conversation;
  }

  get isStandby() {
    return this.standby;
  }

  get wakeWordEnabled() {
    return voiceStore.get().wakeWordEnabled;
  }

  // ------------------------------------------------------------------ settings

  setBargeIn(on: boolean) {
    this.settingsExplicit = { ...this.settingsExplicit, bargeIn: on };
    writeSettings(this.settingsExplicit);
    voiceStore.set({ bargeIn: on });
    vlog("setting", { bargeIn: on });
  }

  setSttMode(mode: "auto" | "server") {
    this.settingsExplicit = { ...this.settingsExplicit, sttMode: mode };
    writeSettings(this.settingsExplicit);
    this.recognitionFailed = false;
    voiceStore.set({ sttMode: mode });
    vlog("setting", { sttMode: mode });
  }

  setWakeWordEnabled(on: boolean) {
    this.settingsExplicit = { ...this.settingsExplicit, wakeWordEnabled: on };
    writeSettings(this.settingsExplicit);
    voiceStore.set({ wakeWordEnabled: on });
    vlog("setting", { wakeWordEnabled: on });
    if (on) {
      if (!this.inConversation && !this.standby) {
        this.startStandby().catch(() => {});
      }
    } else {
      if (this.standby && !this.inConversation) {
        this.endConversation("wake-word-disabled", true);
      }
    }
  }

  setBrowserSpeechOptIn(optIn: boolean) {
    this.settingsExplicit = { ...this.settingsExplicit, browserSpeechOptIn: optIn };
    writeSettings(this.settingsExplicit);
    this.recognitionFailed = false;
    voiceStore.set({ browserSpeechOptIn: optIn });
    vlog("setting", { browserSpeechOptIn: optIn });
    // Withdrawing consent stops any passive browser recognition immediately
    if (!optIn && this.standby && !this.inConversation) {
      this.endConversation("browser-speech-opt-out", true);
    }
  }

  /**
   * Voice interruption is only safe when the assistant's audio can't leak back into the mic.
   * Unless the user chose explicitly, enable it when the output device looks like headphones.
   */
  protected async detectHeadphones() {
    if (this.settingsExplicit.bargeIn !== undefined) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const out = devices.find((d) => d.kind === "audiooutput" && d.deviceId === "default") ||
        devices.find((d) => d.kind === "audiooutput");
      const headphones = !!out && /head(phone|set)|earphone|earbud|airpod|buds|hands-free/i.test(out.label);
      voiceStore.set({ bargeIn: headphones });
      vlog("output-device", { label: out?.label?.slice(0, 60) || "unknown", bargeIn: headphones });
    } catch {
      /* keep the default (off) */
    }
  }

  // ------------------------------------------------------------------ implemented by VoiceEngine

  abstract startStandby(): Promise<void>;
  abstract endConversation(reason?: string, forceStop?: boolean): void;
  abstract listenStandby(): void;
  protected abstract tick(): void;
  protected abstract listen(): void;
  protected abstract stopListening(discard: boolean): void;
  protected abstract deliver(text: string, gen: number): void;

  protected async ensureAudioContext(): Promise<AudioContext> {
    if (!this.ctx || this.ctx.state === "closed") {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      this.outGain = this.ctx.createGain();
      this.outAnalyser = this.ctx.createAnalyser();
      this.outAnalyser.fftSize = 1024;
      this.outGain.connect(this.outAnalyser);
      this.outAnalyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    this.startTicking();
    return this.ctx;
  }

  protected async ensureMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "this page is not on a secure origin. Open it at http://localhost:3000 (or over https) to use the microphone"
      );
    }
    const ctx = await this.ensureAudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (!this.ctx || this.ctx.state === "closed" || ctx.state === "closed") {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    // keep a reference to the source node: an unreferenced node can be garbage-collected
    this.micSource = ctx.createMediaStreamSource(this.stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.micAnalyser.smoothingTimeConstant = 0.2;
    this.micSource.connect(this.micAnalyser);
    const track = this.stream.getAudioTracks()[0];
    vlog("mic-open", { label: track?.label?.slice(0, 60), sampleRate: ctx.sampleRate });
  }

  protected releaseMic(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micSource?.disconnect();
    this.stream = null;
    this.micSource = null;
    this.micAnalyser = null;
    liveLevels.mic = 0;
  }

  protected startTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  protected stopTickingIfIdle(): void {
    if (!this.inConversation && !this.playing && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
      liveLevels.mic = 0;
      liveLevels.output = 0;
    }
  }

  protected setPhase(phase: ReturnType<typeof voiceStore.get>["phase"]) {
    if (this.phase !== phase) vlog("phase", { phase });
    voiceStore.set({ phase });
  }

  // ------------------------------------------------------------------ speaking

  /** The assistant has started generating an answer for the current turn. */
  beginResponse(): void {
    this.stopSpeaking("new-response");
    this.chunker = new SentenceChunker();
    this.responseOpen = true;
    if (this.inConversation) this.setPhase("thinking");
  }

  /** Stream answer text in; complete sentences are synthesised and queued immediately. */
  pushResponseText(delta: string): void {
    if (!this.responseOpen) return;
    this.chunker.push(delta).forEach((s) => this.enqueue(s));
  }

  /** No more text for this answer. Mic re-opens once everything queued has been spoken. */
  endResponse(): void {
    if (!this.responseOpen) return;
    this.chunker.flush().forEach((s) => this.enqueue(s));
    this.responseOpen = false;
    this.maybeFinishSpeaking();
  }

  /** Speak one short message as a complete response (e.g. "Here is your dashboard"). */
  say(text: string): void {
    this.beginResponse();
    this.pushResponseText(text);
    this.endResponse();
  }

  /** Read arbitrary text aloud (the speaker button on a message). */
  speakText(markdown: string): void {
    // create/resume the AudioContext synchronously inside the click so autoplay rules allow it
    const ready = this.ensureAudioContext();
    this.stopListening(true); // never transcribe our own voice
    this.stopSpeaking("read-aloud");
    voiceStore.set({ readingAloud: true });
    vlog("read-aloud", { chars: markdown.length });
    const gen = this.generation;
    ready.then(() => {
      if (gen !== this.generation) return; // stopped before the audio context was ready
      this.chunker = new SentenceChunker();
      this.responseOpen = true;
      this.pushResponseText(toSpeakable(markdown));
      this.endResponse();
    });
  }

  /** Quick check for the settings menu: plays a short sentence through the normal TTS path. */
  testSpeaker(): void {
    this.speakText("This is a test of the Aether voice. If you can hear this, speech output is working.");
  }

  stopSpeaking(reason = "stop"): void {
    if (this.playing || this.queue.length) vlog("speech-stopped", { reason, queued: this.queue.length });
    this.generation++;
    this.queue = [];
    this.responseOpen = false;
    this.abort?.abort();
    this.abort = null;
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch {
        /* ignore */
      }
      this.currentSource = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
    this.playing = false;
    this.audible = false;
    this.syntheticLevelUntil = 0;
    voiceStore.set({ readingAloud: false });
    if (this.phase === "speaking") this.setPhase(this.inConversation ? "thinking" : "idle");
  }

  /** Stop the assistant and hand the turn back to the user. */
  interrupt(reason = "button"): void {
    this.stopSpeaking(`interrupt:${reason}`);
    this.handlers.onInterrupt?.();
    if (this.inConversation) this.listen();
    else this.setPhase("idle");
  }

  protected enqueue(raw: string): void {
    const text = toSpeakable(raw);
    if (!text || !/[a-z0-9]/i.test(text)) return;
    this.queue.push({ text, audio: null });
    this.prefetch();
    if (!this.playing) this.playNext(this.generation);
  }

  /** Synthesise one sentence on the API; null means "use the browser voice instead". */
  protected fetchAudio(text: string): Promise<AudioBuffer | null> {
    if (this.serverTtsFailures >= 2) return Promise.resolve(null);
    const gen = this.generation;
    const shared = this.abort || (this.abort = new AbortController());
    return (async () => {
      // per-request timeout so a stalled TTS request can never freeze the conversation
      const own = new AbortController();
      const onShared = () => own.abort();
      shared.signal.addEventListener("abort", onShared);
      const timeout = setTimeout(() => own.abort(), TTS_TIMEOUT_MS);
      const started = performance.now();
      try {
        const ctx = await this.ensureAudioContext();
        const blob = await synthesizeSpeech(text, own.signal, this.ttsVoice);
        const buf = await blob.arrayBuffer();
        if (gen !== this.generation) return null;
        const decoded = await ctx.decodeAudioData(buf);
        this.serverTtsFailures = 0;
        vlog("tts-ready", { ms: Math.round(performance.now() - started), chars: text.length });
        return decoded;
      } catch (err: any) {
        if (shared.signal.aborted) return null; // stopped on purpose
        this.serverTtsFailures++;
        const timedOut = err?.name === "AbortError";
        vlog("tts-failed", { timedOut, error: String(err?.message || err).slice(0, 120) });
        return null;
      } finally {
        clearTimeout(timeout);
        shared.signal.removeEventListener("abort", onShared);
      }
    })();
  }

  /**
   * Keep only the next couple of sentences in flight. Firing every sentence at once makes them
   * compete on the TTS server and delays the first one by several seconds.
   */
  protected prefetch(): void {
    for (const item of this.queue.slice(0, TTS_PREFETCH)) {
      if (!item.audio) item.audio = this.fetchAudio(item.text);
    }
  }

  protected markAudible() {
    if (!this.audible) {
      this.audible = true;
      this.audibleSince = performance.now();
      this.bargeInVoicedMs = 0;
      this.echoEnvelope = 0;
    }
    // "speaking" only once sound is actually coming out - not while waiting for the first audio
    this.setPhase("speaking");
  }

  protected async playNext(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      this.audible = false;
      this.maybeFinishSpeaking();
      return;
    }
    if (!item.audio) item.audio = this.fetchAudio(item.text);
    this.prefetch();
    this.playing = true;
    const buffer = await item.audio;
    if (gen !== this.generation) return;

    if (buffer && this.ctx && this.outGain) {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume().catch(() => {});
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.outGain);
      this.currentSource = src;
      let finished = false;
      const onDone = () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (this.currentSource === src) this.currentSource = null;
        this.playNext(gen);
      };
      src.onended = onDone;
      const maxMs = Math.max(1000, buffer.duration * 1000 + 1200);
      const watchdog = setTimeout(onDone, maxMs);
      src.start();
      this.markAudible();
    } else {
      await this.speakWithBrowser(item.text, gen);
      this.playNext(gen);
    }
  }

  protected speakWithBrowser(text: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
      if (!synth || gen !== this.generation) return resolve();
      // Outside cloud mode only on-device voices may read answers aloud (remote voices send the text away)
      const voices = synth.getVoices().filter((v) => cloudSpeechAllowed() || v.localService);
      const voice = voices.find((v) => v.lang === DEFAULT_LOCALE) || voices.find((v) => v.lang.startsWith("en")) || null;
      if (!voice && !cloudSpeechAllowed()) {
        vlog("tts-browser-skipped", { reason: "no-on-device-voice" });
        return resolve();
      }
      const utter = new SpeechSynthesisUtterance(text);
      if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") (window as any).__aetherUtterance = utter;
      utter.voice = voice;
      utter.rate = 1.03;
      let doneCalled = false;
      const done = () => {
        if (doneCalled) return;
        doneCalled = true;
        clearTimeout(watchdog);
        this.syntheticLevelUntil = 0;
        resolve();
      };
      const maxMs = Math.max(2000, text.length * 90 + 2500);
      const watchdog = setTimeout(done, maxMs);

      utter.onstart = () => {
        this.syntheticLevelUntil = performance.now() + 60000;
        if (gen === this.generation) this.markAudible();
      };
      utter.onend = done;
      utter.onerror = done;
      vlog("tts-browser-voice", { chars: text.length });
      synth.speak(utter);
    });
  }

  protected maybeFinishSpeaking(): void {
    if (this.playing || this.queue.length || this.responseOpen) return;
    this.audible = false;
    this.currentSource = null;
    voiceStore.set({ readingAloud: false });
    this.listenStandby();
  }

  /** The answer failed; say so briefly and go back to listening. */
  failResponse(message: string): void {
    this.responseOpen = false;
    if (!this.inConversation) return;
    this.say(message);
  }
}
