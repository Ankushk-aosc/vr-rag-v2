"use client";

import React from "react";
import { BookOpen, FileText, Table, X, ShieldCheck } from "lucide-react";
import { CitationItem } from "../types";

interface CitationInspectorProps {
  citation: CitationItem | null;
  onClose: () => void;
  theme?: "dark" | "light";
}

export function CitationInspector({ citation, onClose, theme = "dark" }: CitationInspectorProps) {
  if (!citation) return null;
  const isLight = theme === "light";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-2xl animate-in fade-in duration-200">
      <div
        className={`apple-glass w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] border transition-all ${
          isLight ? "bg-white/95 border-black/10 text-black shadow-xl" : "border-white/10 text-white"
        }`}
      >
        {/* Apple Sheet Header */}
        <div
          className={`flex items-center justify-between px-6 py-4 border-b ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/30 flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-[#D4AF37]" />
            </div>
            <div>
              <h3 className="font-semibold text-sm sm:text-base tracking-tight">
                Verified Provenance Inspector
              </h3>
              <p className={`text-[11px] ${isLight ? "text-black/50" : "text-white/50"}`}>
                Ground-truth excerpt from host repository
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className={`p-2 rounded-full transition-colors ${
              isLight ? "text-black/60 hover:text-black hover:bg-black/5" : "text-white/60 hover:text-white hover:bg-white/10"
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
            <div
              className={`p-3 rounded-2xl border ${
                isLight ? "bg-black/[0.02] border-black/5" : "bg-white/[0.03] border-white/5"
              }`}
            >
              <span className={`block text-[10px] uppercase font-medium tracking-wider ${isLight ? "text-black/40" : "text-white/40"}`}>
                Document
              </span>
              <span className="font-semibold truncate block mt-0.5" title={citation.document_name}>
                {citation.document_name}
              </span>
            </div>

            <div
              className={`p-3 rounded-2xl border ${
                isLight ? "bg-black/[0.02] border-black/5" : "bg-white/[0.03] border-white/5"
              }`}
            >
              <span className={`block text-[10px] uppercase font-medium tracking-wider ${isLight ? "text-black/40" : "text-white/40"}`}>
                Page
              </span>
              <span className="font-semibold text-[#D4AF37] block mt-0.5">
                Page {citation.page_number}
              </span>
            </div>

            <div
              className={`p-3 rounded-2xl border ${
                isLight ? "bg-black/[0.02] border-black/5" : "bg-white/[0.03] border-white/5"
              }`}
            >
              <span className={`block text-[10px] uppercase font-medium tracking-wider ${isLight ? "text-black/40" : "text-white/40"}`}>
                Structure
              </span>
              <span className={`font-semibold flex items-center space-x-1.5 mt-0.5 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`}>
                {citation.is_table ? <Table className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                <span>{citation.is_table ? "Financial Table" : "Text Passage"}</span>
              </span>
            </div>

            <div
              className={`p-3 rounded-2xl border ${
                isLight ? "bg-black/[0.02] border-black/5" : "bg-white/[0.03] border-white/5"
              }`}
            >
              <span className={`block text-[10px] uppercase font-medium tracking-wider ${isLight ? "text-black/40" : "text-white/40"}`}>
                Chunk Hash
              </span>
              <span className={`font-mono text-[10px] truncate block mt-0.5 ${isLight ? "text-black/50" : "text-white/50"}`} title={citation.chunk_id}>
                {citation.chunk_id}
              </span>
            </div>
          </div>

          {/* Excerpt Container */}
          <div className="space-y-2">
            <div className={`flex items-center justify-between text-xs ${isLight ? "text-black/50" : "text-white/50"}`}>
              <span className="font-medium uppercase tracking-wider text-[10px]">
                Atomic Document Segment:
              </span>
              <span className="font-mono text-[10px]">
                {citation.snippet.length} characters
              </span>
            </div>
            <div
              className={`p-5 rounded-2xl border font-mono text-xs sm:text-[13px] leading-relaxed whitespace-pre-wrap selection:bg-[#7C3AED]/30 ${
                isLight
                  ? "bg-[#F7F7FA] border-black/10 text-black"
                  : "bg-[#0A0A0D] border-white/10 text-white/90"
              }`}
            >
              {citation.snippet}
            </div>
          </div>

          {/* Privacy & Governance Note */}
          <div
            className={`flex items-start space-x-3 text-xs p-4 rounded-2xl border ${
              isLight
                ? "bg-black/[0.02] border-black/5 text-black/70"
                : "bg-white/[0.02] border-white/5 text-white/60"
            }`}
          >
            <ShieldCheck className={`w-4 h-4 flex-shrink-0 mt-0.5 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
            <p className="leading-relaxed text-[11px]">
              <strong className={isLight ? "text-black font-semibold" : "text-white font-medium"}>
                Australian Privacy Guarantee:
              </strong>{" "}
              This excerpt was retrieved directly from the verified file stored on this host device. No confidential financial figures (TFNs, BSBs, balances) were submitted to public AI models without local authorization.
            </p>
          </div>
        </div>

        {/* Apple Modal Footer */}
        <div
          className={`px-6 py-4 border-t flex justify-end ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <button
            onClick={onClose}
            className={`px-5 py-2 rounded-full text-xs font-semibold transition-all shadow-md active:scale-95 ${
              isLight
                ? "bg-[#581C87] text-white hover:bg-[#4C1D95]"
                : "bg-white text-black hover:bg-white/90"
            }`}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
