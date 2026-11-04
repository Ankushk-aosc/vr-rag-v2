"use client";

import React from "react";
import { X, CheckCircle2, ShieldAlert } from "lucide-react";
import { ChatMessage } from "../types";
import { FloatingPanel } from "./FloatingPanel";
import { StageList, fmtMs } from "./ThinkingTrace";
import { answerSources, citationLocation, distinctDocuments } from "../lib/citations";

interface ThinkingPanelProps {
  message: ChatMessage | null;
  isOpen: boolean;
  onClose: () => void;
  theme?: "dark" | "light";
}

/**
 * Retrieval progress for the latest answer, built only from the pipeline's stage events and the
 * citations the backend returned. Model reasoning is never sent by the API (Audit I-10).
 */
export function ThinkingPanel({ message, isOpen, onClose, theme = "light" }: ThinkingPanelProps) {
  if (!isOpen) return null;
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const stages = message?.thinking_trace || [];
  const working = !!message?.streaming;
  const retrieved = message?.sources || [];
  const cited = answerSources(message);
  const totalMs = message?.total_latency_ms || stages.reduce((a, s) => a + (s.duration_ms || 0), 0);
  const settled = !!message && !working && stages.length > 0;

  const stat = (value: number, label: string) => (
    <div className="flex items-baseline justify-between text-[13px]">
      <span className={muted}>{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );

  return (
    <FloatingPanel
      id="thinking"
      theme={theme}
      ariaLabel="Reasoning"
      minW={300}
      minH={220}
      defaultRect={(vw, vh) => ({ x: 16, y: 120, w: Math.min(360, vw - 32), h: Math.min(480, vh - 200) })}
    >
      <div
        className={`w-full h-full flex flex-col rounded-lg border shadow-lg overflow-hidden ${
          isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-700 text-slate-100"
        }`}
      >
        <div
          data-drag-handle
          title="Drag to move"
          className={`flex items-center justify-between px-4 py-3 border-b cursor-grab active:cursor-grabbing touch-none select-none ${
            isLight ? "border-slate-200" : "border-slate-800"
          }`}
        >
          <div className="pointer-events-none">
            <h2 className="text-[14px] font-semibold">Reasoning</h2>
            <p className={`text-[12px] ${muted}`}>Evidence retrieval for the latest question</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close reasoning panel"
            className={`p-1.5 rounded ${isLight ? "text-slate-500 hover:text-slate-900 hover:bg-slate-100" : "text-slate-400 hover:text-white hover:bg-slate-800"}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5" aria-live="polite">
          {!message || (!stages.length && !working) ? (
            <div>
              <div className="text-[13px] font-medium">Evidence retrieval</div>
              <div className={`text-[13px] ${muted}`}>Ready</div>
              <p className={`text-[12px] leading-relaxed mt-3 ${muted}`}>
                When you ask a question, the steps used to search your authorised records appear here, followed by the
                evidence the answer relies on.
              </p>
            </div>
          ) : (
            <>
              <section>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-[13px] font-semibold">{working ? "Searching authorised records" : "Retrieval steps"}</h3>
                  {settled && totalMs > 0 && <span className={`font-mono text-[12px] tabular-nums ${muted}`}>{fmtMs(totalMs)}</span>}
                </div>
                {stages.length ? <StageList stages={stages} theme={theme} /> : <p className={`text-[13px] ${muted}`}>Starting…</p>}
              </section>

              {settled && (
                <section className={`pt-4 border-t ${isLight ? "border-slate-200" : "border-slate-800"}`}>
                  <h3 className="text-[13px] font-semibold mb-2">Evidence</h3>
                  <div className="space-y-1">
                    {stat(retrieved.length, "Passages retrieved")}
                    {stat(cited.length, "Passages cited")}
                    {stat(distinctDocuments(cited), "Supporting documents")}
                  </div>
                  {cited.length > 0 && (
                    <ul className="mt-3 space-y-1.5">
                      {cited.map((c, i) => (
                        <li key={`${c.chunk_id}-${i}`} className="text-[12px]">
                          <span className="font-medium">{c.document_name}</span>
                          <span className={muted}> · {citationLocation(c)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {settled && message.grounded === true && (
                <div className={`flex items-start gap-2 text-[12px] ${isLight ? "text-emerald-800" : "text-emerald-300"}`}>
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" aria-hidden />
                  <span>Figures and citation references were verified against the cited records.</span>
                </div>
              )}
              {settled && message.grounded === false && (
                <div className={`flex items-start gap-2 text-[12px] ${isLight ? "text-amber-800" : "text-amber-300"}`}>
                  <ShieldAlert className="w-4 h-4 flex-shrink-0" aria-hidden />
                  <span>Some figures or references could not be verified against your records. Review the cited sources.</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </FloatingPanel>
  );
}
