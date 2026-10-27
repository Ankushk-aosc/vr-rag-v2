"use client";

import React from "react";
import { Brain, X } from "lucide-react";
import { ChatMessage } from "../types";
import { FloatingPanel } from "./FloatingPanel";
import { ThinkingTrace } from "./ThinkingTrace";

interface ThinkingPanelProps {
  message: ChatMessage | null;
  isOpen: boolean;
  onClose: () => void;
  theme?: "dark" | "light";
}

/** Standalone, movable window showing the live reasoning of the most recent answer. */
export function ThinkingPanel({ message, isOpen, onClose, theme = "light" }: ThinkingPanelProps) {
  if (!isOpen) return null;
  const isLight = theme === "light";
  const stages = message?.thinking_trace || [];
  const working = !!message?.streaming && !message?.content;

  return (
    <FloatingPanel
      id="thinking"
      theme={theme}
      ariaLabel="Live reasoning"
      minW={260}
      minH={160}
      defaultRect={(vw, vh) => ({ x: 24, y: Math.max(150, vh - 420), w: Math.min(340, vw - 48), h: 300 })}
    >
      <div
        className={`w-full h-full flex flex-col rounded-2xl border shadow-xl overflow-hidden ${
          isLight ? "bg-white/[0.97] border-black/10 text-black" : "bg-[#121218]/[0.96] border-white/10 text-white"
        }`}
      >
        <div
          data-drag-handle
          title="Drag to move"
          className={`flex items-center justify-between px-3.5 py-2.5 border-b cursor-grab active:cursor-grabbing touch-none ${
            isLight ? "border-black/10" : "border-white/10"
          }`}
        >
          <div className="flex items-center gap-2 pointer-events-none">
            <Brain className={`w-3.5 h-3.5 ${isLight ? "text-[#6D28D9]" : "text-[#C4B5FD]"}`} />
            <span className="text-xs font-semibold">Reasoning</span>
            {working && <span className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6] animate-pulse" />}
          </div>
          <button
            onClick={onClose}
            title="Hide reasoning panel"
            className={`p-1 rounded-full ${isLight ? "text-black/40 hover:bg-black/5" : "text-white/40 hover:bg-white/10"}`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {stages.length ? (
            <ThinkingTrace
              key={message?.id}
              stages={stages}
              reasoning={message?.reasoning}
              working={working}
              totalMs={stages.reduce((a, s) => a + (s.duration_ms || 0), 0)}
              theme={theme}
              defaultOpen
              collapseOnDone={false}
              reasoningMaxHeight={600}
            />
          ) : (
            <p className={`text-[11.5px] leading-relaxed ${isLight ? "text-black/45" : "text-white/45"}`}>
              Ask a question to watch the assistant search your documents, rank evidence and reason in real time.
            </p>
          )}
        </div>
      </div>
    </FloatingPanel>
  );
}
