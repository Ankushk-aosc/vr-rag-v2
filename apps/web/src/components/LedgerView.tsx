"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Search, Upload, Trash2, Loader2 } from "lucide-react";
import { DocumentRecord } from "../types";
import { deleteDocument } from "../lib/api";
import { friendlyError } from "../lib/apiErrors";
import { FamilyRole, can } from "../lib/roles";
import { fileExtension, formatBytes, formatDateTime, isTabularDoc } from "../lib/format";
import { EmptyState, ErrorState, SkeletonRows } from "./StateViews";
import { ConfirmDialog } from "./ConfirmDialog";

interface LedgerViewProps {
  documents: DocumentRecord[];
  selectedEntity: string;
  entityLabel?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  role: FamilyRole;
  onOpenUpload: () => void;
  onSelectDocument: (doc: DocumentRecord) => void;
  onDocumentsChanged: () => void;
  theme?: "dark" | "light";
}

const PAGE_SIZES = [10, 25, 50];

const STATUS_LABEL: Record<string, { label: string; tone: "ok" | "busy" | "bad" }> = {
  indexed: { label: "Indexed", tone: "ok" },
  processed: { label: "Indexed", tone: "ok" },
  pending: { label: "Processing", tone: "busy" },
  processing: { label: "Processing", tone: "busy" },
  failed: { label: "Failed", tone: "bad" },
  error: { label: "Failed", tone: "bad" },
};

function StatusBadge({ status, isLight }: { status: string; isLight: boolean }) {
  const s = STATUS_LABEL[status] || { label: status || "Unknown", tone: "busy" as const };
  const dot = s.tone === "ok" ? "bg-emerald-600" : s.tone === "bad" ? "bg-rose-600" : "bg-amber-500";
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] ${isLight ? "text-slate-700" : "text-slate-300"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

export function LedgerView({
  documents,
  entityLabel,
  loading = false,
  error = null,
  onRetry,
  role,
  onOpenUpload,
  onSelectDocument,
  onDocumentsChanged,
  theme = "light",
}: LedgerViewProps) {
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const types = useMemo(() => Array.from(new Set(documents.map((d) => fileExtension(d.original_name)))).sort(), [documents]);
  const statuses = useMemo(
    () => Array.from(new Set(documents.map((d) => STATUS_LABEL[d.status]?.label || d.status))).sort(),
    [documents]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return documents
      .filter((d) => typeFilter === "ALL" || fileExtension(d.original_name) === typeFilter)
      .filter((d) => statusFilter === "ALL" || (STATUS_LABEL[d.status]?.label || d.status) === statusFilter)
      .filter((d) => !q || d.original_name.toLowerCase().includes(q) || (d.columns || []).some((c) => c.toLowerCase().includes(q)))
      .sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || ""));
  }, [documents, query, typeFilter, statusFilter]);

  useEffect(() => setPage(1), [query, typeFilter, statusFilter, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDocument(pendingDelete.id);
      setPendingDelete(null);
      onDocumentsChanged();
    } catch (err) {
      setDeleteError(friendlyError(err, "delete this document").body);
    } finally {
      setDeleting(false);
    }
  };

  const control = `h-9 rounded-md border px-3 text-[13px] ${
    isLight ? "bg-white border-slate-300 text-slate-900" : "bg-slate-900 border-slate-700 text-slate-100"
  }`;
  const th = `px-4 py-2.5 text-left text-[12px] font-semibold ${muted}`;
  const td = "px-4 py-3 text-[13px] align-top";

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-28">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Ledger Vault</h1>
          <p className={`text-[14px] mt-1 ${muted}`}>
            Financial records authorised for {entityLabel || "this family entity"}. Aether answers only from these documents.
          </p>
        </div>
        {can.upload(role) && (
          <button
            type="button"
            onClick={onOpenUpload}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-[#2563EB] text-white text-[13px] font-medium hover:bg-[#1D4ED8]"
          >
            <Upload className="w-4 h-4" aria-hidden /> Upload documents
          </button>
        )}
      </div>

      {error ? (
        <ErrorState theme={theme} title="We couldn't load your documents" body={error} onRetry={onRetry} />
      ) : loading && !documents.length ? (
        <SkeletonRows rows={5} theme={theme} />
      ) : !documents.length ? (
        <EmptyState
          theme={theme}
          title="No authorised documents yet"
          body={
            can.upload(role)
              ? "Upload financial records to begin building your family-office knowledge base. PDF, Word, Excel, CSV and text files are supported."
              : "No records have been shared with this family entity yet. Your role is read-only; a family admin or member can add documents."
          }
          action={
            can.upload(role) ? (
              <button
                type="button"
                onClick={onOpenUpload}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-[#2563EB] text-white text-[13px] font-medium hover:bg-[#1D4ED8]"
              >
                <Upload className="w-4 h-4" aria-hidden /> Upload documents
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className={`w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 ${muted}`} aria-hidden />
              <label htmlFor="ledger-search" className="sr-only">
                Search documents
              </label>
              <input
                id="ledger-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or column"
                className={`${control} w-full pl-9`}
              />
            </div>
            <label className="sr-only" htmlFor="ledger-type">
              File type
            </label>
            <select id="ledger-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={control}>
              <option value="ALL">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="ledger-status">
              Processing status
            </label>
            <select id="ledger-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={control}>
              <option value="ALL">All statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className={`ml-auto text-[13px] ${muted}`}>
              {filtered.length} of {documents.length} document{documents.length === 1 ? "" : "s"}
            </span>
          </div>

          {deleteError && (
            <div className="mb-3">
              <ErrorState theme={theme} title="Document not deleted" body={deleteError} compact />
            </div>
          )}

          <div className={`rounded-md border overflow-x-auto ${isLight ? "bg-white border-slate-200" : "bg-slate-900/40 border-slate-800"}`}>
            <table className="w-full min-w-[720px]">
              <caption className="sr-only">Authorised documents</caption>
              <thead className={`border-b ${isLight ? "bg-slate-50 border-slate-200" : "bg-slate-900 border-slate-800"}`}>
                <tr>
                  <th scope="col" className={th}>Document</th>
                  <th scope="col" className={th}>Type</th>
                  <th scope="col" className={`${th} text-right`}>Pages / sheets</th>
                  <th scope="col" className={`${th} text-right`}>Size</th>
                  <th scope="col" className={th}>Uploaded</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={`${th} text-right`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isLight ? "divide-slate-100" : "divide-slate-800"}`}>
                {visible.map((doc) => (
                  <tr key={doc.id} className={isLight ? "hover:bg-slate-50" : "hover:bg-slate-800/40"}>
                    <td className={td}>
                      <button
                        type="button"
                        onClick={() => onSelectDocument(doc)}
                        className={`font-medium text-left hover:underline break-all ${isLight ? "text-[#0A2540]" : "text-white"}`}
                      >
                        {doc.original_name}
                      </button>
                      {isTabularDoc(doc) && doc.columns && doc.columns.length > 0 && (
                        <div className={`text-[12px] mt-0.5 truncate max-w-[340px] ${muted}`} title={doc.columns.join(", ")}>
                          {doc.columns.length} columns: {doc.columns.slice(0, 4).join(", ")}
                          {doc.columns.length > 4 ? "…" : ""}
                        </div>
                      )}
                    </td>
                    <td className={`${td} font-mono text-[12px] ${muted}`}>{fileExtension(doc.original_name)}</td>
                    <td className={`${td} text-right tabular-nums`}>{doc.total_pages || "—"}</td>
                    <td className={`${td} text-right tabular-nums`}>{formatBytes(doc.file_size)}</td>
                    <td className={`${td} whitespace-nowrap ${muted}`}>{formatDateTime(doc.uploaded_at)}</td>
                    <td className={td}>
                      <StatusBadge status={doc.status} isLight={isLight} />
                    </td>
                    <td className={`${td} text-right whitespace-nowrap`}>
                      <button
                        type="button"
                        onClick={() => onSelectDocument(doc)}
                        className="text-[13px] font-medium text-blue-700 dark:text-blue-400 hover:underline"
                      >
                        {isTabularDoc(doc) ? "View table" : "Preview"}
                      </button>
                      {can.delete(role) && (
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setPendingDelete(doc);
                          }}
                          aria-label={`Delete ${doc.original_name}`}
                          title="Delete document"
                          className={`ml-3 p-1 rounded align-middle ${isLight ? "text-slate-400 hover:text-rose-600 hover:bg-rose-50" : "text-slate-500 hover:text-rose-400"}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr>
                    <td colSpan={7} className={`px-4 py-8 text-center text-[13px] ${muted}`}>
                      No documents match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className={`flex flex-wrap items-center justify-between gap-3 mt-3 text-[13px] ${muted}`}>
            <label className="flex items-center gap-2">
              Rows per page
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className={`${control} h-8 px-2`}>
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              {loading && <Loader2 className="w-4 h-4 animate-spin" aria-label="Refreshing" />}
              <span className="tabular-nums">
                Page {page} of {pageCount}
              </span>
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={`${control} h-8 disabled:opacity-40`}>
                Previous
              </button>
              <button type="button" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)} className={`${control} h-8 disabled:opacity-40`}>
                Next
              </button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        theme={theme}
        title="Delete this document?"
        body={
          pendingDelete
            ? `"${pendingDelete.original_name}" and its indexed passages will be permanently removed from this family's vault. Answers will no longer cite it.`
            : ""
        }
        confirmLabel={deleting ? "Deleting…" : "Delete document"}
        destructive
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
