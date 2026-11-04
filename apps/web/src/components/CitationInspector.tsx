"use client";

import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { CitationItem } from "../types";
import { citationLocation } from "../lib/citations";

interface CitationInspectorProps {
  citation: CitationItem | null;
  onClose: () => void;
  theme?: "dark" | "light";
}

/** Shows the exact passage an answer cites, as returned by the API. Rendered as text, never HTML. */
export function CitationInspector({ citation, onClose, theme = "light" }: CitationInspectorProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!citation) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [citation, onClose]);

  if (!citation) return null;
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-slate-900/40" onMouseDown={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="citation-title"
        onMouseDown={(e) => e.stopPropagation()}
        className={`w-full max-w-xl h-full flex flex-col border-l shadow-xl focus:outline-none ${
          isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-700 text-slate-100"
        }`}
      >
        <div className={`flex items-start justify-between gap-3 px-5 py-4 border-b ${isLight ? "border-slate-200" : "border-slate-800"}`}>
          <div className="min-w-0">
            <div className={`text-[12px] font-semibold uppercase tracking-wide ${muted}`}>Source</div>
            <h2 id="citation-title" className="text-[16px] font-semibold break-words">
              {citation.document_name}
            </h2>
            <p className={`text-[13px] ${muted}`}>{citationLocation(citation)}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close source"
            className={`p-1.5 rounded ${isLight ? "text-slate-500 hover:bg-slate-100" : "text-slate-400 hover:bg-slate-800"}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <div className={`text-[12px] font-semibold mb-1.5 ${muted}`}>Cited passage</div>
            {citation.snippet ? (
              <pre
                className={`p-4 rounded-md border text-[13px] leading-relaxed whitespace-pre-wrap break-words font-mono ${
                  isLight ? "bg-slate-50 border-slate-200 text-slate-800" : "bg-slate-900 border-slate-800 text-slate-200"
                }`}
              >
                {citation.snippet}
              </pre>
            ) : (
              <p className={`text-[13px] ${muted}`}>No passage text was returned for this source.</p>
            )}
          </div>
          <dl className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-[12px]">
            <dt className={muted}>Type</dt>
            <dd className="col-span-2">{citation.is_table ? "Table" : "Text"}</dd>
            {typeof citation.score === "number" && (
              <>
                <dt className={muted}>Relevance score</dt>
                <dd className="col-span-2 tabular-nums">{citation.score.toFixed(3)}</dd>
              </>
            )}
            <dt className={muted}>Passage ID</dt>
            <dd className="col-span-2 font-mono break-all">{citation.chunk_id}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
