/**
 * Chart palette + formatting shared by the 2D (Recharts) and 3D (three.js) dashboard renderers.
 *
 * Colours are the validated reference palette (scripts/validate_palette.js, light surface #fcfcfb
 * and dark surface #1a1a19, all checks pass): slot 1 blue for single series, blue <-> red as the
 * diverging pair for signed changes (gains / losses), a de-emphasis gray for "emphasis" charts.
 * Text always uses ink tokens, never a series colour.
 */
import { DashboardChart } from "../../types";

export interface ChartTheme {
  surface: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  grid: string;
  axis: string;
  border: string;
  series: [string, string, string];
  positive: string;
  negative: string;
  deemphasis: string;
}

export const CHART_THEMES: Record<"light" | "dark", ChartTheme> = {
  light: {
    surface: "#fcfcfb",
    textPrimary: "#0b0b0b",
    textSecondary: "#52514e",
    textMuted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    border: "rgba(11,11,11,0.10)",
    series: ["#2a78d6", "#eb6834", "#1baf7a"],
    positive: "#2a78d6",
    negative: "#e34948",
    deemphasis: "#c3c2b7",
  },
  dark: {
    surface: "#1a1a19",
    textPrimary: "#f0efec",
    textSecondary: "#c3c2b7",
    textMuted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    border: "rgba(255,255,255,0.10)",
    series: ["#3987e5", "#d95926", "#199e70"],
    positive: "#3987e5",
    negative: "#e66767",
    deemphasis: "#4a4945",
  },
};

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return a >= 100 ? v.toFixed(0) : v.toFixed(2);
}

/** Full-precision value for tooltips and tables. */
export function formatValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (unit === "$") return Math.abs(v) >= 1e6 ? `$${compact(v)}` : `$${v.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (unit === "%") return `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) > 0 && Math.abs(v) < 0.1 ? 3 : 2)}%`;
  return Math.abs(v) >= 1e4 ? compact(v) : v.toLocaleString("en-AU", { maximumFractionDigits: 2 });
}

/** Short value for axis ticks (clean, compact from 1,000 up). */
export function formatTick(v: number, unit: string): string {
  if (unit === "%") return `${v > 0 ? "+" : ""}${Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
  const s = Math.abs(v) >= 1000 ? compact(v).replace(/\.0(?=[KMBT])/, "") : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2);
  return unit === "$" ? `$${s}` : s;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis/tooltip label for an x value at the chart's granularity. */
export function formatX(x: string, granularity: DashboardChart["granularity"], long = false): string {
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(x);
  if (!iso) return x; // "2020 Q2", "2020", categories
  const [, y, m, d] = iso;
  const mon = MONTHS[Number(m) - 1];
  if (granularity === "month" || !d) return long ? `${mon} ${y}` : `${mon} ${y.slice(2)}`;
  if (long) return `${Number(d)} ${mon} ${y}`;
  return granularity === "week" ? `${Number(d)} ${mon} ${y.slice(2)}` : `${Number(d)} ${mon}`;
}

/** Rows for tables / Recharts, one per x position. */
export function chartRows(chart: DashboardChart) {
  return chart.x.map((x, i) => {
    const row: Record<string, number | string | null | [number, number]> = { x };
    chart.series.forEach((s) => {
      row[s.column] = s.values[i] ?? null;
    });
    if (chart.ohlc) {
      const o = chart.ohlc.open[i];
      const h = chart.ohlc.high[i];
      const l = chart.ohlc.low[i];
      const c = chart.ohlc.close[i];
      row.open = o;
      row.high = h;
      row.low = l;
      row.close = c;
      row.range = l !== null && h !== null ? [l, h] : null;
    }
    return row;
  });
}
