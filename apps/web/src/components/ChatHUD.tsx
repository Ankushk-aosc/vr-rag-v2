"use client";

import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  Send,
  Volume2,
  BookOpen,
  Sparkles,
  Bot,
  User,
  ShieldCheck,
  X,
  Minus,
  Maximize2,
  Trash2,
  Mic,
  Square,
  Loader2,
} from "lucide-react";
import { ChatMessage, CitationItem } from "../types";
import ThoughtLine from "./ThoughtLine";

interface ChatHUDProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onCitationClick: (citation: CitationItem) => void;
  isLoading: boolean;
  onPlayAudio?: (base64Audio: string) => void;
  isOpen: boolean;
  onClose: () => void;
  onClearMessages?: () => void;
  theme?: "dark" | "light";
  onAudioCaptured?: (audioBlob: Blob) => void;
}

export function ChatHUD({
  messages,
  onSendMessage,
  onCitationClick,
  isLoading,
  onPlayAudio,
  isOpen,
  onClose,
  onClearMessages,
  theme = "dark",
  onAudioCaptured,
}: ChatHUDProps) {
  const [inputText, setInputText] = useState("");
  const [isMinimized, setIsMinimized] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const accumulatedTranscriptRef = useRef<string>("");

  const isLight = theme === "light";

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (isOpen && !isMinimized) {
      scrollToBottom();
    }
  }, [messages, isLoading, isOpen, isMinimized]);

  // Clean up audio safely
  const cleanupAudio = useCallback(() => {
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.abort();
      } catch {}
      speechRecognitionRef.current = null;
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
    setRecordingSeconds(0);
  }, []);

  const cleanupRef = useRef(cleanupAudio);
  useEffect(() => {
    cleanupRef.current = cleanupAudio;
  });

  useEffect(() => {
    return () => {
      cleanupRef.current();
    };
  }, []);

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

        if (recognizedText) {
          onSendMessage(recognizedText);
          setInputText("");
        } else if (audioBlob.size >= 500 && onAudioCaptured) {
          onAudioCaptured(audioBlob);
        }

        cleanupAudio();
      };

      mediaRecorder.start(200);
      setIsRecording(true);
      setRecordingSeconds(0);

      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);

      // Web Speech API for real-time transcription
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
          console.warn("SpeechRecognition fallback in dialogue:", e);
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

  if (!isOpen) return null;

  // Minimized floating pill mode
  if (isMinimized) {
    return (
      <div className="fixed bottom-28 right-6 z-30 animate-in fade-in zoom-in-95 duration-200">
        <button
          onClick={() => setIsMinimized(false)}
          className={`flex items-center space-x-2.5 px-4 py-2.5 rounded-full border backdrop-blur-2xl shadow-2xl transition-all hover:scale-105 active:scale-95 ${
            isLight
              ? "bg-white/90 hover:bg-white text-black border-black/10"
              : "bg-[#141418]/90 hover:bg-[#1E1E26] text-white border-white/15"
          }`}
        >
          <Bot className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
          <span className="text-xs font-semibold">Intelligence Dialogue</span>
          <span className="w-5 h-5 rounded-full bg-[#7C3AED]/20 text-[#7C3AED] text-[10px] font-bold flex items-center justify-center">
            {messages.length}
          </span>
          <Maximize2 className="w-3.5 h-3.5 opacity-40 ml-1" />
        </button>
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isLoading) return;
    onSendMessage(inputText.trim());
    setInputText("");
  };

  return (
    <aside
      className={`fixed top-20 right-4 sm:right-6 bottom-28 w-[calc(100vw-2rem)] sm:w-[460px] z-30 flex flex-col apple-glass rounded-3xl border shadow-2xl backdrop-blur-3xl overflow-hidden animate-in slide-in-from-right-4 duration-300 ${
        isLight
          ? "bg-white/90 border-black/10 text-black shadow-xl"
          : "bg-[#121218]/85 border-white/10 text-white"
      }`}
    >
      {/* Apple Vision Pro Window Header */}
      <div
        className={`px-5 py-3.5 border-b flex items-center justify-between ${
          isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
        }`}
      >
        <div className="flex items-center space-x-2.5">
          <div className="w-7 h-7 rounded-full bg-[#7C3AED]/15 border border-[#7C3AED]/30 flex items-center justify-center">
            <Bot className={`w-3.5 h-3.5 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
          </div>
          <div>
            <h3 className="text-xs sm:text-sm font-semibold tracking-tight">
              Aether Intelligence
            </h3>
            <p className={`text-[10px] ${isLight ? "text-black/50" : "text-white/50"}`}>
              ASIC RG 244 • Australian Wealth Synthesis
            </p>
          </div>
        </div>

        {/* Window Controls */}
        <div className="flex items-center space-x-1">
          {onClearMessages && messages.length > 0 && (
            <button
              onClick={onClearMessages}
              title="Clear dialogue"
              className={`p-1.5 rounded-full transition-colors ${
                isLight ? "text-black/40 hover:text-black hover:bg-black/5" : "text-white/40 hover:text-white hover:bg-white/10"
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={() => setIsMinimized(true)}
            title="Minimize"
            className={`p-1.5 rounded-full transition-colors ${
              isLight ? "text-black/40 hover:text-black hover:bg-black/5" : "text-white/40 hover:text-white hover:bg-white/10"
            }`}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onClose}
            title="Close"
            className={`p-1.5 rounded-full transition-colors ${
              isLight ? "text-black/40 hover:text-black hover:bg-black/5" : "text-white/40 hover:text-white hover:bg-white/10"
            }`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3 max-w-xs mx-auto">
            <div
              className={`w-12 h-12 rounded-2xl border flex items-center justify-center ${
                isLight ? "bg-black/5 border-black/10 text-[#6D28D9]" : "bg-white/5 border-white/10 text-[#A78BFA]"
              }`}
            >
              <Sparkles className="w-6 h-6" />
            </div>
            <h4 className="text-sm font-semibold">
              No Active Dialogue Yet
            </h4>
            <p className={`text-xs leading-relaxed ${isLight ? "text-black/50" : "text-white/50"}`}>
              Use the Aether Command Capsule at the bottom to speak or type an inquiry regarding AAPL equities or verified financial records.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.sender === "user" ? "items-end" : "items-start"
              }`}
            >
              <div
                className={`max-w-[90%] rounded-2xl p-4 shadow-sm ${
                  msg.sender === "user"
                    ? isLight
                      ? "bg-[#6D28D9] text-white border border-[#581C87] rounded-br-sm shadow"
                      : "bg-[#251B38] text-white border border-[#7C3AED]/30 rounded-br-sm"
                    : isLight
                    ? "bg-[#F4F4F8] text-black border border-black/5 rounded-bl-sm"
                    : "bg-[#14141A]/90 text-white/90 border border-white/10 rounded-bl-sm backdrop-blur-xl"
                }`}
              >
                {/* Meta header */}
                <div
                  className={`flex items-center space-x-2 mb-2 text-[10px] ${
                    msg.sender === "user"
                      ? "text-white/70"
                      : isLight
                      ? "text-black/50"
                      : "text-white/40"
                  }`}
                >
                  {msg.sender === "user" ? (
                    <>
                      <User className="w-3 h-3 text-white" />
                      <span className="font-medium text-white">You</span>
                    </>
                  ) : (
                    <>
                      <Bot className={`w-3 h-3 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
                      <span className={`font-medium ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`}>
                        Aether Assistant
                      </span>
                    </>
                  )}
                  <span>•</span>
                  <span>{msg.timestamp}</span>
                </div>

                {/* Content */}
                <div className="text-xs sm:text-[13px] leading-relaxed whitespace-pre-wrap font-sans tabular-numbers">
                  {msg.content}
                </div>

                {/* Audio playback */}
                {msg.audioBase64 && onPlayAudio && (
                  <button
                    onClick={() => onPlayAudio(msg.audioBase64!)}
                    className={`mt-3 flex items-center space-x-1.5 px-3 py-1 rounded-full border text-[11px] font-medium transition-all ${
                      isLight
                        ? "bg-[#6D28D9]/10 hover:bg-[#6D28D9]/20 border-[#6D28D9]/30 text-[#6D28D9]"
                        : "bg-[#7C3AED]/20 hover:bg-[#7C3AED]/30 border-[#7C3AED]/40 text-[#A78BFA]"
                    }`}
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Replay Voice (en-AU)</span>
                  </button>
                )}

                {/* Champagne Gold Citations */}
                {msg.citations && msg.citations.length > 0 && (
                  <div
                    className={`mt-3.5 pt-3 border-t space-y-1.5 ${
                      isLight ? "border-black/10" : "border-white/10"
                    }`}
                  >
                    <span className="text-[10px] font-semibold tracking-wider uppercase text-[#D4AF37] block">
                      Evidence Sources ({msg.citations.length}):
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {msg.citations.map((c, i) => (
                        <button
                          key={i}
                          onClick={() => onCitationClick(c)}
                          className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-[#1C1A14] hover:bg-[#2A261C] border border-[#D4AF37]/50 hover:border-[#D4AF37] text-[10px] text-[#D4AF37] transition-all shadow-sm"
                        >
                          <BookOpen className="w-3 h-3" />
                          <span className="truncate max-w-[130px] font-medium">
                            {c.document_name}
                          </span>
                          <span className="opacity-70 font-mono">P.{c.page_number}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {/* ThoughtLine Reasoning Trace while RAG generates answer */}
        {isLoading && (
          <div
            className={`p-3.5 rounded-2xl border backdrop-blur-xl transition-all shadow-md ${
              isLight
                ? "bg-white/85 border-[#6D28D9]/20 text-[#6D28D9]"
                : "bg-[#161224]/90 border-[#7C3AED]/30 text-[#C084FC]"
            }`}
          >
            <ThoughtLine
              label="Synthesizing Australian Financial Evidence…"
              doneLabel="Evidence synthesized"
              color={isLight ? "#6D28D9" : "#C084FC"}
              glyphColor={isLight ? "#7C3AED" : "#A855F7"}
              fontSize={13}
              working={true}
              steps={[
                "Querying Pinecone Serverless vector index (3,294 vectors)",
                "Evaluating ASIC RG 244 & Australian Privacy compliance",
                "Synthesizing evidence with Groq Cloud (qwen/qwen3.8-27b)",
                "Generating Australian neural voice stream",
              ]}
              collapsible={true}
              shimmer={true}
              showTimer={true}
            />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Internal Mini-Input with Voice Microphone Option */}
      <form
        onSubmit={handleSubmit}
        className={`p-3 border-t backdrop-blur-2xl ${
          isLight ? "border-black/10 bg-white/70" : "border-white/10 bg-black/60"
        }`}
      >
        <div
          className={`flex items-center space-x-2 border rounded-xl px-2.5 py-1.5 transition-all ${
            isRecording
              ? isLight
                ? "bg-red-50/80 border-red-400/60 ring-1 ring-red-400/30"
                : "bg-red-950/25 border-red-500/60 ring-1 ring-red-500/30"
              : isLight
              ? "bg-black/5 border-black/10"
              : "bg-white/5 border-white/10"
          }`}
        >
          {/* Mic Button */}
          <button
            type="button"
            onClick={toggleRecording}
            disabled={isLoading}
            aria-label={isRecording ? "Stop voice recording" : "Speak follow-up query"}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all flex-shrink-0 ${
              isRecording
                ? "bg-red-500 text-white animate-pulse shadow-md"
                : isLight
                ? "bg-[#6D28D9]/10 hover:bg-[#6D28D9]/20 text-[#6D28D9]"
                : "bg-white/10 hover:bg-white/20 text-[#A78BFA]"
            }`}
          >
            {isRecording ? (
              <Square className="w-3.5 h-3.5 fill-current" />
            ) : (
              <Mic className="w-3.5 h-3.5" />
            )}
          </button>

          {/* Active Recording Timer Badge */}
          {isRecording && (
            <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-red-500/15 text-red-500 border border-red-500/30 flex-shrink-0">
              {Math.floor(recordingSeconds / 60)}:{(recordingSeconds % 60).toString().padStart(2, "0")}
            </span>
          )}

          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={isLoading}
            placeholder={
              isRecording
                ? "Listening... Speak your query"
                : "Type or speak follow-up query..."
            }
            className={`flex-1 bg-transparent text-xs focus:outline-none ${
              isLight ? "text-black placeholder-black/40" : "text-white placeholder-white/40"
            }`}
          />

          {isRecording ? (
            <button
              type="button"
              onClick={stopRecording}
              className="px-2 py-1 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-500 text-[11px] font-semibold tracking-tight transition-all flex-shrink-0 border border-red-500/40"
            >
              Done
            </button>
          ) : (
            <button
              type="submit"
              disabled={isLoading || !inputText.trim()}
              aria-label="Send message"
              className="w-7 h-7 rounded-lg bg-[#7C3AED] text-white disabled:opacity-30 flex items-center justify-center hover:bg-[#6D28D9] transition-all flex-shrink-0 shadow"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
