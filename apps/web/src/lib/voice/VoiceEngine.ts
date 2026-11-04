/**
 * Hands-free voice conversation engine (ChatGPT / Claude voice-mode style turn taking):
 *
 *   listening ──(user stops talking)──▶ transcribing ──▶ thinking
 *       ▲                                                   │ answer tokens stream in
 *       └────(playback finished, mic re-opens)── speaking ◀─┘ (sentence-by-sentence TTS)
 *
 * Speech-to-text: the utterance is always recorded. The browser's SpeechRecognition supplies live
 * words (Chrome / Edge / Android); if it returns nothing - it often fails silently when Google's
 * service is blocked or unreachable - the recording is transcribed by Whisper on the API.
 * Text-to-speech: the API's voice, falling back to the browser's speechSynthesis.
 *
 * Privacy (Audit I-26): Chrome's SpeechRecognition streams microphone audio to Google, and some
 * speechSynthesis voices are cloud voices. Unless the API reports PRIVACY_MODE=cloud, browser
 * recognition (live words, wake word, standby) is never started and only on-device browser voices
 * (`localService`) are used, so every utterance goes only to the deployment's own Whisper.
 * Barge-in (optional): talking over the assistant stops it - only while its audio is actually
 * playing, and only when the mic level clearly exceeds the assistant's own echo.
 *
 * The audio loop runs on setInterval, not requestAnimationFrame, because window rAF stops firing
 * during immersive WebXR sessions and in background tabs.
 */
import { transcribeAudio } from "../api";
import { describeTranscribeError } from "./dictation";
import { rmsOf } from "../vad";
import { canUseBrowserSpeech, liveLevels, voiceStore } from "./voiceStore";
import { vlog } from "./voiceLog";
import { BARGE_IN_GRACE_MS, BARGE_IN_HOLD_MS, BARGE_IN_MIN_RMS, MAX_UTTERANCE_MS, NO_SPEECH_RESTART_MS, RECOGNISER_QUIET_MS, TICK_MS, getRecognitionCtor } from "./voiceConfig";
import { matchWakeWord, stripWakeWord } from "./wakeWord";
import { VoiceRecognition } from "./VoiceRecognition";

// The class is split across files to stay under the size limit (Audit I-22): VoiceEngineCore (state, settings,
// audio plumbing, speech output) <- VoiceRecognition (recogniser, recorder) <- VoiceEngine (turn taking).
export type { VoiceEngineHandlers } from "./VoiceEngineCore";

export class VoiceEngine extends VoiceRecognition {
  // ------------------------------------------------------------------ lifecycle

  /**
   * Always-on standby microphone mode.
   * Keeps the mic open and listens passively for the wake word ("Hey Aether", "Hi Aether", etc.).
   * Activates only when called by name.
   */
  async startStandby(): Promise<void> {
    if (this.inConversation) return;
    // The wake word needs the browser recogniser, which the user must have opted into; without it
    // standby would hold the mic open for nothing. Standby never starts unless both are switched on.
    if (!this.wakeWordEnabled || !canUseBrowserSpeech()) {
      vlog("standby-skipped", { reason: "not-opted-in", privacyMode: voiceStore.get().privacyMode });
      return;
    }
    vlog("standby-start", { sttMode: voiceStore.get().sttMode });
    this.standby = true;
    this.recognitionFailed = false;
    voiceStore.set({ standby: true, phase: "idle", error: null });

    // 1. Immediately start passive SpeechRecognition in standby mode
    this.listenStandby();

    // 2. Also prepare microphone stream & AudioContext if browser already granted permission
    try {
      await this.ensureMic();
      this.detectHeadphones();
    } catch (err: any) {
      vlog("standby-audio-deferred", { message: String(err?.message || err).slice(0, 160) });
    }
  }

  /** Unlock suspended AudioContext upon user gesture. */
  async unlockAudio(): Promise<void> {
    try {
      if (this.ctx && this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
    } catch {}
  }

  /** Start a hands-free conversation immediately (e.g. user clicked mic / tapped orb). */
  async startConversation(): Promise<void> {
    if (this.inConversation) return;
    this.standby = false;
    this.recognitionFailed = false;
    this.setPhase("listening");
    voiceStore.set({ conversation: true, standby: false, phase: "listening", error: null, interim: "" });
    vlog("conversation-start", { sttMode: voiceStore.get().sttMode, hasRecognition: !!getRecognitionCtor() });
    try {
      await this.ensureMic();
      this.detectHeadphones();
      this.listen();
    } catch (err: any) {
      const msg =
        err?.name === "NotAllowedError"
          ? "Microphone permission was denied. Click the camera/mic icon in the address bar and allow the microphone."
          : err?.name === "NotFoundError"
          ? "No microphone was found. Plug one in or check your system sound settings."
          : `Microphone unavailable: ${err?.message || err}`;
      vlog("mic-error", { name: err?.name, message: String(err?.message || err).slice(0, 160) });
      voiceStore.set({ error: msg });
      this.endConversation("mic-error", true);
    }
  }

  /**
   * Called when user awakened Aether by name ("Hey Aether" or "Hi Aether") without an inline query.
   * Transitions immediately to active listening.
   */
  startConversationFromWake(): void {
    this.standby = false;
    this.recognitionFailed = false;
    this.setPhase("listening");
    voiceStore.set({ conversation: true, standby: false, phase: "listening", interim: "", error: null });
    this.ensureMic()
      .then(() => {
        this.listen();
      })
      .catch((err) => {
        console.warn("[Aether Voice] Mic error on wake:", err);
      });
  }

  /**
   * Stop active conversation. If wake-word is enabled, seamlessly returns to standby
   * always-on listening rather than completely closing the mic stream.
   */
  endConversation(reason = "user", forceStop = false): void {
    if (this.inConversation) vlog("conversation-end", { reason });
    if (this.wakeWordTimeout) {
      clearTimeout(this.wakeWordTimeout);
      this.wakeWordTimeout = null;
    }
    voiceStore.set({ conversation: false, interim: "", wakeWordDetected: false });
    this.stopListening(true);
    this.stopSpeaking("conversation-end");

    if (this.wakeWordEnabled && canUseBrowserSpeech() && !forceStop) {
      this.listenStandby();
      return;
    }

    this.standby = false;
    voiceStore.set({ standby: false, phase: "idle" });
    this.releaseMic();
    this.stopTickingIfIdle();
  }

  toggleConversation(): Promise<void> | void {
    if (this.inConversation) {
      return this.endConversation("toggle");
    }
    return this.startConversation();
  }

  dispose(): void {
    if (this.wakeWordTimeout) clearTimeout(this.wakeWordTimeout);
    this.endConversation("dispose", true);
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  // ------------------------------------------------------------------ audio loop

  protected tick(): void {
    const now = performance.now();
    const phase = this.phase;

    // Output level for the orb while the assistant speaks
    let outRms = 0;
    if (this.outAnalyser && this.currentSource) {
      this.outAnalyser.getFloatTimeDomainData(this.outBuffer);
      outRms = rmsOf(this.outBuffer);
      const target = Math.min(1, outRms / 0.16);
      liveLevels.output += (target - liveLevels.output) * (target > liveLevels.output ? 0.6 : 0.2);
    } else if (now < this.syntheticLevelUntil) {
      liveLevels.output = 0.35 + 0.3 * Math.abs(Math.sin(now / 90)) * Math.abs(Math.sin(now / 370));
    } else {
      liveLevels.output *= 0.8;
    }

    if (process.env.NODE_ENV !== "production") {
      (window as any).__voiceOut = liveLevels.output;
      if (!this.micAnalyser) (window as any).__voiceDebug = { phase, playing: this.playing, queued: this.queue.length };
    }
    if (!this.micAnalyser) return;
    this.micAnalyser.getFloatTimeDomainData(this.micBuffer);
    const rms = rmsOf(this.micBuffer);
    const frame = this.vad.update(rms, now);
    liveLevels.mic = phase === "listening" ? frame.level : liveLevels.mic * 0.8;
    if (process.env.NODE_ENV !== "production") {
      (window as any).__voiceDebug = {
        phase,
        rms: +rms.toFixed(4),
        floor: +this.vad.noiseFloor.toFixed(4),
        start: +this.vad.startThreshold.toFixed(4),
        voiced: frame.voiced,
        inUtterance: frame.inUtterance,
        ctx: this.ctx?.state,
        recognition: !!this.recognition,
        recorder: this.recorder?.state,
        words: `${this.finalText} ${this.interimText}`.trim(),
        echo: +this.echoEnvelope.toFixed(3),
      };
    }

    // Standby watchdog: If in standby mode and recognition died for any reason, re-start it!
    if (this.standby && !this.inConversation && !this.finishing && !this.recognition) {
      if (!this.lastStandbyCheck || now - this.lastStandbyCheck > 2000) {
        this.lastStandbyCheck = now;
        const Ctor = getRecognitionCtor();
        if (Ctor) this.startRecognition(Ctor);
      }
    }
    // In standby mode, discard stale transcript fragments after 4 seconds of silence
    if (this.standby && !this.inConversation && (this.finalText || this.interimText) && this.lastResultAt && now - this.lastResultAt > 4000) {
      this.finalText = "";
      this.interimText = "";
    }

    const isListeningTurn = phase === "listening" && !this.finishing;
    if (isListeningTurn) {
      if (frame.inUtterance) this.heardSpeech = true;
      const sinceListen = now - this.listenStartedAt;
      const haveWords = (this.finalText + this.interimText).trim().length > 0;
      const resultQuiet = this.lastResultAt ? now - this.lastResultAt : Infinity;
      // the recogniser's words can lag the audio; while a phrase is still "interim" wait a bit longer
      const pendingInterim = this.interimText.length > 0 && resultQuiet < 700;

      // 1. The VAD heard a complete utterance followed by silence - works for every STT backend.
      if (frame.endOfUtterance && !pendingInterim && (haveWords || this.heardSpeech)) {
        this.finishUtterance("vad-silence");
      }
      // 2. The recogniser has words and has been quiet for a while, even if the VAD still hears
      //    noise (fan, AGC-boosted room) - the recogniser is the better judge of speech.
      else if (haveWords && resultQuiet >= RECOGNISER_QUIET_MS && (!frame.voiced || resultQuiet >= 2600)) {
        this.finishUtterance("recogniser-quiet");
      }
      // 3. Safety limits.
      else if (sinceListen > MAX_UTTERANCE_MS && (haveWords || this.heardSpeech)) {
        this.finishUtterance("max-length");
      }
      else if (!this.heardSpeech && !haveWords && sinceListen > NO_SPEECH_RESTART_MS) {
        // Never loop silently: tell the user nothing was picked up, and how to send what was said
        voiceStore.set({ statusText: "No speech detected yet. Keep talking, or press Done speaking to send." });
        vlog("no-speech-restart", { ms: Math.round(sinceListen) });
        this.restartListening();
      }
    }

    // Barge-in: only while the assistant's (measurable) audio is playing, and only when the mic is
    // clearly louder than the assistant's own voice leaking back from the speakers.
    if (phase === "speaking" && this.audible && this.currentSource && voiceStore.get().bargeIn) {
      const sinceAudible = now - this.audibleSince;
      if (outRms > 0.005) {
        const ratio = rms / outRms;
        if (sinceAudible < BARGE_IN_GRACE_MS) {
          // learn how loud the echo gets while the user is (presumably) quiet
          this.echoEnvelope = Math.max(this.echoEnvelope, ratio);
        } else if (ratio < this.echoEnvelope * 1.3) {
          // keep following the echo envelope, decaying slowly
          this.echoEnvelope = Math.max(ratio, this.echoEnvelope * 0.999);
        }
      }
      if (sinceAudible > BARGE_IN_GRACE_MS) {
        const threshold = Math.max(BARGE_IN_MIN_RMS, this.vad.noiseFloor * 6, this.echoEnvelope * outRms * 2);
        const loud = rms > threshold;
        this.bargeInVoicedMs = loud ? this.bargeInVoicedMs + TICK_MS : Math.max(0, this.bargeInVoicedMs - TICK_MS);
        if (this.bargeInVoicedMs >= BARGE_IN_HOLD_MS) {
          vlog("barge-in", { rms: +rms.toFixed(3), threshold: +threshold.toFixed(3), outRms: +outRms.toFixed(3) });
          this.bargeInVoicedMs = 0;
          this.interrupt("barge-in");
        }
      }
    }
  }

  // ------------------------------------------------------------------ listening

  /**
   * Passive standby listening loop.
   * Keeps the mic open and runs speech recognition to detect the wake word.
   */
  listenStandby(): void {
    this.vad.reset();
    this.finalText = "";
    this.interimText = "";
    this.lastResultAt = 0;
    this.heardSpeech = false;
    this.finishing = false;
    this.wakeWordTriggered = false;
    this.standby = true;
    this.recognitionFailed = false;
    this.listenStartedAt = performance.now();
    this.setPhase("idle");
    voiceStore.set({ standby: true, conversation: false, interim: "", phase: "idle" });

    // Standby mode requires SpeechRecognition to detect the wake word.
    const Ctor = getRecognitionCtor();
    if (Ctor && !this.recognition) {
      this.startRecognition(Ctor);
    }
    voiceStore.set({ sttEngine: this.recognition ? "browser" : "server" });
  }

  protected listen(): void {
    if (!this.inConversation) return;
    this.standby = false;
    this.vad.reset();
    this.finalText = "";
    this.interimText = "";
    this.lastResultAt = 0;
    this.heardSpeech = false;
    this.finishing = false;
    this.wakeWordTriggered = false;
    this.listenStartedAt = performance.now();
    voiceStore.set({ interim: "", standby: false, statusText: "" });
    this.setPhase("listening");

    // Always record: if the browser recogniser returns nothing the recording goes to Whisper.
    this.startRecorder();
    const allowBrowser = voiceStore.get().sttMode === "auto" && !this.recognitionFailed;
    const Ctor = allowBrowser ? getRecognitionCtor() : null;
    if (Ctor && !this.recognition) this.startRecognition(Ctor);
    voiceStore.set({ sttEngine: this.recognition ? "browser" : "server" });
  }

  protected restartListening(): void {
    if (this.phase === "listening") this.listen();
  }

  protected stopListening(discard: boolean): void {
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try {
        discard ? rec.abort() : rec.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.recorder && discard) {
      const r = this.recorder;
      this.recorder = null;
      r.ondataavailable = null;
      try {
        if (r.state !== "inactive") r.stop();
      } catch {
        /* ignore */
      }
    }
  }

  /** Ends the user's turn immediately (also used by the "send now" button). */
  finishUtterance(reason = "button"): void {
    if ((this.phase !== "listening" && !this.standby) || this.finishing) return;
    this.finishing = true;
    const gen = this.generation;

    const rawText = `${this.finalText} ${this.interimText}`.trim();

    // Standby mode handling:
    if (this.standby && !this.inConversation) {
      const match = matchWakeWord(rawText);
      if (!match.matched && !this.wakeWordTriggered) {
        // Unrelated speech during standby without wake word:
        // Quietly reset and continue standby listening
        this.finishing = false;
        this.stopListening(true);
        this.listenStandby();
        return;
      }

      // Wake word detected!
      const query = match.matched ? match.query : stripWakeWord(rawText);
      if (query.length >= 2) {
        // User asked their query with the wake word: "Hey Aether, tell me about revenue"
        vlog("turn-end", { reason, stt: "browser-wake", text: query.slice(0, 80) });
        this.standby = false;
        voiceStore.set({ conversation: true, standby: false });
        this.stopListening(true);
        this.deliver(query, gen);
        return;
      } else {
        // User only called the name: "Hey Aether" or "Hi Aether"
        // Activate conversation and start listening for their question!
        vlog("wake-word-ready", { reason, wakePhrase: match.wakePhrase });
        this.standby = false;
        this.finishing = false;
        this.stopListening(true);
        this.startConversationFromWake();
        return;
      }
    }

    // Active conversation mode:
    const cleanText = stripWakeWord(rawText);
    if (cleanText) {
      vlog("turn-end", { reason, stt: "browser", text: cleanText.slice(0, 80) });
      this.stopListening(true);
      this.deliver(cleanText, gen);
      return;
    }
    if (this.recognition && this.heardSpeech) {
      vlog("recogniser-silent", { note: "speech heard but no words; transcribing turn with Whisper" });
    }
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }

    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder) {
      this.finishing = false;
      return this.listen();
    }
    vlog("turn-end", { reason, stt: "server" });
    this.setPhase("transcribing");
    voiceStore.set({ statusText: "Transcribing…" });
    const durationMs = Math.round(performance.now() - this.listenStartedAt);
    recorder.onstop = async () => {
      const blob = new Blob(this.recordedChunks, { type: recorder.mimeType || "audio/webm" });
      this.recordedChunks = [];
      // Safe diagnostics only: format, size and length. Never the audio or the words.
      vlog("recording", { mimeType: blob.type, bytes: blob.size, durationMs });
      if (blob.size < 1500) {
        voiceStore.set({ statusText: "That recording was too short to transcribe. Please speak again." });
        return this.deliver("", gen);
      }
      try {
        this.abort = new AbortController();
        const started = performance.now();
        const text = await transcribeAudio(blob, this.abort.signal);
        vlog("transcribed", { ms: Math.round(performance.now() - started), bytes: blob.size, chars: text.length });
        if (!text.trim()) voiceStore.set({ statusText: "No words were recognised. Please speak again." });
        this.deliver(text, gen);
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        vlog("transcribe-error", { status: err?.status ?? null });
        voiceStore.set({ error: describeTranscribeError(err) });
        this.deliver("", gen);
      }
    };
    try {
      recorder.stop();
    } catch {
      this.deliver("", gen);
    }
  }

  protected deliver(text: string, gen: number): void {
    if (gen !== this.generation || !this.inConversation) return;
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length < 2) {
      this.finishing = false;
      return this.listen(); // nothing intelligible - keep listening
    }
    voiceStore.set({ interim: clean, error: null, statusText: "" });
    this.setPhase("thinking");
    this.handlers.onUtterance(clean);
  }

}
