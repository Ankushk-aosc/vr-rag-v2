export interface CitationItem {
  ref?: number | null;
  score?: number | null;
  chunk_id: string;
  document_id: string;
  document_name: string;
  page_number: number;
  section_title?: string | null;
  is_table?: boolean;
  snippet: string;
}

export interface FinancialMetric {
  label: string;
  value: string;
  currency: string;
  period?: string | null;
  change?: string | null;
}

export interface ThinkingStage {
  id?: string;
  title: string;
  duration_ms: number;
  status: "done" | "active" | "pending";
  details?: string | null;
}

export interface StructuredData {
  summary: string;
  key_findings: string[];
  metrics: FinancialMetric[];
  risk_factors: string[];
  disclaimer: string;
}

export interface DocumentRecord {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  file_hash: string;
  total_pages: number;
  family_entity_id: string;
  status: string;
  uploaded_at: string;
  columns?: string[];
  sample_rows?: string[][];
  preview_text?: string;
  is_table?: boolean;
}

export interface DocumentTableData {
  document_id: string;
  filename: string;
  columns: string[];
  rows: string[][];
  total_rows: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface ChatMessage {
  id: string;
  sender: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  citations?: CitationItem[];
  grounded?: boolean;
  audioBase64?: string | null;
  structured_data?: StructuredData | null;
  thinking_trace?: ThinkingStage[];
  total_latency_ms?: number;
  /** Model reasoning. The API never sends it (Audit I-10), so this stays empty; kept for older saved messages. */
  reasoning?: string;
  /** True while tokens are still arriving for this message. */
  streaming?: boolean;
  /** Passages retrieved for this answer (shown before the final citations arrive). */
  sources?: CitationItem[];
  mode?: "text" | "voice";
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export type VoicePhase = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

export interface FamilyEntity {
  id: string;
  name: string;
  entity_type: string;
}

// ---------------------------------------------------------------- dashboards

export interface DashboardKpi {
  label: string;
  value: number | null;
  display: string;
  sub?: string;
  unit?: string;
  tone?: "up" | "down" | null;
}

export interface DashboardSeries {
  name: string;
  column: string;
  unit: string;
  values: (number | null)[];
  agg?: string;
}

export type DashboardChartType = "line" | "area" | "bar" | "candlestick" | "diverging_bar";

export interface DashboardChart {
  id: string;
  type: DashboardChartType;
  title: string;
  x: string[];
  unit: string;
  series: DashboardSeries[];
  ohlc?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] };
  granularity: "day" | "week" | "month" | "quarter" | "year";
  highlight?: string | null;
}

export interface Dashboard {
  id: string;
  title: string;
  subtitle: string;
  question: string;
  created_at: number;
  plan_source: "ai" | "default" | "answer";
  source: {
    document_name: string;
    dataset_id: string | null;
    rows_used: number;
    x_start: string | null;
    x_end: string | null;
    columns: string[];
  };
  kpis: DashboardKpi[];
  charts: DashboardChart[];
  notes: string[];
}

export type DashboardStatus = { state: "loading" } | { state: "ready"; dashboardId: string } | { state: "error"; message: string };
