"use client";

import React, { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Table2, LineChart as LineIcon } from "lucide-react";
import { Dashboard, DashboardChart, DashboardKpi } from "../types";
import { CHART_THEMES, ChartTheme, chartRows, formatTick, formatValue, formatX } from "../lib/charts/chartTheme";

const CHART_HEIGHT = 210;

function KpiTile({ kpi, t }: { kpi: DashboardKpi; t: ChartTheme }) {
  const toneColor = kpi.tone === "up" ? t.positive : kpi.tone === "down" ? t.negative : null;
  return (
    <div className="rounded-xl border px-3.5 py-3 min-w-0" style={{ background: t.surface, borderColor: t.border }}>
      <div className="text-[11px] truncate" style={{ color: t.textSecondary }}>
        {kpi.label}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        {toneColor && (
          <span aria-hidden className="text-[11px] leading-none" style={{ color: toneColor }}>
            {kpi.tone === "up" ? "▲" : "▼"}
          </span>
        )}
        <span className="text-[22px] font-semibold leading-tight truncate" style={{ color: t.textPrimary }}>
          {kpi.display}
        </span>
      </div>
      {kpi.sub && (
        <div className="text-[10.5px] mt-0.5 truncate" title={kpi.sub} style={{ color: t.textMuted }}>
          {kpi.sub}
        </div>
      )}
    </div>
  );
}

function ChartTooltip({ active, payload, label, chart, t }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const lines: { name: string; value: string; color: string }[] =
    chart.type === "candlestick"
      ? [
          ["Open", row.open],
          ["High", row.high],
          ["Low", row.low],
          ["Close", row.close],
        ].map(([n, v]) => ({
          name: n as string,
          value: formatValue(v as number, "$"),
          color: (row.close ?? 0) >= (row.open ?? 0) ? t.positive : t.negative,
        }))
      : chart.series.map((s: any, i: number) => {
          const v = row[s.column];
          const color = chart.type === "diverging_bar" ? (v >= 0 ? t.positive : t.negative) : t.series[i % 3];
          return { name: s.name, value: formatValue(v, s.unit), color };
        });
  return (
    <div
      className="rounded-lg border px-2.5 py-2 shadow-lg text-[11px] min-w-[120px]"
      style={{ background: t.surface, borderColor: t.border, color: t.textPrimary }}
    >
      <div className="mb-1" style={{ color: t.textMuted }}>
        {formatX(label, chart.granularity, true)}
      </div>
      {lines.map((l) => (
        <div key={l.name} className="flex items-center gap-2">
          <span aria-hidden className="inline-block w-3 h-[2px] rounded" style={{ background: l.color }} />
          <span className="font-semibold tabular-nums">{l.value}</span>
          <span style={{ color: t.textSecondary }}>{l.name}</span>
        </div>
      ))}
    </div>
  );
}

/** A bar with a 4px rounded data end (top for gains, bottom for losses) and a square baseline. */
function DataEndBar(props: any) {
  const { x, y, width, height, fill, negative } = props;
  if (width === undefined || height === undefined || !width) return null;
  const top = Math.min(y, y + height);
  const h = Math.abs(height);
  if (h < 0.5) return null;
  const r = Math.min(4, width / 2, h);
  const right = x + width;
  const bottom = top + h;
  const d = negative
    ? `M${x},${top} L${right},${top} L${right},${bottom - r} Q${right},${bottom} ${right - r},${bottom} L${x + r},${bottom} Q${x},${bottom} ${x},${bottom - r} Z`
    : `M${x},${bottom} L${x},${top + r} Q${x},${top} ${x + r},${top} L${right - r},${top} Q${right},${top} ${right},${top + r} L${right},${bottom} Z`;
  return <path d={d} fill={fill} />;
}

/** Candle drawn inside the [low, high] range bar Recharts lays out for us. */
function Candle(props: any) {
  const { x, y, width, height, payload, t } = props;
  const { open, close, high, low } = payload;
  if ([open, close, high, low].some((v: any) => v === null || v === undefined) || height === undefined) return null;
  const span = high - low || 1;
  const yAt = (v: number) => y + ((high - v) / span) * height;
  const up = close >= open;
  const color = up ? t.positive : t.negative;
  const bodyW = Math.max(2, Math.min(width * 0.7, 24));
  const cx = x + width / 2;
  const top = yAt(Math.max(open, close));
  const bodyH = Math.max(1.5, Math.abs(yAt(open) - yAt(close)));
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1.25} />
      <rect x={cx - bodyW / 2} y={top} width={bodyW} height={bodyH} rx={Math.min(2, bodyW / 4)} fill={color} />
    </g>
  );
}

function ChartTable({ chart, t }: { chart: DashboardChart; t: ChartTheme }) {
  const rows = chartRows(chart);
  const cols = chart.type === "candlestick" ? ["open", "high", "low", "close"] : chart.series.map((s) => s.column);
  const names = chart.type === "candlestick" ? ["Open", "High", "Low", "Close"] : chart.series.map((s) => s.name);
  const units = chart.type === "candlestick" ? ["$", "$", "$", "$"] : chart.series.map((s) => s.unit);
  return (
    <div className="overflow-auto rounded-lg border" style={{ height: CHART_HEIGHT, borderColor: t.border }}>
      <table className="w-full text-[11px] tabular-nums">
        <thead className="sticky top-0" style={{ background: t.surface }}>
          <tr>
            <th className="text-left px-2 py-1.5 font-semibold" style={{ color: t.textSecondary }}>
              {chart.granularity === "day" ? "Date" : chart.granularity}
            </th>
            {names.map((n) => (
              <th key={n} className="text-right px-2 py-1.5 font-semibold" style={{ color: t.textSecondary }}>
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.x)} className="border-t" style={{ borderColor: t.grid, fontWeight: r.x === chart.highlight ? 600 : 400 }}>
              <td className="px-2 py-1" style={{ color: t.textPrimary }}>
                {formatX(String(r.x), chart.granularity, true)}
              </td>
              {cols.map((c, i) => (
                <td key={c} className="text-right px-2 py-1" style={{ color: t.textPrimary }}>
                  {formatValue(r[c] as number, units[i])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartCard({ chart, t }: { chart: DashboardChart; t: ChartTheme }) {
  const [showTable, setShowTable] = useState(false);
  const rows = useMemo(() => chartRows(chart), [chart]);
  const unit = chart.type === "candlestick" ? "$" : chart.unit;
  const hl = chart.highlight || undefined;
  const axisProps = {
    stroke: t.axis,
    tick: { fill: t.textMuted, fontSize: 10.5 },
    tickLine: false,
  };
  const xAxis = (
    <XAxis
      dataKey="x"
      {...axisProps}
      minTickGap={28}
      tickFormatter={(x: string) => formatX(x, chart.granularity)}
    />
  );
  const yAxis = (
    <YAxis
      {...axisProps}
      axisLine={false}
      width={54}
      domain={chart.type === "bar" ? [0, "auto"] : ["auto", "auto"]}
      tickFormatter={(v: number) => formatTick(v, unit)}
    />
  );
  const grid = <CartesianGrid stroke={t.grid} strokeWidth={1} vertical={false} />;
  const tooltip = (cursor: any) => <Tooltip cursor={cursor} content={<ChartTooltip chart={chart} t={t} />} />;
  const focusLine = hl ? <ReferenceLine x={hl} stroke={t.textMuted} strokeWidth={1} /> : null;
  const margin = { top: 6, right: 8, bottom: 0, left: 0 };

  let body: React.ReactNode;
  if (chart.type === "line" || chart.type === "area") {
    const Chart = chart.type === "area" ? AreaChart : LineChart;
    body = (
      <Chart data={rows} margin={margin}>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip({ stroke: t.axis, strokeWidth: 1 })}
        {focusLine}
        {chart.series.map((s, i) =>
          chart.type === "area" ? (
            <Area key={s.column} type="monotone" dataKey={s.column} name={s.name} stroke={t.series[i % 3]} strokeWidth={2}
              fill={t.series[i % 3]} fillOpacity={0.1} dot={false} isAnimationActive={false} connectNulls
              activeDot={{ r: 4, stroke: t.surface, strokeWidth: 2 }} />
          ) : (
            <Line key={s.column} type="monotone" dataKey={s.column} name={s.name} stroke={t.series[i % 3]} strokeWidth={2}
              dot={false} isAnimationActive={false} connectNulls strokeLinecap="round" strokeLinejoin="round"
              activeDot={{ r: 4, stroke: t.surface, strokeWidth: 2 }} />
          )
        )}
      </Chart>
    );
  } else if (chart.type === "candlestick") {
    body = (
      <BarChart data={rows} margin={margin} barCategoryGap="15%">
        {grid}
        {xAxis}
        {yAxis}
        {tooltip({ fill: t.grid, fillOpacity: 0.5 })}
        {focusLine}
        <Bar dataKey="range" isAnimationActive={false} shape={(p: any) => <Candle {...p} t={t} />} />
      </BarChart>
    );
  } else {
    const s = chart.series[0];
    body = (
      <BarChart data={rows} margin={margin} barCategoryGap={rows.length > 60 ? "8%" : "20%"}>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip({ fill: t.grid, fillOpacity: 0.5 })}
        {chart.type === "diverging_bar" && <ReferenceLine y={0} stroke={t.axis} strokeWidth={1} />}
        <Bar
          dataKey={s.column}
          name={s.name}
          maxBarSize={24}
          isAnimationActive={false}
          shape={(p: any) => {
            const v = (p.payload?.[s.column] ?? 0) as number;
            const fill =
              chart.type === "diverging_bar"
                ? v >= 0 ? t.positive : t.negative
                : hl && p.payload?.x !== hl ? t.deemphasis : t.series[0];
            return <DataEndBar {...p} fill={fill} negative={v < 0} />;
          }}
        />
      </BarChart>
    );
  }

  const legend =
    chart.series.length > 1 && chart.type !== "candlestick" ? (
      <div className="flex items-center gap-3 text-[10.5px]" style={{ color: t.textSecondary }}>
        {chart.series.map((s, i) => (
          <span key={s.column} className="flex items-center gap-1">
            <span aria-hidden className="inline-block w-3 h-[2px] rounded" style={{ background: t.series[i % 3] }} />
            {s.name}
          </span>
        ))}
      </div>
    ) : null;

  return (
    <figure className="rounded-xl border p-3 min-w-0" style={{ background: t.surface, borderColor: t.border }}>
      <figcaption className="flex items-center justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold truncate" style={{ color: t.textPrimary }}>
            {chart.title}
          </div>
          <div className="text-[10.5px]" style={{ color: t.textMuted }}>
            {chart.granularity === "day" ? "Daily" : `Per ${chart.granularity}`}
            {chart.type === "diverging_bar" ? " · blue gain, red loss" : ""}
            {chart.type === "candlestick" ? " · blue up day, red down day" : ""}
            {hl ? ` · ${formatX(hl, chart.granularity, true)} highlighted` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          title={showTable ? "Show chart" : "Show table"}
          aria-label={showTable ? "Show chart" : "Show table"}
          className="p-1.5 rounded-md flex-shrink-0 hover:opacity-80"
          style={{ color: t.textSecondary, border: `1px solid ${t.border}` }}
        >
          {showTable ? <LineIcon className="w-3.5 h-3.5" /> : <Table2 className="w-3.5 h-3.5" />}
        </button>
      </figcaption>
      {legend}
      {showTable ? (
        <ChartTable chart={chart} t={t} />
      ) : (
        <div style={{ height: CHART_HEIGHT }} role="img" aria-label={`${chart.title} chart`}>
          <ResponsiveContainer width="100%" height="100%">
            {body as React.ReactElement}
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}

export function DashboardView({ dashboard, theme }: { dashboard: Dashboard; theme: "light" | "dark" }) {
  const t = CHART_THEMES[theme];
  return (
    <div className="space-y-3">
      {dashboard.kpis.length > 0 && (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          {dashboard.kpis.map((k) => (
            <KpiTile key={k.label} kpi={k} t={t} />
          ))}
        </div>
      )}
      {dashboard.charts.length > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          {dashboard.charts.map((c) => (
            <ChartCard key={c.id} chart={c} t={t} />
          ))}
        </div>
      )}
      <div className="text-[10.5px] space-y-0.5" style={{ color: t.textMuted }}>
        <div>
          Source: {dashboard.source.document_name}
          {dashboard.source.x_start ? ` · ${dashboard.source.x_start} to ${dashboard.source.x_end}` : ""}
          {` · ${dashboard.source.rows_used.toLocaleString()} rows`}
          {dashboard.plan_source === "ai" ? " · layout chosen by AI, values computed from the source" : " · values computed from the source"}
        </div>
        {dashboard.notes.map((n) => (
          <div key={n}>{n}</div>
        ))}
      </div>
    </div>
  );
}
