"use client";

import React, { useRef, useState } from "react";
import {
  Send,
  Volume2,
  BookOpen,
  Sparkles,
  Bot,
  User,
  ShieldCheck,
  AlertCircle,
  HelpCircle,
} from "lucide-react";
import { ChatMessage, CitationItem } from "../types";

interface ChatHUDProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onCitationClick: (citation: CitationItem) => void;
  isLoading: boolean;
  onPlayAudio?: (base64Audio: string) => void;
}

export function ChatHUD({
  messages,
  onSendMessage,
  onCitationClick,
  isLoading,
  onPlayAudio,
}: ChatHUDProps) {
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isLoading) return;
    onSendMessage(inputText);
    setInputText("");
  };

  const sampleQuestions = [
    "What was our family taxable income in the latest ATO Notice?",
    "How much was contributed to superannuation guarantee?",
    "Summarize deductible tax expenses for FY 2024.",
  ];

  return (
    <div className="flex flex-col h-full aurora-glass rounded-2xl border border-aurora-cyan/30 shadow-glass overflow-hidden">
      {/* HUD Header */}
      <div className="px-5 py-3.5 border-b border-aurora-border/40 bg-aurora-panel/80 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Bot className="w-5 h-5 text-aurora-cyan" />
          <h2 className="font-space font-bold text-white text-sm tracking-wide">
            Grounded Financial Dialogue
          </h2>
        </div>
        <span className="text-[11px] font-space text-aurora-muted uppercase tracking-wider flex items-center space-x-1">
          <ShieldCheck className="w-3.5 h-3.5 text-green-400 inline" />
          <span>Evidence Mode: Active</span>
        </span>
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {messages.length === 0 ? (
          /* Truthful Empty State with Helpful Prompts */
          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-aurora-panel border border-aurora-cyan/30 flex items-center justify-center text-aurora-cyan shadow-cyan-glow">
              <Sparkles className="w-7 h-7" />
            </div>
            <div className="max-w-md">
              <h3 className="font-space font-bold text-white text-base">
                Ask Questions Grounded in Your Records
              </h3>
              <p className="text-xs text-aurora-muted mt-1 leading-relaxed">
                Click the glowing orb to ask out loud, or type your question below. All responses are derived strictly from authorized Australian financial records with verifiable page citations.
              </p>
            </div>

            {/* Quick Prompts */}
            <div className="w-full max-w-md space-y-2 pt-2">
              <p className="text-[11px] font-space text-aurora-muted uppercase tracking-wider text-left">
                Suggested Financial Prompts:
              </p>
              {sampleQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => onSendMessage(q)}
                  className="w-full text-left p-2.5 rounded-lg aurora-glass-interactive text-xs text-aurora-text hover:text-white font-sans flex items-center justify-between group"
                >
                  <span className="truncate">{q}</span>
                  <Send className="w-3 h-3 text-aurora-cyan opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 ml-2" />
                </button>
              ))}
            </div>
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
                className={`max-w-[85%] rounded-2xl p-4 shadow-md ${
                  msg.sender === "user"
                    ? "bg-aurora-cyan/15 border border-aurora-cyan/40 text-white"
                    : "aurora-glass border border-aurora-border/60 text-aurora-text"
                }`}
              >
                {/* Sender badge & timestamp */}
                <div className="flex items-center space-x-2 mb-2 text-[10px] font-space text-aurora-muted uppercase">
                  {msg.sender === "user" ? (
                    <>
                      <span>You (Spoken / Typed)</span>
                      <User className="w-3 h-3 text-aurora-cyan" />
                    </>
                  ) : (
                    <>
                      <Bot className="w-3 h-3 text-aurora-cyan" />
                      <span>Aurora RAG Assistant</span>
                    </>
                  )}
                  <span>• {msg.timestamp}</span>
                </div>

                {/* Message Content */}
                <div className="text-xs leading-relaxed whitespace-pre-wrap font-sans">
                  {msg.content}
                </div>

                {/* Audio playback button if spoken answer available */}
                {msg.audioBase64 && onPlayAudio && (
                  <button
                    onClick={() => onPlayAudio(msg.audioBase64!)}
                    className="mt-3 flex items-center space-x-1.5 px-2.5 py-1 rounded bg-aurora-cyan/15 hover:bg-aurora-cyan/25 border border-aurora-cyan/30 text-aurora-cyan text-[11px] font-space transition-colors"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Replay Australian Voice</span>
                  </button>
                )}

                {/* Verifiable Citation Chips */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-aurora-border/40 space-y-1.5">
                    <span className="text-[10px] font-space uppercase text-aurora-muted tracking-wider block">
                      Evidence Grounded Citations ({msg.citations.length}):
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {msg.citations.map((c, i) => (
                        <button
                          key={i}
                          onClick={() => onCitationClick(c)}
                          className="flex items-center space-x-1 px-2 py-0.5 rounded bg-aurora-panel/90 border border-aurora-cyan/40 hover:border-aurora-cyan text-[10px] font-space text-aurora-cyan hover:shadow-cyan-glow transition-all"
                        >
                          <BookOpen className="w-3 h-3" />
                          <span className="truncate max-w-[140px]">{c.document_name}</span>
                          <span className="text-white font-semibold">P.{c.page_number}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {/* Loading Bubble */}
        {isLoading && (
          <div className="flex items-center space-x-2 text-aurora-cyan text-xs font-space bg-aurora-panel/60 p-3 rounded-xl border border-aurora-border/40 max-w-sm">
            <Sparkles className="w-4 h-4 animate-spin text-aurora-cyan" />
            <span>Retrieving vectors & synthesizing evidence in AUD...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-aurora-border/40 bg-aurora-panel/90">
        <div className="flex items-center space-x-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={isLoading}
            placeholder="Ask question about ATO tax, superannuation, or bank records..."
            className="flex-1 bg-aurora-void/80 border border-aurora-border/60 rounded-xl px-4 py-2.5 text-xs text-white placeholder-aurora-muted/60 focus:outline-none focus:border-aurora-cyan transition-colors"
          />
          <button
            type="submit"
            disabled={isLoading || !inputText.trim()}
            className="p-2.5 rounded-xl bg-aurora-cyan text-black hover:bg-aurora-cyan/90 disabled:opacity-40 disabled:cursor-not-allowed shadow-cyan-glow transition-all flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
