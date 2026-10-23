"use client";

import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Loader2, Volume2, Sparkles } from "lucide-react";

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
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        onAudioCaptured(audioBlob);
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(250);
      setIsRecording(true);
    } catch (err) {
      console.error("Microphone access error:", err);
      alert("Microphone permission denied or unsupported in this browser.");
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

  return (
    <div className="flex flex-col items-center justify-center p-4">
      {/* 3D Cyber-Tactile Neon Orb Container */}
      <div className="relative flex items-center justify-center">
        {/* Outer Glowing Energy Rings */}
        <div
          className={`absolute w-28 h-28 rounded-full border border-aurora-cyan/30 transition-all duration-700 ${
            isRecording
              ? "scale-125 border-aurora-cyan/70 shadow-cyan-glow animate-ping"
              : isProcessing
              ? "scale-110 border-aurora-violet/70 shadow-violet-glow animate-pulse"
              : "scale-100 opacity-40"
          }`}
        />

        <div
          className={`absolute w-24 h-24 rounded-full border border-aurora-violet/40 transition-all duration-500 ${
            isRecording
              ? "scale-110 border-aurora-cyan shadow-cyan-glow"
              : isProcessing
              ? "rotate-180 border-aurora-violet shadow-violet-glow"
              : "scale-95 opacity-50"
          }`}
        />

        {/* Central Clickable Orb Button */}
        <button
          onClick={toggleRecording}
          disabled={isProcessing}
          aria-label={isRecording ? "Stop voice recording" : "Start voice recording"}
          className={`relative z-10 w-20 h-20 rounded-full flex flex-col items-center justify-center transition-all duration-300 shadow-glass ${
            isRecording
              ? "bg-red-500/20 border-2 border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.5)]"
              : isProcessing
              ? "bg-aurora-violet/20 border-2 border-aurora-violet shadow-violet-glow"
              : "bg-aurora-panel/90 border-2 border-aurora-cyan hover:scale-105 shadow-cyan-glow"
          }`}
        >
          {isProcessing ? (
            <Loader2 className="w-8 h-8 text-aurora-violet animate-spin" />
          ) : isRecording ? (
            <MicOff className="w-8 h-8 text-red-400 animate-pulse" />
          ) : (
            <Mic className="w-8 h-8 text-aurora-cyan" />
          )}
        </button>
      </div>

      {/* Voice Status & Live Soundwave Feedback */}
      <div className="mt-4 flex flex-col items-center text-center">
        <p className="font-space text-xs font-semibold tracking-wider uppercase text-white">
          {isRecording
            ? "Listening (Speak Australian Financial Question)..."
            : isProcessing
            ? statusText || "Verifying Authorized Evidence..."
            : "Click Orb to Speak Voice Question"}
        </p>

        {/* Soundwave frequency bars when recording */}
        {isRecording && (
          <div className="flex items-center space-x-1 mt-2 h-4">
            <span className="w-1 bg-aurora-cyan h-2 animate-[pulse_0.4s_infinite]" />
            <span className="w-1 bg-aurora-cyan h-4 animate-[pulse_0.3s_infinite]" />
            <span className="w-1 bg-aurora-cyan h-3 animate-[pulse_0.5s_infinite]" />
            <span className="w-1 bg-aurora-cyan h-5 animate-[pulse_0.2s_infinite]" />
            <span className="w-1 bg-aurora-cyan h-2 animate-[pulse_0.4s_infinite]" />
          </div>
        )}
      </div>
    </div>
  );
}
