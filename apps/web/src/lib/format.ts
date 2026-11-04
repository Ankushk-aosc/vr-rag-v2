import { DocumentRecord } from "../types";

/** Backend timestamps are UTC, sometimes without a zone suffix ("2026-11-03 17:40:02"). */
function parseUtc(ts: string): Date | null {
  if (!ts) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(ts: string): string {
  const d = parseUtc(ts);
  if (!d) return ts || "—";
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "DOCUMENT_UPLOAD_SUCCESS" → "Document upload success" */
export function humanizeAction(action: string): string {
  const s = (action || "").replace(/[_.]+/g, " ").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : "Event";
}

export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toUpperCase() : "FILE";
}

export function isTabularDoc(doc: DocumentRecord): boolean {
  return Boolean(doc.is_table || doc.columns?.length || /\.(csv|xlsx|xls)$/i.test(doc.original_name));
}
