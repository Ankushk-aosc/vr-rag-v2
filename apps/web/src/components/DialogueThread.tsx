"use client";

import React, { useState } from "react";
import { AlertTriangle, Check, Copy, Mic, Volume2, VolumeX, ShieldAlert } from "lucide-react";
import { ChatMessage, CitationItem } from "../types";
import { Markdown } from "./Markdown";
import { ThinkingTrace, fmtMs } from "./ThinkingTrace";
import { answerSources, citationIndex, citationLocation } from "../lib/citations";

export interface DialogueThreadProps {
  messages: ChatMessage[];
  theme: "light" | "dark";
  onCitationClick: (c: CitationItem) => void;
  onSpeakMessage?: (msg: ChatMessage) => void;
  onStopSpeaking?: () => void;
  speakingMessageId?: string | null;
  /** Denser spacing for the side panel. */
  compact?: boolean;
}

/** Evidence list for one answer: numbered, document name, then page / sheet from the backend metadata. */
export function EvidenceList({
  sources,
  theme,
  onCitationClick,
}: {
  sources: CitationItem[];
  theme: "light" | "dark";
  onCitationClick: (c: CitationItem) => void;
}) {
  const isLight = theme === "light";
  return (
    <ol className={`divide-y rounded-md border ${isLight ? "divide-slate-100 border-slate-200" : "divide-slate-800 border-slate-800"}`}>
      {sources.map((c, i) => (
        <li key={`${c.chunk_id}-${i}`}>
          <button
            type="button"
            onClick={() => onCitationClick(c)}
            title={c.snippet ? c.snippet.slice(0, 240) : undefined}
            className={`w-full flex items-baseline gap-3 px-3 py-2 text-left transition-colors ${
              isLight ? "hover:bg-slate-50" : "hover:bg-slate-800/60"
            }`}
          >
            <span className={`font-mono text-[11px] tabular-nums ${isLight ? "text-slate-400" : "text-slate-500"}`}>
              {citationIndex(c, i)}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[13px] font-medium ${isLight ? "text-slate-900" : "text-slate-100"}`}>
                {c.document_name}
              </span>
              <span className={`block text-[12px] ${isLight ? "text-slate-500" : "text-slate-400"}`}>{citationLocation(c)}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function SectionLabel({ children, theme }: { children: React.ReactNode; theme: "light" | "dark" }) {
  return (
    <div className={`text-[11px] font-semibold uppercase tracking-wide mb-1.5 ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
      {children}
    </div>
  );
}

export function DialogueThread({
  messages,
  theme,
  onCitationClick,
  onSpeakMessage,
  onStopSpeaking,
  speakingMessageId,
  compact = false,
}: DialogueThreadProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const iconBtn = `p-1.5 rounded transition-colors ${
    isLight ? "text-slate-400 hover:text-slate-900 hover:bg-slate-100" : "text-slate-500 hover:text-white hover:bg-slate-800"
  }`;

  const copy = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId((id) => (id === msg.id ? null : id)), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className={compact ? "space-y-5" : "space-y-7"} aria-live="polite" aria-busy={messages.some((m) => m.streaming)}>
      {messages.map((msg) => {
        if (msg.sender === "user") {
          return (
            <section key={msg.id} aria-label="Your question">
              <SectionLabel theme={theme}>You asked</SectionLabel>
              <p className={`text-[15px] leading-relaxed font-medium ${isLight ? "text-slate-900" : "text-slate-100"}`}>
                {msg.mode === "voice" && <Mic className={`inline w-3.5 h-3.5 mr-1.5 -mt-0.5 ${muted}`} aria-label="Asked by voice" />}
                {msg.content}
              </p>
            </section>
          );
        }

        if (msg.sender === "system") {
          return (
            <div
              key={msg.id}
              role="alert"
              className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[13px] ${
                isLight ? "bg-rose-50 border-rose-200 text-rose-900" : "bg-rose-950/30 border-rose-900 text-rose-200"
              }`}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
              <span className="leading-relaxed">{msg.content}</span>
            </div>
          );
        }

        const stages = msg.thinking_trace || [];
        const sources = answerSources(msg);
        const isSpeaking = speakingMessageId === msg.id;
        const totalMs = msg.total_latency_ms || stages.reduce((a, s) => a + (s.duration_ms || 0), 0);

        return (
          <section key={msg.id} aria-label="Aether's answer" className="space-y-3">
            <div className="flex items-center gap-2">
              <SectionLabel theme={theme}>Aether</SectionLabel>
              {!msg.streaming && msg.grounded === false && (
                <span
                  className={`mb-1.5 inline-flex items-center gap-1 text-[11px] font-medium ${isLight ? "text-amber-700" : "text-amber-300"}`}
                >
                  <ShieldAlert className="w-3.5 h-3.5" aria-hidden />
                  Not fully verified against your records
                </span>
              )}
            </div>

            {stages.length > 0 && (
              <ThinkingTrace stages={stages} working={!!msg.streaming && !msg.content} totalMs={totalMs} theme={theme} defaultOpen={!!msg.streaming} />
            )}

            {msg.content ? (
              <div className={`text-[14px] leading-relaxed ${isLight ? "text-slate-800" : "text-slate-200"}`}>
                <Markdown text={msg.content} citations={sources} onCitationClick={onCitationClick} theme={theme} streaming={msg.streaming} />
              </div>
            ) : msg.streaming ? (
              <p className={`text-[13px] ${muted}`}>Searching authorised records…</p>
            ) : null}

            {!msg.streaming && sources.length > 0 && (
              <div>
                <SectionLabel theme={theme}>Evidence</SectionLabel>
                <EvidenceList sources={sources} theme={theme} onCitationClick={onCitationClick} />
              </div>
            )}

            {!msg.streaming && msg.content && (
              <div className={`flex items-center gap-2 text-[12px] ${muted}`}>
                <span className="font-mono tabular-nums">{msg.timestamp}</span>
                {totalMs > 0 && <span className="font-mono tabular-nums">· {fmtMs(totalMs)}</span>}
                <div className="ml-auto flex items-center gap-0.5">
                  {onSpeakMessage && (
                    <button
                      type="button"
                      onClick={() => (isSpeaking ? onStopSpeaking?.() : onSpeakMessage(msg))}
                      aria-label={isSpeaking ? "Stop reading aloud" : "Read aloud"}
                      title={isSpeaking ? "Stop reading aloud" : "Read aloud"}
                      className={iconBtn}
                    >
                      {isSpeaking ? <VolumeX className="w-4 h-4 text-blue-600" /> : <Volume2 className="w-4 h-4" />}
                    </button>
                  )}
                  <button type="button" onClick={() => copy(msg)} aria-label="Copy answer" title="Copy answer" className={iconBtn}>
                    {copiedId === msg.id ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
