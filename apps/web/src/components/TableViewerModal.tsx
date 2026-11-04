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
  const [loadFailed, setLoadFailed] = useState(false);
  const [isSample, setIsSample] = useState(false);
  const [retry, setRetry] = useState(0);
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
    setLoadFailed(false);
    setIsSample(false);

    fetchDocumentTable(document.id, page, pageSize, debouncedSearch).then((res) => {
      if (!cancelled) {
        if (res) {
          setData(res);
        } else if (document.columns?.length && document.sample_rows?.length) {
          // Full table unavailable: show the stored sample, clearly labelled as such
          setLoadFailed(true);
          setIsSample(true);
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
        } else {
          setLoadFailed(true);
          setData(null);
        }
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [document, page, pageSize, debouncedSearch, retry]);

  useEffect(() => {
    if (!document) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [document, onClose]);

  if (!document) return null;

  const totalRows = data?.total_rows ?? 0;
  const totalPages = data?.total_pages ?? 1;
  const rowsHere = data?.rows.length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-900/40">
      <div
        className={`w-full max-w-6xl rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[92vh] border transition-all ${
          isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-700 text-slate-100"
        }`}
      >
        {/* Header Bar */}
        <div
          className={`flex flex-col sm:flex-row sm:items-center justify-between px-6 py-4 border-b gap-3 ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <div className="flex items-center space-x-3 min-w-0">
            <div className="min-w-0">
              <h3 className="font-semibold text-[16px] tracking-tight truncate" title={document.original_name}>
                {document.original_name}
              </h3>
              <div className="flex items-center space-x-2 text-xs">
                <span className={`font-mono ${isLight ? "text-black/50" : "text-white/50"}`}>
                  {totalPages > 1 ? `Page ${page} of ${totalPages}` : "Table"}
                </span>
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
                    ? "bg-black/[0.04] border-black/10 text-black focus:border-[#2563EB] focus:bg-white"
                    : "bg-white/[0.06] border-white/10 text-white focus:border-[#2563EB] focus:bg-white/[0.1]"
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
              <Loader2 className="w-6 h-6 animate-spin text-[#2563EB]" aria-hidden />
              <p className={`text-xs font-mono ${isLight ? "text-black/50" : "text-white/50"}`}>
                Loading rows…
              </p>
            </div>
          ) : loadFailed && !data ? (
            <div className="py-20 px-6 text-center" role="alert">
              <p className="text-sm font-semibold">We couldn&apos;t load this table</p>
              <p className={`text-[13px] mt-1 ${isLight ? "text-slate-500" : "text-slate-400"}`}>
                The financial intelligence service is temporarily unavailable.
              </p>
              <button
                onClick={() => setRetry((n) => n + 1)}
                className="mt-3 h-9 px-3.5 rounded-md bg-[#2563EB] text-white text-[13px] font-medium"
              >
                Try again
              </button>
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
                  className="mt-2 px-4 py-1.5 rounded-full bg-[#2563EB] text-white font-semibold text-xs"
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
                        } ${isLight ? "hover:bg-slate-50" : "hover:bg-slate-800/50"}`}
                      >
                        <td className="px-4 py-2.5 text-center text-[10px] text-muted-foreground tabular-numbers">
                          {rowNum}
                        </td>
                        {row.map((val, cIdx) => {
                          const colName = data.columns[cIdx] || "";
                          const isAmount = /amount|price|balance|cost|fee|salary/i.test(colName);
                          const valStr = String(val ?? "").trim();

                          return (
                            <td
                              key={cIdx}
                              className={`px-4 py-2.5 whitespace-nowrap text-xs ${
                                isAmount
                                  ? "text-right tabular-numbers"
                                  : isLight
                                  ? "text-black/80"
                                  : "text-white/80"
                              }`}
                            >
                              {valStr || "—"}
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
            <span>
              {isSample ? (
                <span className="text-amber-700">Full table unavailable. Showing the {totalRows}-row sample stored at upload.</span>
              ) : rowsHere > 0 ? (
                <>
                  {rowsHere.toLocaleString()} row{rowsHere === 1 ? "" : "s"} on this page
                  {debouncedSearch && totalRows > rowsHere ? ` · ${totalRows.toLocaleString()} matches in total` : ""}
                </>
              ) : (
                "No rows"
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
                  ? "bg-[#2563EB] text-white hover:bg-[#1D4ED8]"
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
