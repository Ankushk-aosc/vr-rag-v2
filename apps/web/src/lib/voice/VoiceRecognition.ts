/** Browser speech recogniser (wake word, live words) and utterance recorder (split from VoiceEngine.ts, Audit I-22). */
import { voiceStore } from "./voiceStore";
import { vlog } from "./voiceLog";
import { matchWakeWord, playWakeChime, stripWakeWord } from "./wakeWord";
import { SpeechRecognitionCtor, getRecognitionCtor, DEFAULT_LOCALE } from "./voiceConfig";
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
      rec.lang = (typeof navigator !== "undefined" && navigator.language) || DEFAULT_LOCALE;
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
        }

        // 1. Passive Standby Mode: Looking for wake word ("Hey Aether", "Hey e", "he ET", "Hi", etc.)
        if (this.standby && !this.inConversation) {
          const match = matchWakeWord(full).matched
            ? matchWakeWord(full)
            : matchWakeWord(this.interimText);
          if (match.matched) {
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
        const errType = (e && e.error) || "unknown";
        if (errType === "aborted") return;
        if (errType === "no-speech") {
          // In standby or active listening with no speech yet, let VAD continue
          return;
        }

        vlog("recogniser-error", { error: errType });
        console.warn("[Aether Voice] Speech recognition error:", errType);

        if (this.recognition === rec) {
          try {
            rec.abort();
          } catch {}
          this.recognition = null;
        }

        // Handle not-allowed, network, audio-capture, service-not-allowed, unknown by falling back to Whisper
        this.recognitionFailed = true;
        voiceStore.set({
          sttEngine: "server",
          statusText: "Browser recognition unavailable. Switching to Whisper…",
        });

        if (this.standby && !this.inConversation) {
          this.standby = false;
          voiceStore.set({ standby: false, phase: "idle" });
        }
      };
      rec.onend = () => {
        // Clear instance reference as this instance has ended
        if (this.recognition === rec) {
          this.recognition = null;
        }
        // In Chrome, Web Speech terminates after ~30-60s of silence or utterance end.
        // Always instantiate a FRESH recognizer instance rather than calling start() on an ended instance!
        if ((this.phase === "listening" || this.standby) && !this.finishing && !this.recognitionFailed) {
          setTimeout(() => {
            if ((this.phase === "listening" || this.standby) && !this.finishing && !this.recognition && !this.recognitionFailed) {
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


  override setBrowserSpeechOptIn(optIn: boolean) {
    super.setBrowserSpeechOptIn(optIn);
    if (!optIn) {
      if (this.recognition) {
        try {
          const old = this.recognition;
          this.recognition = null;
          old.abort();
        } catch {}
      }
      voiceStore.set({ sttEngine: "server" });
    } else {
      const Ctor = getRecognitionCtor();
      if (Ctor && (this.standby || this.phase === "listening") && !this.recognition) {
        this.startRecognition(Ctor);
        voiceStore.set({ sttEngine: "browser" });
      }
    }
  }

  override setSttMode(mode: "auto" | "server") {
    super.setSttMode(mode);
    if (mode === "server") {
      if (this.recognition) {
        try {
          const old = this.recognition;
          this.recognition = null;
          old.abort();
        } catch {}
      }
      voiceStore.set({ sttEngine: "server" });
    } else {
      const Ctor = getRecognitionCtor();
      if (Ctor && (this.standby || this.phase === "listening") && !this.recognition) {
        this.startRecognition(Ctor);
        voiceStore.set({ sttEngine: "browser" });
      }
    }
  }
}
