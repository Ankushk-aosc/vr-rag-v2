"use client";

import React, { useEffect, useState, useTransition } from "react";
import {
  Table as TableIcon,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  X,
  FileSpreadsheet,
  ShieldCheck,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { DocumentRecord, DocumentTableData } from "../types";
import { fetchDocumentTable } from "../lib/api";

interface TableViewerModalProps {
  document: DocumentRecord | null;
  onClose: () => void;
  theme?: "dark" | "light";
}

export function TableViewerModal({ document, onClose, theme = "dark" }: TableViewerModalProps) {
  const isLight = theme === "light";
  const [data, setData] = useState<DocumentTableData | null>(null);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);
  const [search, setSearch] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [isPending, startTransition] = useTransition();

  // Debounce search input by 350ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // reset to page 1 on new search
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch table data when document, page, or search changes
  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    setLoading(true);

    fetchDocumentTable(document.id, page, pageSize, debouncedSearch).then((res) => {
      if (!cancelled) {
        if (res) {
          setData(res);
        } else if (document.columns && document.sample_rows) {
          // Fallback to sample rows if offline
          setData({
            document_id: document.id,
            filename: document.original_name,
            columns: document.columns,
            rows: document.sample_rows,
            total_rows: document.sample_rows.length,
            page: 1,
            page_size: pageSize,
            total_pages: 1,
          });
        }
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [document, page, pageSize, debouncedSearch]);

  if (!document) return null;

  const totalRows = data?.total_rows ?? 0;
  const totalPages = data?.total_pages ?? 1;
  const startRow = Math.min((page - 1) * pageSize + 1, totalRows);
  const endRow = Math.min(startRow + (data?.rows.length || 0) - 1, totalRows);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-2xl animate-in fade-in duration-200">
      <div
        className={`apple-glass w-full max-w-6xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] border transition-all ${
          isLight ? "bg-white/95 border-black/10 text-black shadow-2xl" : "border-white/10 text-white"
        }`}
      >
        {/* Header Bar */}
        <div
          className={`flex flex-col sm:flex-row sm:items-center justify-between px-6 py-4 border-b gap-3 ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-[#7C3AED]/15 border border-[#7C3AED]/30 flex items-center justify-center flex-shrink-0">
              <FileSpreadsheet className="w-5 h-5 text-[#7C3AED]" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-base sm:text-lg tracking-tight truncate" title={document.original_name}>
                {document.original_name}
              </h3>
              <div className="flex items-center space-x-2 text-xs">
                <span className={`font-mono ${isLight ? "text-black/50" : "text-white/50"}`}>
                  {totalRows > 0 ? `${totalRows.toLocaleString()} Verified Records` : "Tabular Ledger"}
                </span>
                <span className="text-[#D4AF37]">•</span>
                <span className="text-[#D4AF37] font-medium">Pinecone Cloud Storage</span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-3 self-end sm:self-auto">
            {/* Search Input */}
            <div className="relative w-48 sm:w-64">
              <Search
                className={`w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none ${
                  isLight ? "text-black/40" : "text-white/40"
                }`}
              />
              <input
                type="text"
                placeholder="Search records or city..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={`w-full pl-8 pr-8 py-1.5 rounded-full text-xs transition-all border outline-none ${
                  isLight
                    ? "bg-black/[0.04] border-black/10 text-black focus:border-[#7C3AED] focus:bg-white"
                    : "bg-white/[0.06] border-white/10 text-white focus:border-[#7C3AED] focus:bg-white/[0.1]"
                }`}
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              )}
            </div>

            <button
              onClick={onClose}
              aria-label="Close modal"
              className={`p-2 rounded-full transition-colors flex-shrink-0 ${
                isLight ? "text-black/60 hover:text-black hover:bg-black/5" : "text-white/60 hover:text-white hover:bg-white/10"
              }`}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Interactive Scrollable Table Area */}
        <div className="flex-1 overflow-auto relative">
          {loading ? (
            <div className="py-24 flex flex-col items-center justify-center space-y-3">
              <Loader2 className="w-8 h-8 animate-spin text-[#7C3AED]" />
              <p className={`text-xs font-mono ${isLight ? "text-black/50" : "text-white/50"}`}>
                Retrieving ledger page from Pinecone Cloud...
              </p>
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="py-24 text-center space-y-3">
              <div
                className={`w-12 h-12 rounded-2xl border flex items-center justify-center mx-auto ${
                  isLight ? "bg-black/5 border-black/10 text-black/40" : "bg-white/5 border-white/10 text-white/40"
                }`}
              >
                <TableIcon className="w-6 h-6" />
              </div>
              <p className="text-sm font-semibold">No records match your search</p>
              <p className={`text-xs max-w-sm mx-auto ${isLight ? "text-black/50" : "text-white/40"}`}>
                Try adjusting your search keywords or clear the filter to view all rows.
              </p>
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="mt-2 px-4 py-1.5 rounded-full bg-[#7C3AED] text-white font-semibold text-xs"
                >
                  Clear Search Filter
                </button>
              )}
            </div>
          ) : (
            <div className="min-w-full inline-block align-middle">
              <table className="w-full text-left text-xs border-collapse">
                <thead
                  className={`sticky top-0 z-10 border-b font-mono font-semibold uppercase tracking-wider text-[11px] backdrop-blur-md ${
                    isLight
                      ? "border-black/10 bg-white/90 text-black/70 shadow-sm"
                      : "border-white/10 bg-[#0F0E17]/95 text-white/70 shadow-sm"
                  }`}
                >
                  <tr>
                    <th className="px-4 py-3 text-center w-12 text-[10px] text-muted-foreground border-r border-transparent">
                      #
                    </th>
                    {data.columns.map((colName, cIdx) => {
                      const isAmount = /amount|price|balance|cost|fee|salary/i.test(colName);
                      return (
                        <th
                          key={cIdx}
                          className={`px-4 py-3 whitespace-nowrap ${isAmount ? "text-right" : "text-left"}`}
                        >
                          {colName}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className={`divide-y font-mono ${isLight ? "divide-black/5" : "divide-white/5"}`}>
                  {data.rows.map((row, rIdx) => {
                    const rowNum = (page - 1) * pageSize + rIdx + 1;
                    return (
                      <tr
                        key={rIdx}
                        className={`transition-colors ${
                          rIdx % 2 === 0
                            ? isLight
                              ? "bg-black/[0.01]"
                              : "bg-white/[0.01]"
                            : isLight
                            ? "bg-transparent"
                            : "bg-white/[0.03]"
                        } ${isLight ? "hover:bg-purple-500/10" : "hover:bg-purple-500/15"}`}
                      >
                        <td className="px-4 py-2.5 text-center text-[10px] text-muted-foreground tabular-numbers">
                          {rowNum}
                        </td>
                        {row.map((val, cIdx) => {
                          const colName = data.columns[cIdx] || "";
                          const isAmount = /amount|price|balance|cost|fee|salary/i.test(colName);
                          const isFraud = /fraud/i.test(colName);
                          const valStr = String(val ?? "").trim();

                          return (
                            <td
                              key={cIdx}
                              className={`px-4 py-2.5 whitespace-nowrap text-xs ${
                                isAmount
                                  ? "text-right font-semibold tabular-numbers text-[#10B981]"
                                  : isLight
                                  ? "text-black/80"
                                  : "text-white/80"
                              }`}
                            >
                              {isFraud && valStr.toLowerCase() === "yes" ? (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                                  FRAUD
                                </span>
                              ) : isFraud && valStr.toLowerCase() === "no" ? (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-400">
                                  Legit
                                </span>
                              ) : (
                                valStr || "—"
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer Controls & Pagination Bar */}
        <div
          className={`px-6 py-3.5 border-t flex flex-col sm:flex-row items-center justify-between gap-3 text-xs ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <div className="flex items-center space-x-2 text-muted-foreground text-[11px]">
            <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
            <span>
              {totalRows > 0 ? (
                <>
                  Showing records <strong className={isLight ? "text-black" : "text-white"}>{startRow}</strong> to{" "}
                  <strong className={isLight ? "text-black" : "text-white"}>{endRow}</strong> of{" "}
                  <strong className={isLight ? "text-black" : "text-white"}>{totalRows.toLocaleString()}</strong>
                </>
              ) : (
                "Verified sovereign record"
              )}
            </span>
          </div>

          {/* Pagination Buttons */}
          <div className="flex items-center space-x-1.5">
            <button
              onClick={() => setPage(1)}
              disabled={page <= 1 || loading}
              aria-label="First page"
              className={`p-1.5 rounded-lg border transition-all ${
                page <= 1 || loading
                  ? "opacity-30 cursor-not-allowed"
                  : isLight
                  ? "hover:bg-black/5 border-black/10"
                  : "hover:bg-white/10 border-white/10"
              }`}
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              aria-label="Previous page"
              className={`p-1.5 rounded-lg border transition-all ${
                page <= 1 || loading
                  ? "opacity-30 cursor-not-allowed"
                  : isLight
                  ? "hover:bg-black/5 border-black/10"
                  : "hover:bg-white/10 border-white/10"
              }`}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <span className="px-3 py-1 font-mono text-[11px] font-semibold">
              Page {page} of {totalPages}
            </span>

            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              aria-label="Next page"
              className={`p-1.5 rounded-lg border transition-all ${
                page >= totalPages || loading
                  ? "opacity-30 cursor-not-allowed"
                  : isLight
                  ? "hover:bg-black/5 border-black/10"
                  : "hover:bg-white/10 border-white/10"
              }`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page >= totalPages || loading}
              aria-label="Last page"
              className={`p-1.5 rounded-lg border transition-all ${
                page >= totalPages || loading
                  ? "opacity-30 cursor-not-allowed"
                  : isLight
                  ? "hover:bg-black/5 border-black/10"
                  : "hover:bg-white/10 border-white/10"
              }`}
            >
              <ChevronsRight className="w-4 h-4" />
            </button>

            <button
              onClick={onClose}
              className={`ml-4 px-4 py-1.5 rounded-full font-semibold text-xs transition-all shadow-md active:scale-95 ${
                isLight
                  ? "bg-[#581C87] text-white hover:bg-[#4C1D95]"
                  : "bg-white text-black hover:bg-white/90"
              }`}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
