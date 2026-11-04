"use client";

import React, { useEffect, useRef, useState } from "react";
import { Upload, X, CheckCircle2, Loader2 } from "lucide-react";
import { DocumentRecord } from "../types";
import { uploadDocumentsWithProgress } from "../lib/api";
import { friendlyError } from "../lib/apiErrors";
import { FamilyRole, can } from "../lib/roles";
import { formatBytes } from "../lib/format";
import { ErrorState } from "./StateViews";

/** Mirrors the API's accepted types and size limit. These checks are a convenience; the server re-validates. */
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const ACCEPTED = [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md", ".png", ".jpg", ".jpeg", ".tiff", ".webp"];

interface DocumentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  documents: DocumentRecord[];
  onDocumentUploaded: () => void;
  selectedEntity: string;
  entityLabel?: string;
  role: FamilyRole;
  theme?: "dark" | "light";
}

interface Staged {
  file: File;
  problem: string | null;
}

function ext(name: string) {
  const m = /\.[^.]+$/.exec(name.toLowerCase());
  return m ? m[0] : "";
}

export function DocumentDrawer({
  isOpen,
  onClose,
  documents,
  onDocumentUploaded,
  selectedEntity,
  entityLabel,
  role,
  theme = "light",
}: DocumentDrawerProps) {
  const [staged, setStaged] = useState<Staged[]>([]);
  const [allowedRole, setAllowedRole] = useState("family_member");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: number; total: number; errors: string[] } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const uploading = progress !== null;

  // A closed drawer never keeps a transfer running
  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort();
      setStaged([]);
      setResult(null);
      setError(null);
      setProgress(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !uploading) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, uploading, onClose]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!isOpen) return null;
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const existingNames = new Set(documents.map((d) => d.original_name.toLowerCase()));

  const addFiles = (files: File[]) => {
    setResult(null);
    setError(null);
    setStaged((prev) => {
      const next = [...prev];
      for (const file of files) {
        if (next.some((s) => s.file.name === file.name && s.file.size === file.size)) continue;
        let problem: string | null = null;
        if (!ACCEPTED.includes(ext(file.name))) problem = "Unsupported file type";
        else if (file.size > MAX_FILE_SIZE) problem = "Larger than 100 MB";
        else if (file.size === 0) problem = "File is empty";
        else if (existingNames.has(file.name.toLowerCase())) problem = "Already in the vault";
        next.push({ file, problem });
      }
      return next;
    });
  };

  const ready = staged.filter((s) => !s.problem);

  const startUpload = async () => {
    if (!ready.length || uploading) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setResult(null);
    setProgress(0);
    try {
      const res = await uploadDocumentsWithProgress(
        ready.map((s) => s.file),
        selectedEntity,
        allowedRole,
        { onProgress: setProgress, signal: ctrl.signal }
      );
      setResult({ ok: res.successful_files, total: res.total_files, errors: res.errors || [] });
      setStaged([]);
      onDocumentUploaded();
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        setError("Upload cancelled. Files the server had already received may still appear in the vault.");
        onDocumentUploaded();
      } else {
        setError(friendlyError(err, "upload these documents").body);
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const btn = `h-9 px-3.5 rounded-md text-[13px] font-medium`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onMouseDown={() => !uploading && onClose()}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
        onMouseDown={(e) => e.stopPropagation()}
        className={`w-full max-w-lg h-full flex flex-col border-l shadow-xl focus:outline-none ${
          isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-700 text-slate-100"
        }`}
      >
        <div className={`px-5 py-4 border-b flex items-start justify-between gap-3 ${isLight ? "border-slate-200" : "border-slate-800"}`}>
          <div>
            <h2 id="upload-title" className="text-[16px] font-semibold">
              Upload documents
            </h2>
            <p className={`text-[13px] ${muted}`}>To {entityLabel || "this family entity"}</p>
          </div>
          <button
            onClick={onClose}
            disabled={uploading}
            aria-label="Close upload panel"
            className={`p-1.5 rounded disabled:opacity-40 ${isLight ? "text-slate-500 hover:bg-slate-100" : "text-slate-400 hover:bg-slate-800"}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!can.upload(role) ? (
            <ErrorState
              theme={theme}
              title="Uploads are not available for your role"
              body="Read-only advisers can view and query documents but cannot add them. Ask a family admin or member to upload."
            />
          ) : (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (!uploading) addFiles(Array.from(e.dataTransfer.files || []));
                }}
                className={`rounded-md border-2 border-dashed p-6 text-center ${
                  isDragging ? "border-blue-500 bg-blue-50/60" : isLight ? "border-slate-300" : "border-slate-700"
                }`}
              >
                <p className="text-[14px] font-medium">Drag files here, or</p>
                <input
                  ref={inputRef}
                  id="doc-upload-input"
                  type="file"
                  multiple
                  accept={ACCEPTED.join(",")}
                  disabled={uploading}
                  onChange={(e) => addFiles(Array.from(e.target.files || []))}
                  className="sr-only"
                />
                <label
                  htmlFor="doc-upload-input"
                  className={`${btn} mt-2 inline-flex items-center gap-1.5 border cursor-pointer ${
                    isLight ? "border-slate-300 hover:bg-slate-50" : "border-slate-600 hover:bg-slate-800"
                  } ${uploading ? "opacity-50 pointer-events-none" : ""}`}
                >
                  <Upload className="w-4 h-4" aria-hidden /> Choose files
                </label>
                <p className={`text-[12px] mt-3 ${muted}`}>PDF, Word (.docx), Excel (.xlsx), CSV, text and scanned images. Up to 100 MB each.</p>
              </div>

              {staged.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <h3 className="text-[13px] font-semibold">Selected ({staged.length})</h3>
                    {!uploading && (
                      <button type="button" onClick={() => setStaged([])} className={`text-[12px] ${muted} hover:underline`}>
                        Clear
                      </button>
                    )}
                  </div>
                  <ul className={`divide-y rounded-md border ${isLight ? "divide-slate-100 border-slate-200" : "divide-slate-800 border-slate-800"}`}>
                    {staged.map((s, i) => (
                      <li key={`${s.file.name}-${i}`} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{s.file.name}</span>
                          <span className={`block text-[12px] ${s.problem ? "text-rose-600" : muted}`}>
                            {s.problem ? `${s.problem} — will be skipped` : formatBytes(s.file.size)}
                          </span>
                        </span>
                        {!uploading && (
                          <button
                            type="button"
                            onClick={() => setStaged((prev) => prev.filter((_, j) => j !== i))}
                            aria-label={`Remove ${s.file.name}`}
                            className={`p-1 rounded ${isLight ? "text-slate-400 hover:bg-slate-100" : "text-slate-500 hover:bg-slate-800"}`}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {can.delete(role) && (
                <label className="block">
                  <span className="text-[13px] font-medium">Who can see these documents</span>
                  <select
                    value={allowedRole}
                    disabled={uploading}
                    onChange={(e) => setAllowedRole(e.target.value)}
                    className={`mt-1 block w-full h-9 rounded-md border px-2 text-[13px] ${
                      isLight ? "bg-white border-slate-300" : "bg-slate-900 border-slate-700"
                    }`}
                  >
                    <option value="family_member">All members of this family entity</option>
                    <option value="family_admin">Family admins only</option>
                  </select>
                </label>
              )}

              {uploading && (
                <div role="status" aria-live="polite">
                  <div className="flex items-center justify-between text-[13px] mb-1.5">
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-blue-600" aria-hidden />
                      {progress! < 1 ? "Uploading…" : "Extracting and indexing on the server…"}
                    </span>
                    {progress! < 1 && <span className="tabular-nums">{Math.round(progress! * 100)}%</span>}
                  </div>
                  <div
                    className={`h-1.5 rounded-full overflow-hidden ${isLight ? "bg-slate-200" : "bg-slate-800"}`}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress! * 100)}
                  >
                    <div className="h-full bg-[#2563EB] transition-[width]" style={{ width: `${Math.round(progress! * 100)}%` }} />
                  </div>
                </div>
              )}

              {error && <ErrorState theme={theme} title="Upload incomplete" body={error} compact />}

              {result && (
                <div
                  role="status"
                  className={`rounded-md border p-3 text-[13px] ${
                    result.errors.length
                      ? isLight
                        ? "border-amber-200 bg-amber-50 text-amber-900"
                        : "border-amber-800 bg-amber-950/30 text-amber-200"
                      : isLight
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : "border-emerald-800 bg-emerald-950/30 text-emerald-200"
                  }`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    <CheckCircle2 className="w-4 h-4" aria-hidden />
                    {result.ok} of {result.total} file{result.total === 1 ? "" : "s"} indexed
                  </div>
                  {result.errors.length > 0 && (
                    <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
                      {result.errors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {can.upload(role) && (
          <div className={`px-5 py-3 border-t flex justify-end gap-2 ${isLight ? "border-slate-200" : "border-slate-800"}`}>
            {uploading ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className={`${btn} border ${isLight ? "border-slate-300 hover:bg-slate-50" : "border-slate-600 hover:bg-slate-800"}`}
              >
                Cancel upload
              </button>
            ) : (
              <button type="button" onClick={onClose} className={`${btn} border ${isLight ? "border-slate-300 hover:bg-slate-50" : "border-slate-600 hover:bg-slate-800"}`}>
                Close
              </button>
            )}
            <button
              type="button"
              onClick={startUpload}
              disabled={!ready.length || uploading}
              className={`${btn} bg-[#2563EB] text-white hover:bg-[#1D4ED8] disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              Upload {ready.length ? `${ready.length} file${ready.length === 1 ? "" : "s"}` : ""}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
