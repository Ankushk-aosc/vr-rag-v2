"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Circle, Loader2 } from "lucide-react";
import { ThinkingStage } from "../types";

interface ThinkingTraceProps {
  stages: ThinkingStage[];
  /** Ignored: the API never sends model reasoning (Audit I-10); kept so older callers still compile. */
  reasoning?: string;
  /** True while the pipeline is still running. */
  working: boolean;
  /** Final total in ms (used once settled). */
  totalMs?: number;
  theme?: "dark" | "light";
  /** Start expanded (the live panel) or collapsed (history). */
  defaultOpen?: boolean;
  /** Collapse automatically when work finishes. */
  collapseOnDone?: boolean;
  /** Unused; kept for API compatibility. */
  reasoningMaxHeight?: number;
}

export function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(1, Math.round(ms))}ms`;
}

/** The retrieval pipeline's own progress events, shown as a factual checklist. No model reasoning. */
export function StageList({ stages, theme = "light" }: { stages: ThinkingStage[]; theme?: "dark" | "light" }) {
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  return (
    <ol className="space-y-1.5" aria-label="Retrieval steps">
      {stages.map((s, i) => (
        <li key={`${s.id || s.title}-${i}`} className="flex items-start gap-2 text-[12.5px]">
          <span className="mt-0.5 w-4 h-4 flex items-center justify-center flex-shrink-0" aria-hidden>
            {s.status === "done" ? (
              <Check className="w-3.5 h-3.5 text-emerald-600" />
            ) : s.status === "active" ? (
              <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" />
            ) : (
              <Circle className={`w-3 h-3 ${muted}`} />
            )}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className={isLight ? "text-slate-800" : "text-slate-200"}>
                {s.title}
                <span className="sr-only">{s.status === "done" ? " (complete)" : s.status === "active" ? " (in progress)" : " (pending)"}</span>
              </span>
              {s.status === "done" && s.duration_ms > 0 && (
                <span className={`font-mono text-[11px] tabular-nums ${muted}`}>{fmtMs(s.duration_ms)}</span>
              )}
            </div>
            {s.details && <p className={`text-[11.5px] leading-snug break-words ${muted}`}>{s.details}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ThinkingTrace({
  stages,
  working,
  totalMs,
  theme = "light",
  defaultOpen = true,
  collapseOnDone = true,
}: ThinkingTraceProps) {
  const isLight = theme === "light";
  const [open, setOpen] = useState(defaultOpen);
  const wasWorking = useRef(working);

  useEffect(() => {
    if (wasWorking.current && !working && collapseOnDone) setOpen(false);
    if (!wasWorking.current && working) setOpen(true);
    wasWorking.current = working;
  }, [working, collapseOnDone]);

  const active = [...stages].reverse().find((s) => s.status === "active");
  const label = working ? active?.title || "Searching authorised records" : "Retrieval steps";
  const muted = isLight ? "text-slate-500" : "text-slate-400";

  return (
    <div className={`border-l-2 pl-3 ${isLight ? "border-slate-200" : "border-slate-700"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-2 text-[12px] font-medium ${muted} hover:text-slate-900`}
      >
        {working && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden />}
        <span>{label}</span>
        {!working && totalMs ? <span className="font-mono tabular-nums">· {fmtMs(totalMs)}</span> : null}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && stages.length > 0 && (
        <div className="mt-2">
          <StageList stages={stages} theme={theme} />
        </div>
      )}
    </div>
  );
}
