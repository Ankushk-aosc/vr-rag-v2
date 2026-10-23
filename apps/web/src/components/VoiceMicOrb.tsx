"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Mic, Square, Loader2, Sparkles, Volume2 } from "lucide-react";

interface VoiceMicOrbProps {
  onAudioCaptured: (audioBlob: Blob) => void;
  isProcessing: boolean;
  statusText?: string;
}

export function VoiceMicOrb({
  onAudioCaptured,
  isProcessing,
  statusText,
}: VoiceMicOrbProps) {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [audioLevels, setAudioLevels] = useState<number[]>([15, 20, 30, 25, 18]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up audio resources
  const cleanupAudio = useCallback(() => {
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
    setRecordingSeconds(0);
    setAudioLevels([15, 20, 30, 25, 18]);
  }, []);

  // Real-time audio waveform analyzer
  const startAudioAnalysis = (stream: MediaStream) => {
    try {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtxClass();
      audioCtxRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.7;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateLevels = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(dataArray);

        // Pick 5 representative bands for a balanced fluid wave
        const rawBands = [
          dataArray[1] || 0,
          dataArray[3] || 0,
          dataArray[6] || 0,
          dataArray[10] || 0,
          dataArray[14] || 0,
        ];

        // Normalize to height percentage (15% min to 100% max)
        const normalized = rawBands.map((val) => {
          const pct = Math.round((val / 255) * 85) + 15;
          return Math.max(15, Math.min(100, pct));
        });

        setAudioLevels(normalized);
        animFrameRef.current = requestAnimationFrame(updateLevels);
      };

      updateLevels();
    } catch (e) {
      console.warn("Real-time AudioContext analysis not supported; using fluid animation fallback:", e);
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
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: selectedMime || "audio/webm",
        });
        onAudioCaptured(audioBlob);
        cleanupAudio();
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setRecordingSeconds(0);

      // Start duration counter
      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);

      // Start dynamic audio visualization
      startAudioAnalysis(stream);
    } catch (err) {
      console.error("Microphone access error:", err);
      alert("Microphone permission denied or unsupported in this browser.");
      cleanupAudio();
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAudio();
    };
  }, [cleanupAudio]);

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  return (
    <div className="flex flex-col items-center justify-center w-full max-w-md mx-auto py-2">
      {/* Aether Sovereign Fluid Voice Capsule Container */}
      <div className="relative group w-full flex items-center justify-center">
        {/* Outer Multi-Chromatic Fluid Glow (Visible when active or listening) */}
        <div
          className={`absolute -inset-1 rounded-full blur-md transition-all duration-700 pointer-events-none ${
            isRecording
              ? "opacity-90 aether-wave-gradient animate-pulse scale-105"
              : isProcessing
              ? "opacity-75 bg-gradient-to-r from-sovereign-teal via-blue-500 to-sovereign-gold animate-pulse"
              : "opacity-0 group-hover:opacity-30 bg-sovereign-teal/40"
          }`}
        />

        {/* Liquid Frosted Glass Capsule */}
        <div
          className={`relative z-10 w-full flex items-center justify-between px-5 py-3 rounded-full border transition-all duration-300 ${
            isRecording
              ? "bg-[#101014]/90 border-white/20 shadow-[0_0_30px_rgba(0,180,160,0.25)]"
              : isProcessing
              ? "bg-[#141418]/90 border-sovereign-teal/30"
              : "bg-[#141418]/70 hover:bg-[#1A1A22]/80 border-white/10 hover:border-white/20 shadow-xl"
          }`}
        >
          {/* Left Indicator & State Icon */}
          <div className="flex items-center space-x-3">
            <button
              onClick={toggleRecording}
              disabled={isProcessing}
              aria-label={isRecording ? "Stop voice recording" : "Start voice inquiry"}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-all duration-300 ${
                isRecording
                  ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30 scale-105"
                  : isProcessing
                  ? "bg-sovereign-teal/15 text-sovereign-teal border border-sovereign-teal/30"
                  : "bg-white/10 hover:bg-white/15 text-white border border-white/15 hover:scale-105 active:scale-95"
              }`}
            >
              {isProcessing ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : isRecording ? (
                <Square className="w-4 h-4 fill-current" />
              ) : (
                <Mic className="w-5 h-5 text-sovereign-teal" />
              )}
            </button>

            {/* Label and Guidance */}
            <div className="flex flex-col text-left">
              <span className="text-xs font-medium text-white/90 tracking-tight flex items-center gap-1.5">
                {isRecording ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                    Listening
                  </>
                ) : isProcessing ? (
                  <>
                    <Sparkles className="w-3.5 h-3.5 text-sovereign-gold animate-spin" />
                    Portfolio Synthesis
                  </>
                ) : (
                  <>
                    <Volume2 className="w-3.5 h-3.5 text-sovereign-teal" />
                    Voice Assistant
                  </>
                )}
              </span>
              <span className="text-[11px] text-white/50 truncate max-w-[170px] sm:max-w-[210px]">
                {isRecording
                  ? `Recording (${formatTimer(recordingSeconds)})`
                  : isProcessing
                  ? statusText || "Verifying local evidence..."
                  : "Tap to ask an AUD financial query"}
              </span>
            </div>
          </div>

          {/* Right: Dynamic Fluid Soundwave Ribbon or Action Button */}
          <div className="flex items-center space-x-2 pl-3">
            {isRecording ? (
              /* Real-time Responsive Wave Bars */
              <div className="flex items-center space-x-1 h-7 px-2 bg-black/40 rounded-full border border-white/5">
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
            ) : isProcessing ? (
              /* Processing Shimmer Bar */
              <div className="w-16 h-1.5 rounded-full overflow-hidden bg-white/10">
                <div className="w-full h-full aether-wave-gradient animate-pulse" />
              </div>
            ) : (
              /* Idle Keyboard Shortcut / Tap Badge */
              <div
                onClick={toggleRecording}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") toggleRecording();
                }}
                className="cursor-pointer text-[10px] font-mono tracking-wider uppercase text-white/40 hover:text-white/80 px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 transition-all"
              >
                Hold to Speak
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sub-disclaimer line */}
      <p className="mt-2 text-[10px] text-white/40 text-center tracking-normal">
        Local speech-to-text (Whisper). Zero confidential audio uploaded to third-party clouds.
      </p>
    </div>
  );
}
