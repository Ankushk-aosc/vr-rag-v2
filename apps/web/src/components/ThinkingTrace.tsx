"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import ThoughtLine from "./ThoughtLine";
import { ThinkingStage } from "../types";

interface ThinkingTraceProps {
  stages: ThinkingStage[];
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
  /** Cap for the reasoning box height in px. */
  reasoningMaxHeight?: number;
}

function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(1, Math.round(ms))}ms`;
}

export function ThinkingTrace({
  stages,
  reasoning = "",
  working,
  totalMs,
  theme = "light",
  defaultOpen = true,
  collapseOnDone = true,
  reasoningMaxHeight = 160,
}: ThinkingTraceProps) {
  const isLight = theme === "light";
  const [open, setOpen] = useState(defaultOpen);
  const reasoningRef = useRef<HTMLDivElement | null>(null);
  const wasWorking = useRef(working);

  useEffect(() => {
    if (wasWorking.current && !working && collapseOnDone) setOpen(false);
    if (!wasWorking.current && working) setOpen(true);
    wasWorking.current = working;
  }, [working, collapseOnDone]);

  // keep the newest reasoning words in view while they stream
  useEffect(() => {
    const el = reasoningRef.current;
    if (el && working) el.scrollTop = el.scrollHeight;
  }, [reasoning, working]);

  const active = [...stages].reverse().find((s) => s.status === "active");
  const label = active ? `${active.title}…` : working ? "Thinking…" : "Thought";
  const accent = isLight ? "#6D28D9" : "#C4B5FD";

  return (
    <div
      className={`rounded-xl border transition-colors ${
        isLight ? "bg-[#6D28D9]/[0.035] border-[#6D28D9]/15" : "bg-white/[0.03] border-[#A78BFA]/20"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <ThoughtLine
          label={label}
          doneLabel="Thought for"
          working={working}
          elapsed={working ? undefined : (totalMs ?? 0) / 1000}
          collapsible={false}
          color={accent}
          glyphColor={isLight ? "#7C3AED" : "#A855F7"}
          fontSize={12.5}
          shimmer
          showTimer
        />
        <ChevronDown
          className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          style={{ color: accent }}
        />
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          <ol className="space-y-1.5">
            {stages.map((s, i) => (
              <li key={`${s.id || s.title}-${i}`} className="flex items-start gap-2 text-[11.5px]">
                <span
                  className={`mt-[1px] w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 ${
                    s.status === "done"
                      ? isLight
                        ? "bg-emerald-500/15 text-emerald-600"
                        : "bg-emerald-400/15 text-emerald-300"
                      : isLight
                      ? "bg-[#6D28D9]/10 text-[#6D28D9]"
                      : "bg-[#A78BFA]/15 text-[#C4B5FD]"
                  }`}
                >
                  {s.status === "done" ? <Check className="w-2.5 h-2.5" /> : <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`font-medium ${isLight ? "text-black/80" : "text-white/85"}`}>{s.title}</span>
                    {s.status === "done" && (
                      <span className={`font-mono text-[10px] ${isLight ? "text-black/40" : "text-white/40"}`}>
                        {fmtMs(s.duration_ms)}
                      </span>
                    )}
                  </div>
                  {s.details && (
                    <p className={`text-[10.5px] leading-snug break-words ${isLight ? "text-black/50" : "text-white/50"}`}>
                      {s.details}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {reasoning.trim() && (
            <div
              ref={reasoningRef}
              className={`text-[11.5px] leading-relaxed whitespace-pre-wrap overflow-y-auto pl-3 border-l-2 italic ${
                isLight ? "border-[#6D28D9]/25 text-black/55" : "border-[#A78BFA]/30 text-white/55"
              }`}
              style={{ maxHeight: reasoningMaxHeight }}
            >
              {reasoning.trim()}
              {working && <span className="aether-caret" />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
