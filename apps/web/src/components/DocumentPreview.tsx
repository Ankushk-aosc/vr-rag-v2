"use client";

import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { DocumentRecord } from "../types";
import { fileExtension, formatBytes, formatDateTime } from "../lib/format";

interface DocumentPreviewProps {
  document: DocumentRecord | null;
  onClose: () => void;
  onAsk?: (question: string) => void;
  theme?: "dark" | "light";
}

/** Metadata and the extracted text preview the API stored for a document. Rendered as text only. */
export function DocumentPreview({ document: doc, onClose, onAsk, theme = "light" }: DocumentPreviewProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!doc) return;
    const previous = window.document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.document.addEventListener("keydown", onKey);
    return () => {
      window.document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [doc, onClose]);

  if (!doc) return null;
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const rows: [string, string][] = [
    ["Type", fileExtension(doc.original_name)],
    ["Pages", doc.total_pages ? String(doc.total_pages) : "—"],
    ["Size", formatBytes(doc.file_size)],
    ["Uploaded", formatDateTime(doc.uploaded_at)],
    ["Status", doc.status || "—"],
    ["SHA-256", doc.file_hash || "—"],
  ];

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-slate-900/40" onMouseDown={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-preview-title"
        onMouseDown={(e) => e.stopPropagation()}
        className={`w-full max-w-xl h-full flex flex-col border-l shadow-xl focus:outline-none ${
          isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-700 text-slate-100"
        }`}
      >
        <div className={`flex items-start justify-between gap-3 px-5 py-4 border-b ${isLight ? "border-slate-200" : "border-slate-800"}`}>
          <div className="min-w-0">
            <div className={`text-[12px] font-semibold uppercase tracking-wide ${muted}`}>Document</div>
            <h2 id="doc-preview-title" className="text-[16px] font-semibold break-words">
              {doc.original_name}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close preview"
            className={`p-1.5 rounded ${isLight ? "text-slate-500 hover:bg-slate-100" : "text-slate-400 hover:bg-slate-800"}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <dl className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-[13px]">
            {rows.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className={muted}>{k}</dt>
                <dd className={`col-span-2 break-all ${k === "SHA-256" ? "font-mono text-[12px]" : ""}`}>{v}</dd>
              </React.Fragment>
            ))}
          </dl>

          <div>
            <div className={`text-[12px] font-semibold mb-1.5 ${muted}`}>Extracted text (beginning)</div>
            {doc.preview_text ? (
              <pre
                className={`p-4 rounded-md border text-[13px] leading-relaxed whitespace-pre-wrap break-words font-mono ${
                  isLight ? "bg-slate-50 border-slate-200 text-slate-800" : "bg-slate-900 border-slate-800 text-slate-200"
                }`}
              >
                {doc.preview_text}
              </pre>
            ) : (
              <p className={`text-[13px] ${muted}`}>No text preview is available for this document.</p>
            )}
          </div>
        </div>

        {onAsk && (
          <div className={`px-5 py-3 border-t flex justify-end ${isLight ? "border-slate-200" : "border-slate-800"}`}>
            <button
              type="button"
              onClick={() => {
                onAsk(`Summarise the key figures in ${doc.original_name}`);
                onClose();
              }}
              className="h-9 px-3.5 rounded-md bg-[#2563EB] text-white text-[13px] font-medium hover:bg-[#1D4ED8]"
            >
              Ask about this document
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
