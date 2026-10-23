"use client";

import React from "react";
import {
  FileText,
  Upload,
  ShieldCheck,
  HardDrive,
  Hash,
  Calendar,
  Layers,
  ArrowUpRight,
} from "lucide-react";
import { DocumentRecord } from "../types";

interface LedgerViewProps {
  documents: DocumentRecord[];
  selectedEntity: string;
  onOpenUpload: () => void;
  onSelectDocument: (doc: DocumentRecord) => void;
  theme?: "dark" | "light";
}

export function LedgerView({
  documents,
  selectedEntity,
  onOpenUpload,
  onSelectDocument,
  theme = "dark",
}: LedgerViewProps) {
  const isLight = theme === "light";

  return (
    <div className="w-full max-w-5xl mx-auto pt-24 pb-32 px-4 sm:px-6 animate-in fade-in duration-300">
      {/* Executive Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div
          className={`apple-glass rounded-3xl p-5 border shadow-xl transition-all ${
            isLight ? "bg-white/90 border-black/10 text-black" : "border-white/10 text-white"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className={`text-xs font-medium uppercase tracking-wider ${isLight ? "text-black/50" : "text-white/50"}`}>
              Indexed Documents
            </span>
            <FileText className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
          </div>
          <div className="mt-2 flex items-baseline space-x-2">
            <span className="text-2xl font-bold tabular-numbers">
              {documents.length}
            </span>
            <span className={`text-xs ${isLight ? "text-black/40" : "text-white/40"}`}>Verified Files</span>
          </div>
        </div>

        <div
          className={`apple-glass rounded-3xl p-5 border shadow-xl transition-all ${
            isLight ? "bg-white/90 border-black/10 text-black" : "border-white/10 text-white"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className={`text-xs font-medium uppercase tracking-wider ${isLight ? "text-black/50" : "text-white/50"}`}>
              Legal Governance
            </span>
            <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
          </div>
          <div className="mt-2 flex items-baseline space-x-2">
            <span className="text-sm font-semibold truncate">
              ASIC RG 244 & APPs
            </span>
            <span className={`text-xs ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`}>Factual Grounding</span>
          </div>
        </div>

        <div
          className={`apple-glass rounded-3xl p-5 border shadow-xl flex items-center justify-between transition-all ${
            isLight ? "bg-white/90 border-black/10 text-black" : "border-white/10 text-white"
          }`}
        >
          <div>
            <span className={`text-xs font-medium uppercase tracking-wider block ${isLight ? "text-black/50" : "text-white/50"}`}>
              Authorized Vault
            </span>
            <span className="text-sm font-semibold mt-1 block truncate max-w-[160px]">
              {selectedEntity}
            </span>
          </div>
          <button
            onClick={onOpenUpload}
            className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-full font-semibold text-xs tracking-tight shadow-md transition-all active:scale-95 ${
              isLight
                ? "bg-[#581C87] text-white hover:bg-[#4C1D95]"
                : "bg-white text-black hover:bg-white/90"
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Deposit</span>
          </button>
        </div>
      </div>

      {/* Ledger Table Surface */}
      <div
        className={`apple-glass rounded-3xl border shadow-2xl overflow-hidden transition-all ${
          isLight ? "bg-white/90 border-black/10 text-black" : "border-white/10 text-white"
        }`}
      >
        <div
          className={`px-6 py-4 border-b flex items-center justify-between ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <div className="flex items-center space-x-2">
            <HardDrive className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
            <h3 className="text-sm font-semibold tracking-tight">
              Evidence Repository Ledger
            </h3>
          </div>
          <span className={`text-xs font-mono ${isLight ? "text-black/40" : "text-white/40"}`}>
            SQLite WAL • Cloud Metadata Sanitized
          </span>
        </div>

        {documents.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <div
              className={`w-12 h-12 rounded-2xl border flex items-center justify-center mx-auto ${
                isLight ? "bg-black/5 border-black/10 text-black/40" : "bg-white/5 border-white/10 text-white/40"
              }`}
            >
              <FileText className="w-6 h-6" />
            </div>
            <p className="text-sm font-medium">
              No financial records deposited yet
            </p>
            <p className={`text-xs max-w-sm mx-auto ${isLight ? "text-black/50" : "text-white/40"}`}>
              Upload ATO Notices, Superannuation statements, or Macquarie portfolio wraps to enable grounded evidence citations.
            </p>
            <button
              onClick={onOpenUpload}
              className="mt-2 inline-flex items-center space-x-2 px-4 py-2 rounded-full bg-[#7C3AED] text-white font-semibold text-xs transition-all hover:bg-[#6D28D9]"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Deposit First Record</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead
                className={`border-b font-medium uppercase tracking-wider text-[10px] ${
                  isLight
                    ? "border-black/10 bg-black/[0.02] text-black/50"
                    : "border-white/10 bg-white/[0.02] text-white/40"
                }`}
              >
                <tr>
                  <th className="px-6 py-3.5">Document Name</th>
                  <th className="px-6 py-3.5">Pages</th>
                  <th className="px-6 py-3.5">Size</th>
                  <th className="px-6 py-3.5">Integrity Hash</th>
                  <th className="px-6 py-3.5">Status</th>
                  <th className="px-6 py-3.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isLight ? "divide-black/5" : "divide-white/5"}`}>
                {documents.map((doc) => (
                  <tr
                    key={doc.id}
                    className={`transition-colors group cursor-pointer ${
                      isLight ? "hover:bg-black/[0.03]" : "hover:bg-white/[0.03]"
                    }`}
                    onClick={() => onSelectDocument(doc)}
                  >
                    <td className="px-6 py-4 flex items-center space-x-3">
                      <div
                        className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${
                          isLight ? "bg-[#6D28D9]/10" : "bg-white/5"
                        }`}
                      >
                        <FileText className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
                      </div>
                      <span
                        className={`font-semibold truncate max-w-xs transition-colors ${
                          isLight ? "group-hover:text-[#6D28D9]" : "group-hover:text-[#A78BFA]"
                        }`}
                      >
                        {doc.original_name}
                      </span>
                    </td>
                    <td className={`px-6 py-4 font-mono ${isLight ? "text-black/70" : "text-white/70"}`}>
                      {doc.total_pages} page(s)
                    </td>
                    <td className={`px-6 py-4 tabular-numbers ${isLight ? "text-black/70" : "text-white/70"}`}>
                      {(doc.file_size / 1024).toFixed(1)} KB
                    </td>
                    <td
                      className={`px-6 py-4 font-mono truncate max-w-[140px] ${
                        isLight ? "text-black/40" : "text-white/40"
                      }`}
                      title={doc.file_hash}
                    >
                      {doc.file_hash.slice(0, 12)}...
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium border ${
                          isLight
                            ? "bg-[#6D28D9]/10 text-[#6D28D9] border-[#6D28D9]/25"
                            : "bg-[#7C3AED]/20 text-[#A78BFA] border-[#7C3AED]/40"
                        }`}
                      >
                        Verified
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span
                        className={`inline-flex items-center space-x-1 text-xs font-medium transition-colors ${
                          isLight
                            ? "text-black/40 group-hover:text-[#6D28D9]"
                            : "text-white/40 group-hover:text-white"
                        }`}
                      >
                        <span>Inspect</span>
                        <ArrowUpRight className="w-3 h-3" />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
