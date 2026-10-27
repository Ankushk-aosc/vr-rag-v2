"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Send,
  Volume2,
  VolumeX,
  BookOpen,
  Sparkles,
  Bot,
  X,
  Minus,
  Maximize2,
  Trash2,
  Mic,
  Square,
  Copy,
  Check,
  AlertTriangle,
  BarChart3,
  Loader2,
} from "lucide-react";
import { ChatMessage, CitationItem, DashboardStatus } from "../types";
import { FloatingPanel } from "./FloatingPanel";
import { Markdown } from "./Markdown";
import { ThinkingTrace } from "./ThinkingTrace";
import { useVoiceSnapshot } from "../lib/voice/voiceStore";

interface ChatHUDProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onStopGenerating: () => void;
  onCitationClick: (citation: CitationItem) => void;
  isLoading: boolean;
  isOpen: boolean;
  onClose: () => void;
  onClearMessages?: () => void;
  theme?: "dark" | "light";
  onToggleVoice: () => void;
  onSpeakMessage: (msg: ChatMessage) => void;
  onStopSpeaking: () => void;
  speakingMessageId: string | null;
  onCreateDashboard: (msg: ChatMessage) => void;
  onOpenDashboard: (dashboardId: string) => void;
  dashboardStatus: Record<string, DashboardStatus>;
}

const PHASE_LABEL: Record<string, string> = {
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  speaking: "Speaking",
};

export function ChatHUD({
  messages,
  onSendMessage,
  onStopGenerating,
  onCitationClick,
  isLoading,
  isOpen,
  onClose,
  onClearMessages,
  theme = "dark",
  onToggleVoice,
  onSpeakMessage,
  onStopSpeaking,
  speakingMessageId,
  onCreateDashboard,
  onOpenDashboard,
  dashboardStatus,
}: ChatHUDProps) {
  const [inputText, setInputText] = useState("");
  const [isMinimized, setIsMinimized] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const voice = useVoiceSnapshot();
  const isLight = theme === "light";

  // Follow streaming output, unless the user scrolled up to read something
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, isOpen, isMinimized]);

  if (!isOpen) return null;

  if (isMinimized) {
    return (
      <FloatingPanel
        id="dialogue-pill"
        theme={theme}
        resize="none"
        showGrip
        minW={200}
        minH={44}
        defaultRect={(vw, vh) => ({ x: vw - 250, y: vh - 150, w: 230, h: 44 })}
      >
        <button
          onClick={() => setIsMinimized(false)}
          className={`w-full h-full flex items-center space-x-2.5 px-4 rounded-full border shadow-2xl transition-all ${
            isLight ? "bg-white text-black border-black/10" : "bg-[#16161C] text-white border-white/15"
          }`}
        >
          <Bot className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
          <span className="text-xs font-semibold">Dialogue</span>
          <span className="w-5 h-5 rounded-full bg-[#7C3AED]/20 text-[#7C3AED] text-[10px] font-bold flex items-center justify-center">
            {messages.length}
          </span>
          <Maximize2 className="w-3.5 h-3.5 opacity-40 ml-auto" />
        </button>
      </FloatingPanel>
    );
  }

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isLoading) return;
    stickToBottom.current = true;
    onSendMessage(inputText.trim());
    setInputText("");
  };

  const copy = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const voiceActive = voice.conversation;
  const subtle = isLight ? "text-black/45" : "text-white/45";
  const iconBtn = `p-1.5 rounded-full transition-colors ${
    isLight ? "text-black/40 hover:text-black hover:bg-black/5" : "text-white/40 hover:text-white hover:bg-white/10"
  }`;

  return (
    <FloatingPanel
      id="dialogue"
      theme={theme}
      ariaLabel="Aether dialogue"
      minW={320}
      minH={300}
      defaultRect={(vw, vh) => {
        const w = Math.min(460, vw - 32);
        return { x: vw - w - 24, y: 92, w, h: Math.max(320, vh - 92 - 120) };
      }}
    >
      <aside
        className={`w-full h-full flex flex-col rounded-3xl border shadow-2xl overflow-hidden ${
          isLight ? "bg-white/[0.97] border-black/10 text-black" : "bg-[#121218]/[0.96] border-white/10 text-white"
        }`}
      >
        {/* Header doubles as the drag handle */}
        <div
          data-drag-handle
          title="Drag to move • double-click to reset position"
          className={`px-4 py-3 border-b flex items-center justify-between cursor-grab active:cursor-grabbing touch-none ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/30"
          }`}
        >
          <div className="flex items-center space-x-2.5 pointer-events-none">
            <div className="w-7 h-7 rounded-full bg-[#7C3AED]/15 border border-[#7C3AED]/30 flex items-center justify-center">
              <Bot className={`w-3.5 h-3.5 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
            </div>
            <div>
              <h3 className="text-sm font-semibold tracking-tight">Aether Intelligence</h3>
              <p className={`text-[10px] ${subtle}`}>
                {voiceActive && voice.phase !== "idle"
                  ? `Voice mode • ${PHASE_LABEL[voice.phase] || "Ready"}`
                  : "Grounded answers from your documents"}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-1">
            {onClearMessages && messages.length > 0 && (
              <button onClick={onClearMessages} title="Clear dialogue" className={iconBtn}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => setIsMinimized(true)} title="Minimize" className={iconBtn}>
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button onClick={onClose} title="Close" className={iconBtn}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
          className="flex-1 overflow-y-auto p-4 space-y-4 select-text"
        >
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3 max-w-xs mx-auto">
              <div
                className={`w-12 h-12 rounded-2xl border flex items-center justify-center ${
                  isLight ? "bg-black/5 border-black/10 text-[#6D28D9]" : "bg-white/5 border-white/10 text-[#A78BFA]"
                }`}
              >
                <Sparkles className="w-6 h-6" />
              </div>
              <h4 className="text-sm font-semibold">Ask about your documents</h4>
              <p className={`text-xs leading-relaxed ${subtle}`}>
                Type below, or tap the mic for a hands-free voice conversation — it listens, answers aloud,
                then listens again.
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              if (msg.sender === "user") {
                return (
                  <div key={msg.id} className="flex flex-col items-end">
                    <div
                      className={`max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13px] leading-relaxed ${
                        isLight ? "bg-[#6D28D9] text-white" : "bg-[#2A1F45] text-white border border-[#7C3AED]/30"
                      }`}
                    >
                      {msg.mode === "voice" && <Mic className="inline w-3 h-3 mr-1.5 opacity-70 -mt-0.5" />}
                      {msg.content}
                    </div>
                    <span className={`text-[10px] mt-1 ${subtle}`}>{msg.timestamp}</span>
                  </div>
                );
              }

              if (msg.sender === "system") {
                return (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[12px] ${
                      isLight ? "bg-red-50 border-red-200 text-red-800" : "bg-red-950/30 border-red-500/30 text-red-200"
                    }`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span className="leading-relaxed">{msg.content}</span>
                  </div>
                );
              }

              const stages = msg.thinking_trace || [];
              const sources = (msg.citations && msg.citations.length ? msg.citations : msg.sources) || [];
              const isSpeaking = speakingMessageId === msg.id;
              return (
                <div key={msg.id} className="flex flex-col items-start">
                  <div className="w-full space-y-2.5">
                    {stages.length > 0 && (
                      <ThinkingTrace
                        stages={stages}
                        reasoning={msg.reasoning}
                        working={!!msg.streaming && !msg.content}
                        totalMs={stages.reduce((a, s) => a + (s.duration_ms || 0), 0)}
                        theme={theme}
                        defaultOpen={!!msg.streaming}
                      />
                    )}

                    {msg.content ? (
                      <Markdown
                        text={msg.content}
                        citations={msg.citations || msg.sources}
                        onCitationClick={onCitationClick}
                        theme={theme}
                        streaming={msg.streaming}
                      />
                    ) : null}

                    {!msg.streaming && sources.length > 0 && (
                      <div className={`pt-2 border-t ${isLight ? "border-black/10" : "border-white/10"}`}>
                        <span className="text-[10px] font-semibold tracking-wider uppercase text-[#B8941F] block mb-1.5">
                          Sources
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {sources.map((c, i) => (
                            <button
                              key={`${c.chunk_id}-${i}`}
                              onClick={() => onCitationClick(c)}
                              title={c.snippet.slice(0, 200)}
                              className={`flex items-center space-x-1.5 px-2 py-1 rounded-lg border text-[10.5px] transition-all ${
                                isLight
                                  ? "bg-[#D4AF37]/10 border-[#D4AF37]/40 text-[#7A5F0E] hover:bg-[#D4AF37]/20"
                                  : "bg-[#1C1A14] border-[#D4AF37]/40 text-[#D4AF37] hover:border-[#D4AF37]"
                              }`}
                            >
                              <span className="font-mono font-bold">{c.ref ?? i + 1}</span>
                              <BookOpen className="w-3 h-3" />
                              <span className="truncate max-w-[150px]">{c.document_name}</span>
                              <span className="opacity-60 font-mono">p.{c.page_number}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {!msg.streaming && msg.content && (
                      <div className={`flex items-center gap-1 text-[10px] ${subtle}`}>
                        <span className="mr-1">{msg.timestamp}</span>
                        <button
                          onClick={() => (isSpeaking ? onStopSpeaking() : onSpeakMessage(msg))}
                          title={isSpeaking ? "Stop reading" : "Read aloud"}
                          className={iconBtn}
                        >
                          {isSpeaking ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                        </button>
                        <button onClick={() => copy(msg)} title="Copy answer" className={iconBtn}>
                          {copiedId === msg.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        {msg.grounded === false && <span className="ml-1">• not found in documents</span>}
                      </div>
                    )}

                    {!msg.streaming && msg.content && (() => {
                      const st = dashboardStatus[msg.id];
                      const chip = `flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors ${
                        isLight
                          ? "border-[#6D28D9]/30 text-[#5B21B6] bg-[#6D28D9]/[0.05] hover:bg-[#6D28D9]/10"
                          : "border-[#A78BFA]/30 text-[#DDD6FE] bg-[#7C3AED]/10 hover:bg-[#7C3AED]/20"
                      }`;
                      return (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {st?.state === "loading" ? (
                            <span className={chip}>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Building dashboard…
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => onCreateDashboard(msg)}
                              title="Build charts for this question (2D here, and in the 3D room / VR)"
                              className={chip}
                            >
                              <BarChart3 className="w-3.5 h-3.5" />
                              {st?.state === "ready" ? "Rebuild dashboard" : "Create dashboard"}
                            </button>
                          )}
                          {st?.state === "ready" && (
                            <button type="button" onClick={() => onOpenDashboard(st.dashboardId)} className={chip}>
                              Open dashboard
                            </button>
                          )}
                          {st?.state === "error" && (
                            <span className={`text-[11px] ${isLight ? "text-red-700" : "text-red-300"}`}>{st.message}</span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={handleSubmit}
          className={`p-3 border-t ${isLight ? "border-black/10 bg-white" : "border-white/10 bg-black/40"}`}
        >
          {voiceActive && voice.interim && voice.phase === "listening" && (
            <p className={`text-[11px] mb-2 px-1 italic truncate ${isLight ? "text-[#6D28D9]" : "text-[#C4B5FD]"}`}>
              “{voice.interim}”
            </p>
          )}
          <div
            className={`flex items-center space-x-2 border rounded-xl px-2 py-1.5 ${
              voiceActive
                ? isLight
                  ? "bg-[#6D28D9]/[0.04] border-[#6D28D9]/40"
                  : "bg-[#7C3AED]/10 border-[#7C3AED]/40"
                : isLight
                ? "bg-black/[0.03] border-black/10"
                : "bg-white/5 border-white/10"
            }`}
          >
            <button
              type="button"
              onClick={onToggleVoice}
              aria-label={voiceActive ? "End voice conversation" : "Start voice conversation"}
              title={voiceActive ? "End voice mode" : "Voice mode: talk hands-free"}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all flex-shrink-0 ${
                voiceActive
                  ? "bg-red-500 text-white shadow-md"
                  : isLight
                  ? "bg-[#6D28D9]/10 hover:bg-[#6D28D9]/20 text-[#6D28D9]"
                  : "bg-white/10 hover:bg-white/20 text-[#A78BFA]"
              }`}
            >
              {voiceActive ? <X className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={voiceActive ? "Voice mode on — or type here…" : "Ask a follow-up…"}
              className={`flex-1 bg-transparent text-[13px] focus:outline-none ${
                isLight ? "text-black placeholder-black/40" : "text-white placeholder-white/40"
              }`}
            />
            {isLoading ? (
              <button
                type="button"
                onClick={onStopGenerating}
                aria-label="Stop generating"
                title="Stop generating"
                className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  isLight ? "bg-black text-white" : "bg-white text-black"
                }`}
              >
                <Square className="w-3 h-3 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputText.trim()}
                aria-label="Send message"
                className="w-8 h-8 rounded-lg bg-[#7C3AED] text-white disabled:opacity-30 flex items-center justify-center hover:bg-[#6D28D9] transition-all flex-shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </form>
      </aside>
    </FloatingPanel>
  );
}
