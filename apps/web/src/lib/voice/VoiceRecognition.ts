/** Browser speech recogniser (wake word, live words) and utterance recorder (split from VoiceEngine.ts, Audit I-22). */
import { voiceStore } from "./voiceStore";
import { vlog } from "./voiceLog";
import { matchWakeWord, playWakeChime, stripWakeWord } from "./wakeWord";
import { SpeechRecognitionCtor, getRecognitionCtor } from "./voiceConfig";
import { VoiceEngineCore } from "./VoiceEngineCore";

export abstract class VoiceRecognition extends VoiceEngineCore {
  protected startRecognition(Ctor: SpeechRecognitionCtor): void {
    if (this.recognition) {
      try {
        const old = this.recognition;
        this.recognition = null;
        old.abort();
      } catch {}
    }
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      rec.maxAlternatives = 1;
      rec.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            if (this.standby && !this.inConversation) {
              // In standby mode, keep only the latest speech segment
              this.finalText = piece.trim();
            } else {
              this.finalText = `${this.finalText} ${piece}`.trim();
            }
          } else {
            interim += piece;
          }
        }
        this.interimText = interim.trim();
        this.lastResultAt = performance.now();
        const full = `${this.finalText} ${this.interimText}`.trim();

        if (full) {
          console.log("[Aether Voice Heard]:", full);
        }

        // 1. Passive Standby Mode: Looking for wake word ("Hey Aether", "Hey e", "he ET", "Hi", etc.)
        if (this.standby && !this.inConversation) {
          const match = matchWakeWord(full).matched
            ? matchWakeWord(full)
            : matchWakeWord(this.interimText);
          if (match.matched) {
            console.log("[Aether Wake Word Activated!]:", match.wakePhrase, match.query ? `(query: ${match.query})` : "");
            vlog("wake-word-detected", { phrase: match.wakePhrase, query: match.query });

            // Activate immediately!
            this.standby = false;
            this.wakeWordTriggered = true;
            this.setPhase("listening");
            voiceStore.set({ wakeWordDetected: true, conversation: true, standby: false, phase: "listening", error: null });

            // Play the activation chime
            this.ensureAudioContext()
              .then((ctx) => playWakeChime(ctx))
              .catch(() => {});

            // Prepare recorder and audio analysis
            this.ensureMic().then(() => this.startRecorder()).catch(() => {});

            if (this.wakeWordTimeout) clearTimeout(this.wakeWordTimeout);
            this.wakeWordTimeout = setTimeout(() => {
              voiceStore.set({ wakeWordDetected: false });
            }, 2500);

            // If user already included their query with the wake word:
            if (match.query && match.query.length >= 2) {
              voiceStore.set({ interim: match.query });
              this.stopListening(true);
              this.deliver(match.query, this.generation);
              return;
            }

            // User said wake word alone ("Hey Aether" or "Hi Aether"):
            // Reset transcript buffers so upcoming query is clean, but KEEP recognition active!
            this.finalText = "";
            this.interimText = "";
            this.lastResultAt = performance.now();
            this.listenStartedAt = performance.now();
            this.heardSpeech = false;
            return;
          }
          return;
        }

        // 2. While Speaking: Allow user to interrupt using wake word or greeting
        if (this.phase === "speaking") {
          const match = matchWakeWord(full).matched
            ? matchWakeWord(full)
            : matchWakeWord(this.interimText);
          if (match.matched) {
            console.log("[Aether Interrupted by Wake Word!]:", match.wakePhrase, match.query ? `(query: ${match.query})` : "");
            this.interrupt("wake-word");
            this.ensureAudioContext().then((ctx) => playWakeChime(ctx)).catch(() => {});
            this.finalText = "";
            this.interimText = "";
            this.lastResultAt = performance.now();
            this.listenStartedAt = performance.now();
            this.heardSpeech = false;
            if (match.query && match.query.length >= 2) {
              voiceStore.set({ interim: match.query });
              this.stopListening(true);
              this.deliver(match.query, this.generation);
            }
            return;
          }
        }

        // 3. Active Mode: Clean any wake word prefix so the query to the AI is pure
        const clean = stripWakeWord(full);
        voiceStore.set({ interim: clean });
      };
      rec.onerror = (e: any) => {
        if (e.error === "no-speech" || e.error === "aborted") return;
        vlog("recogniser-error", { error: e.error });
        console.warn("[Aether Voice] Speech recognition error:", e.error);

        if (this.recognition === rec) {
          this.recognition = null;
        }

        // In standby, wake-word mode, or active conversation, auto-recover from transient errors!
        if (this.standby || voiceStore.get().wakeWordEnabled || this.inConversation) {
          setTimeout(() => {
            if ((this.standby || this.phase === "listening") && !this.finishing && !this.recognition) {
              const Ctor = getRecognitionCtor();
              if (Ctor) this.startRecognition(Ctor);
            }
          }, 500);
          return;
        }

        this.recognitionFailed = true;
        voiceStore.set({ sttEngine: "server" });
      };
      rec.onend = () => {
        // Clear instance reference as this instance has ended
        if (this.recognition === rec) {
          this.recognition = null;
        }
        // In Chrome, Web Speech terminates after ~30-60s of silence or utterance end.
        // Always instantiate a FRESH recognizer instance rather than calling start() on an ended instance!
        if ((this.phase === "listening" || this.standby) && !this.finishing) {
          setTimeout(() => {
            if ((this.phase === "listening" || this.standby) && !this.finishing && !this.recognition) {
              const Ctor = getRecognitionCtor();
              if (Ctor) this.startRecognition(Ctor);
            }
          }, 150);
        }
      };
      rec.start();
      this.recognition = rec;
    } catch (err) {
      vlog("recogniser-error", { error: String(err).slice(0, 120) });
      console.warn("[Aether Voice] Recognition start error:", err);
      this.recognition = null;
      if (this.standby || this.phase === "listening") {
        setTimeout(() => {
          if ((this.standby || this.phase === "listening") && !this.recognition && !this.finishing) {
            const C = getRecognitionCtor();
            if (C) this.startRecognition(C);
          }
        }, 1000);
      }
    }
  }

  protected startRecorder(): void {
    if (!this.stream) return;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find(
      (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)
    );
    try {
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      vlog("recorder-error", { error: String(err).slice(0, 120) });
      voiceStore.set({ error: `Recording is not supported in this browser: ${err}` });
      return;
    }
    this.recordedChunks = [];
    this.recorder.ondataavailable = (e) => e.data.size > 0 && this.recordedChunks.push(e.data);
    this.recorder.start(250);
  }

}
