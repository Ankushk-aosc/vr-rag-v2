"use client";

import React from "react";
import { BookOpen, ExternalLink, FileText, Layers, Table, X } from "lucide-react";
import { CitationItem } from "../types";

interface CitationInspectorProps {
  citation: CitationItem | null;
  onClose: () => void;
}

export function CitationInspector({ citation, onClose }: CitationInspectorProps) {
  if (!citation) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
      <div className="aurora-glass border border-aurora-cyan/40 w-full max-w-2xl rounded-2xl shadow-cyan-glow overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-aurora-border/40 bg-aurora-panel/80">
          <div className="flex items-center space-x-2">
            <BookOpen className="w-5 h-5 text-aurora-cyan" />
            <h3 className="font-space font-bold text-white text-base tracking-wide">
              Verified Evidence Provenance
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-aurora-muted hover:text-white p-1 rounded-lg hover:bg-aurora-surface transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* Metadata Chips */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-space">
            <div className="bg-aurora-void/70 p-2.5 rounded-lg border border-aurora-border/40">
              <span className="text-aurora-muted block text-[10px] uppercase">Document</span>
              <span className="font-semibold text-white truncate block" title={citation.document_name}>
                {citation.document_name}
              </span>
            </div>
            <div className="bg-aurora-void/70 p-2.5 rounded-lg border border-aurora-border/40">
              <span className="text-aurora-muted block text-[10px] uppercase">Source Page</span>
              <span className="font-semibold text-aurora-cyan">Page {citation.page_number}</span>
            </div>
            <div className="bg-aurora-void/70 p-2.5 rounded-lg border border-aurora-border/40">
              <span className="text-aurora-muted block text-[10px] uppercase">Content Type</span>
              <span className="font-semibold text-aurora-violet flex items-center space-x-1">
                {citation.is_table ? <Table className="w-3.5 h-3.5 inline" /> : <FileText className="w-3.5 h-3.5 inline" />}
                <span>{citation.is_table ? "Financial Table" : "Text Passage"}</span>
              </span>
            </div>
            <div className="bg-aurora-void/70 p-2.5 rounded-lg border border-aurora-border/40">
              <span className="text-aurora-muted block text-[10px] uppercase">Integrity Hash</span>
              <span className="font-mono text-[10px] text-aurora-muted truncate block">
                {citation.chunk_id}
              </span>
            </div>
          </div>

          {/* Passage Container */}
          <div className="space-y-2">
            <label className="text-xs font-space uppercase text-aurora-muted font-semibold tracking-wider">
              Exact Extracted Document Excerpt:
            </label>
            <div className="bg-aurora-void/90 p-4 rounded-xl border border-aurora-cyan/30 text-aurora-text font-mono text-xs leading-relaxed whitespace-pre-wrap selection:bg-aurora-cyan selection:text-black">
              {citation.snippet}
            </div>
          </div>

          {/* Privacy Guarantee Note */}
          <div className="text-[11px] text-aurora-muted/80 bg-aurora-surface/40 p-3 rounded-lg border border-aurora-border/30">
            Grounding Verification: This excerpt was extracted directly from the verified file stored on this host device. No fabricated statements or hallucinations are permitted in the response.
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-aurora-border/40 bg-aurora-panel/60 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg font-space text-xs font-semibold text-white bg-aurora-cyan/20 hover:bg-aurora-cyan/30 border border-aurora-cyan/50 transition-colors"
          >
            Close Inspector
          </button>
        </div>
      </div>
    </div>
  );
}
