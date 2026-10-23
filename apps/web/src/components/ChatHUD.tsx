"use client";

import React, { useRef, useState, useEffect } from "react";
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
} from "lucide-react";
import { ChatMessage, CitationItem } from "../types";

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
}: ChatHUDProps) {
  const [inputText, setInputText] = useState("");
  const [isMinimized, setIsMinimized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const isLight = theme === "light";

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (isOpen && !isMinimized) {
      scrollToBottom();
    }
  }, [messages, isLoading, isOpen, isMinimized]);

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

        {/* Loading Indicator */}
        {isLoading && (
          <div
            className={`flex items-center space-x-2.5 text-xs p-3.5 rounded-2xl border max-w-xs backdrop-blur-xl ${
              isLight
                ? "bg-black/5 border-black/10 text-black/70"
                : "bg-white/5 border-white/10 text-white/70"
            }`}
          >
            <Sparkles className="w-4 h-4 text-[#7C3AED] animate-spin flex-shrink-0" />
            <span>Retrieving vectors & synthesizing evidence in AUD...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Internal Mini-Input */}
      <form
        onSubmit={handleSubmit}
        className={`p-3 border-t backdrop-blur-2xl ${
          isLight ? "border-black/10 bg-white/70" : "border-white/10 bg-black/60"
        }`}
      >
        <div
          className={`flex items-center space-x-2 border rounded-xl px-3 py-1.5 ${
            isLight ? "bg-black/5 border-black/10" : "bg-white/5 border-white/10"
          }`}
        >
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={isLoading}
            placeholder="Type follow-up query..."
            className={`flex-1 bg-transparent text-xs focus:outline-none ${
              isLight ? "text-black placeholder-black/40" : "text-white placeholder-white/40"
            }`}
          />
          <button
            type="submit"
            disabled={isLoading || !inputText.trim()}
            className="w-7 h-7 rounded-lg bg-[#7C3AED] text-white disabled:opacity-30 flex items-center justify-center hover:bg-[#6D28D9] transition-all flex-shrink-0 shadow"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
    </aside>
  );
}
