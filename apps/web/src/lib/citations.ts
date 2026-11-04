import { CitationItem } from "../types";

const SPREADSHEET = /\.(xlsx|xls|csv)$/i;

/**
 * The extractor writes "### Sheet: <name> (Rows a to b)" on its own line. Snippets sometimes arrive
 * with newlines collapsed, in which case the header row follows on the same line; then only the first
 * token is trusted as the name.
 */
function sheetName(snippet: string): string | null {
  const m = /Sheet:\s*([^\n]+)/.exec(snippet);
  if (!m) return null;
  let line = m[1].replace(/\s*\(Rows[^)]*\)?.*/, "").trim();
  if (/[|]/.test(m[1]) || !snippet.includes("\n")) line = line.split(/\s+/)[0];
  return line.replace(/[#|]+$/, "").trim() || null;
}

/**
 * Where in the source a citation points, built only from the metadata the backend returned:
 * "Sheet: Holdings" for spreadsheets (the extractor prefixes each sheet's text with its name),
 * otherwise "Page 14" with "· Table" for table chunks.
 */
export function citationLocation(c: CitationItem): string {
  if (SPREADSHEET.test(c.document_name)) {
    const sheet = sheetName(c.snippet || "");
    if (sheet) return `Sheet: ${sheet}`;
    return c.page_number ? `Sheet ${c.page_number}` : "Spreadsheet";
  }
  const parts: string[] = [];
  if (c.page_number) parts.push(`Page ${c.page_number}`);
  if (c.is_table) parts.push("Table");
  return parts.join(" · ") || "Document";
}

/** Two-digit position label ("01") for an evidence list, from the backend ref when present. */
export function citationIndex(c: CitationItem, i: number): string {
  return String(c.ref ?? i + 1).padStart(2, "0");
}

/** The citations to show for an answer: final citations once the answer is done, retrieved passages before. */
export function answerSources(msg: { citations?: CitationItem[]; sources?: CitationItem[] } | null | undefined): CitationItem[] {
  if (!msg) return [];
  return (msg.citations && msg.citations.length ? msg.citations : msg.sources) || [];
}

/** Distinct documents behind a set of citations. */
export function distinctDocuments(cites: CitationItem[]): number {
  return new Set(cites.map((c) => c.document_id || c.document_name)).size;
}
