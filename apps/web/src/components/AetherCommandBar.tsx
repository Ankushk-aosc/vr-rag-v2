"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Mic, Square, Send, Loader2, Sparkles, ArrowUpRight } from "lucide-react";

export interface AetherCommandBarProps {
  onSendMessage: (text: string) => void;
  onAudioCaptured: (audioBlob: Blob) => void;
  isProcessing: boolean;
  statusText?: string;
  hasMessages: boolean;
  onToggleDialogue: () => void;
  isDialogueOpen: boolean;
  theme?: "dark" | "light";
  prompts?: string[];
  onListeningStateChange?: (isListening: boolean, audioLevels: number[]) => void;
}

export function AetherCommandBar({
  onSendMessage,
  onAudioCaptured,
  isProcessing,
  statusText,
  hasMessages,
  onToggleDialogue,
  isDialogueOpen,
  theme = "light",
  prompts,
  onListeningStateChange,
}: AetherCommandBarProps) {
  const [inputText, setInputText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevels, setAudioLevels] = useState<number[]>([15, 20, 30, 25, 18]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const accumulatedTranscriptRef = useRef<string>("");
  const listeningCallbackRef = useRef(onListeningStateChange);

  useEffect(() => {
    listeningCallbackRef.current = onListeningStateChange;
  }, [onListeningStateChange]);

  const isLight = theme === "light";

  const quickPrompts =
    prompts && prompts.length > 0
      ? prompts
      : [
          "AAPL closing price & volume on 2020-04-01",
          "Historical trading volume & daily returns in AAPL data",
          "Summary of AAPL records across 11,558 rows",
        ];

  // Clean up audio & speech recognition
  const cleanupAudio = useCallback(() => {
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.abort();
      } catch {}
      speechRecognitionRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
    setRecordingSeconds(0);
    setAudioLevels([15, 20, 30, 25, 18]);
    listeningCallbackRef.current?.(false, [0, 0, 0, 0, 0]);
  }, []);

  // Real-time audio waveform analyzer
  const startAudioAnalysis = (stream: MediaStream) => {
    try {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtxClass();
      audioCtxRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.7;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let lastParentNotifyTime = 0;

      const updateLevels = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(dataArray);

        const rawBands = [
          dataArray[1] || 0,
          dataArray[3] || 0,
          dataArray[6] || 0,
          dataArray[10] || 0,
          dataArray[14] || 0,
        ];

        const normalized = rawBands.map((val) => {
          const pct = Math.round((val / 255) * 85) + 15;
          return Math.max(15, Math.min(100, pct));
        });

        setAudioLevels(normalized);

        // Throttle parent notification to ~16 updates/sec (every 60ms) to prevent render flooding
        const now = performance.now();
        if (now - lastParentNotifyTime > 60) {
          lastParentNotifyTime = now;
          listeningCallbackRef.current?.(true, normalized);
        }
        animFrameRef.current = requestAnimationFrame(updateLevels);
      };

      updateLevels();
    } catch (e) {
      console.warn("AudioContext analyzer fallback:", e);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      let selectedMime = "audio/webm";
      if (typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function") {
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          selectedMime = "audio/webm;codecs=opus";
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          selectedMime = "audio/webm";
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          selectedMime = "audio/mp4";
        } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
          selectedMime = "audio/ogg";
        } else {
          selectedMime = "";
        }
      }

      const options = selectedMime ? { mimeType: selectedMime } : undefined;
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: selectedMime || "audio/webm",
        });
        const recognizedText = (accumulatedTranscriptRef.current || inputText).trim();

        // 1. If Web Speech API captured text in-browser, submit immediately with zero latency!
        if (recognizedText) {
          onSendMessage(recognizedText);
          setInputText("");
        } else if (audioBlob.size >= 500) {
          // 2. Otherwise fallback to server-side audio transcription
          onAudioCaptured(audioBlob);
        }

        cleanupAudio();
      };

      mediaRecorder.start(200);
      setIsRecording(true);
      setRecordingSeconds(0);

      // Start timer immediately and reliably
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);

      listeningCallbackRef.current?.(true, [20, 25, 30, 25, 20]);
      startAudioAnalysis(stream);

      // Initialize Web Speech API for real-time speech transcription
      accumulatedTranscriptRef.current = "";
      const SpeechRecognitionClass =
        typeof window !== "undefined"
          ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
          : null;

      if (SpeechRecognitionClass) {
        try {
          const recognition = new SpeechRecognitionClass();
          speechRecognitionRef.current = recognition;
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = "en-AU";

          recognition.onresult = (event: any) => {
            let currentInterim = "";
            let currentFinal = "";
            for (let i = event.resultIndex; i < event.results.length; ++i) {
              const transcriptPart = event.results[i][0].transcript;
              if (event.results[i].isFinal) {
                currentFinal += transcriptPart;
              } else {
                currentInterim += transcriptPart;
              }
            }
            if (currentFinal) {
              accumulatedTranscriptRef.current =
                (accumulatedTranscriptRef.current ? accumulatedTranscriptRef.current + " " : "") + currentFinal.trim();
            }
            const liveDisplay = (
              accumulatedTranscriptRef.current + (currentInterim ? " " + currentInterim : "")
            ).trim();
            if (liveDisplay) {
              setInputText(liveDisplay);
            }
          };

          recognition.onerror = (e: any) => {
            console.warn("SpeechRecognition notice:", e.error);
          };

          recognition.start();
        } catch (e) {
          console.warn("SpeechRecognition fallback:", e);
        }
      }
    } catch (err) {
      console.error("Microphone access error:", err);
      alert("Microphone permission denied or unsupported.");
      cleanupAudio();
    }
  };

  const stopRecording = () => {
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.stop();
      } catch {}
      speechRecognitionRef.current = null;
    }

    if (mediaRecorderRef.current && isRecording) {
      try {
        if (mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.requestData();
        }
      } catch (e) {
        console.warn("MediaRecorder requestData flush:", e);
      }
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isProcessing) return;
    onSendMessage(inputText.trim());
    setInputText("");
  };

  const handleSelectPrompt = (prompt: string) => {
    setInputText(prompt);
    inputRef.current?.focus();
  };

  const cleanupRef = useRef(cleanupAudio);
  useEffect(() => {
    cleanupRef.current = cleanupAudio;
  });

  useEffect(() => {
    return () => {
      cleanupRef.current();
    };
  }, []);

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-4 flex flex-col items-center">
      {/* Quick Prompts Floating Above Capsule */}
      {!isRecording && !hasMessages && (
        <div className="flex flex-wrap items-center justify-center gap-2 mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {quickPrompts.map((prompt, idx) => (
            <button
              key={idx}
              onClick={() => handleSelectPrompt(prompt)}
              className={`text-[11px] px-3.5 py-1.5 rounded-full border backdrop-blur-xl transition-all shadow-md flex items-center space-x-1.5 ${
                isLight
                  ? "bg-white/80 hover:bg-white text-black/75 hover:text-black border-black/10"
                  : "bg-black/60 hover:bg-[#1C1C24] text-white/70 hover:text-white border-white/10"
              }`}
            >
              <span>{prompt}</span>
              <ArrowUpRight className={`w-3 h-3 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
            </button>
          ))}
        </div>
      )}

      {/* Floating Aether Sovereign Command Capsule */}
      <div className="relative w-full group">
        {/* Ambient Royal Purple Aether Glow when active */}
        <div
          className={`absolute -inset-1 rounded-full blur-xl transition-all duration-700 pointer-events-none ${
            isRecording
              ? "opacity-90 aether-wave-gradient scale-105"
              : isProcessing
              ? "opacity-80 bg-gradient-to-r from-[#6D28D9] via-[#8B5CF6] to-[#D4AF37] animate-pulse"
              : "opacity-0 group-hover:opacity-25 bg-[#7C3AED]"
          }`}
        />

        {/* Liquid Frosted Glass Command Capsule */}
        <div
          className={`relative z-10 w-full flex items-center justify-between px-3.5 py-2.5 rounded-full border transition-all duration-300 backdrop-blur-2xl ${
            isRecording
              ? isLight
                ? "bg-white/95 border-[#7C3AED]/40 shadow-xl"
                : "bg-[#0A0A0E]/95 border-white/25 shadow-[0_0_35px_rgba(124,58,237,0.35)]"
              : isProcessing
              ? isLight
                ? "bg-white/90 border-[#6D28D9]/40"
                : "bg-[#101014]/90 border-[#7C3AED]/40 shadow-xl"
              : isLight
              ? "bg-white/85 hover:bg-white/95 border-black/10 shadow-lg text-black"
              : "bg-[#141418]/80 hover:bg-[#1A1A22]/90 border-white/15 shadow-2xl text-white"
          }`}
        >
          {/* Left: Fluid Mic Button */}
          <button
            type="button"
            onClick={toggleRecording}
            disabled={isProcessing}
            aria-label={isRecording ? "Stop voice recording" : "Speak voice query"}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300 flex-shrink-0 ${
              isRecording
                ? "bg-red-500/20 text-red-500 border border-red-500/60 scale-105"
                : isProcessing
                ? "bg-[#7C3AED]/20 text-[#7C3AED] border border-[#7C3AED]/40"
                : isLight
                ? "bg-[#6D28D9]/10 hover:bg-[#6D28D9]/20 text-[#6D28D9] border border-[#6D28D9]/20 hover:scale-105 active:scale-95"
                : "bg-white/10 hover:bg-white/15 text-white border border-white/10 hover:scale-105 active:scale-95"
            }`}
          >
            {isProcessing ? (
              <Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />
            ) : isRecording ? (
              <Square className="w-3.5 h-3.5 fill-current" />
            ) : (
              <Mic className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
            )}
          </button>

          {/* Center: Real-time Audio Wave Ribbon OR Borderless Input Field */}
          {isRecording ? (
            <div className="flex-1 flex items-center justify-between px-3 overflow-hidden">
              <div className="flex items-center space-x-2 truncate mr-2">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping flex-shrink-0" />
                <span className={`text-xs font-medium tracking-tight ${isLight ? "text-black/70" : "text-white/70"}`}>
                  ({formatTimer(recordingSeconds)})
                </span>
                {inputText ? (
                  <span className={`text-xs font-semibold truncate ${isLight ? "text-purple-700" : "text-violet-300"}`}>
                    &ldquo;{inputText}&rdquo;
                  </span>
                ) : (
                  <span className={`text-[11px] hidden sm:inline ${isLight ? "text-black/50" : "text-white/50"}`}>
                    Listening • Speak financial inquiry...
                  </span>
                )}
              </div>

              {/* Real-time Dynamic Waveform Bars */}
              <div
                className={`flex items-center space-x-1 h-6 px-2 rounded-full border ${
                  isLight ? "bg-black/5 border-black/10" : "bg-black/50 border-white/10"
                }`}
              >
                {audioLevels.map((lvl, idx) => (
                  <span
                    key={idx}
                    className="w-1 rounded-full aether-wave-gradient transition-all duration-75"
                    style={{
                      height: `${lvl}%`,
                      minHeight: "4px",
                      opacity: 0.75 + (lvl / 100) * 0.25,
                    }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex-1 flex items-center px-3">
              <input
                ref={inputRef}
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                disabled={isProcessing}
                placeholder="Ask about AAPL equities, metrics, or financial data..."
                className={`w-full bg-transparent text-xs sm:text-sm focus:outline-none ${
                  isLight ? "text-black placeholder-black/40" : "text-white placeholder-white/40"
                }`}
              />
            </form>
          )}

          {/* Right: Submit Button OR Processing Status Indicator */}
          <div className="flex items-center space-x-2 flex-shrink-0">
            {isRecording ? (
              <button
                type="button"
                onClick={stopRecording}
                className="px-3.5 py-1.5 rounded-full bg-red-500/20 hover:bg-red-500/30 text-red-500 border border-red-500/40 text-xs font-semibold tracking-tight transition-all"
              >
                Done
              </button>
            ) : isProcessing ? (
              <div
                className={`flex items-center space-x-1.5 px-3 py-1 rounded-full border text-[11px] ${
                  isLight
                    ? "bg-[#6D28D9]/10 border-[#6D28D9]/20 text-[#6D28D9]"
                    : "bg-[#7C3AED]/15 border-[#7C3AED]/30 text-[#A78BFA]"
                }`}
              >
                <Sparkles className="w-3 h-3 animate-spin" />
                <span className="hidden sm:inline">Synthesizing...</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!inputText.trim()}
                aria-label="Submit inquiry"
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-all active:scale-95 shadow-md ${
                  isLight
                    ? "bg-[#581C87] text-white hover:bg-[#4C1D95] disabled:opacity-30 disabled:bg-black/10 disabled:text-black/30"
                    : "bg-white text-black hover:bg-white/90 disabled:opacity-30 disabled:bg-white/20 disabled:text-white/40"
                }`}
              >
                <Send className="w-4 h-4" />
              </button>
            )}

            {/* Conversation Toggle Pill if messages exist */}
            {hasMessages && (
              <button
                type="button"
                onClick={onToggleDialogue}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  isDialogueOpen
                    ? isLight
                      ? "bg-[#6D28D9]/15 text-[#6D28D9] border-[#6D28D9]/30"
                      : "bg-[#7C3AED]/20 text-[#A78BFA] border-[#7C3AED]/40"
                    : isLight
                    ? "bg-black/5 hover:bg-black/10 text-black/80 border-black/10"
                    : "bg-white/5 hover:bg-white/10 text-white/80 border-white/10"
                }`}
              >
                {isDialogueOpen ? "Hide" : "Show"} Dialogue
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
