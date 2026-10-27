import * as THREE from "three";
import { Dashboard, DashboardChart } from "../../types";
import { CHART_THEMES, ChartTheme, formatTick, formatValue, formatX } from "../charts/chartTheme";
import { CanvasPanel, FONT, roundRect, wrapLines } from "./CanvasPanel";
import { DraggableItem } from "./SpatialInteraction";

/**
 * A dashboard as a real 3D object (works in the desktop room, the stereo viewer and WebXR).
 *
 * The backdrop is a crisp canvas texture carrying everything textual (title, KPI tiles, chart
 * titles, gridlines, axis ticks). The data marks are actual geometry floating a few centimetres in
 * front of it - instanced boxes for bars / candles, ribbons for lines - so they have depth in a
 * headset. Pointing at a chart (mouse or controller) shows a tooltip with the exact values.
 */

const CANVAS_W = 1620;
const CANVAS_H = 1000;
const WORLD_W = 2.7;
const WORLD_H = (WORLD_W * CANVAS_H) / CANVAS_W;
const PX = WORLD_W / CANVAS_W; // metres per canvas pixel
const MARK_DEPTH = 0.028;
const LINE_HALF_WIDTH = 0.0032;

interface PlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ChartLayout {
  chart: DashboardChart;
  cell: PlotRect;
  plot: PlotRect;
  yMin: number;
  yMax: number;
  ticks: number[];
}

/** Canvas pixel -> local 3D position on the dashboard plane. */
function toLocal(px: number, py: number, z = 0): THREE.Vector3 {
  return new THREE.Vector3((px / CANVAS_W - 0.5) * WORLD_W, (0.5 - py / CANVAS_H) * WORLD_H, z);
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function valuesOf(chart: DashboardChart): number[] {
  const vals: number[] = [];
  if (chart.type === "candlestick" && chart.ohlc) {
    chart.ohlc.high.forEach((v) => v !== null && vals.push(v));
    chart.ohlc.low.forEach((v) => v !== null && vals.push(v));
  } else {
    chart.series.forEach((s) => s.values.forEach((v) => v !== null && vals.push(v)));
  }
  return vals;
}

function layoutCharts(charts: DashboardChart[], top: number, bottom: number): ChartLayout[] {
  const left = 40;
  const right = CANVAS_W - 40;
  const gap = 24;
  const cells: PlotRect[] = [];
  const fullW = right - left;
  const halfW = (fullW - gap) / 2;
  const height = bottom - top;
  const halfH = (height - gap) / 2;
  if (charts.length === 1) cells.push({ x: left, y: top, w: fullW, h: height });
  else if (charts.length === 2) cells.push({ x: left, y: top, w: halfW, h: height }, { x: left + halfW + gap, y: top, w: halfW, h: height });
  else if (charts.length === 3)
    cells.push(
      { x: left, y: top, w: fullW, h: halfH },
      { x: left, y: top + halfH + gap, w: halfW, h: halfH },
      { x: left + halfW + gap, y: top + halfH + gap, w: halfW, h: halfH }
    );
  else
    for (let i = 0; i < 4; i++)
      cells.push({ x: left + (i % 2) * (halfW + gap), y: top + Math.floor(i / 2) * (halfH + gap), w: halfW, h: halfH });

  return charts.slice(0, cells.length).map((chart, i) => {
    const cell = cells[i];
    const plot = { x: cell.x + 92, y: cell.y + 62, w: cell.w - 92 - 22, h: cell.h - 62 - 46 };
    const vals = valuesOf(chart);
    let yMin = vals.length ? Math.min(...vals) : 0;
    let yMax = vals.length ? Math.max(...vals) : 1;
    if (chart.type === "bar" || chart.type === "diverging_bar") {
      yMin = Math.min(0, yMin);
      yMax = Math.max(0, yMax);
    }
    const ticks = niceTicks(yMin, yMax);
    return { chart, cell, plot, yMin: ticks[0], yMax: ticks[ticks.length - 1], ticks };
  });
}

export class Dashboard3D {
  readonly group = new THREE.Group();
  readonly items: DraggableItem[] = [];
  readonly dashboardId: string;
  private backdrop: CanvasPanel;
  private tooltip: CanvasPanel;
  private closeButton: CanvasPanel;
  private crosshair: THREE.Mesh;
  private layouts: ChartLayout[] = [];
  private hitPlanes: THREE.Mesh[] = [];
  private disposables: { dispose: () => void }[] = [];
  private t: ChartTheme;
  private hoverKey = "";

  constructor(dashboard: Dashboard, theme: "light" | "dark", renderer: THREE.WebGLRenderer, onClose: () => void) {
    this.dashboardId = dashboard.id;
    this.t = CHART_THEMES[theme];
    this.group.name = "dashboard-3d";

    this.backdrop = new CanvasPanel({ width: CANVAS_W, height: CANVAS_H, worldWidth: WORLD_W, renderer, name: "dashboard-backdrop" });
    this.group.add(this.backdrop.mesh);
    const chartsTop = dashboard.kpis.length ? 300 : 170;
    this.layouts = layoutCharts(dashboard.charts, chartsTop, CANVAS_H - 70);
    this.backdrop.draw(dashboard.id, (ctx) => this.paintBackdrop(ctx, dashboard));
    this.layouts.forEach((l, i) => this.buildMarks(l, i));

    // crosshair + tooltip for pointing at a chart
    const crossMat = new THREE.MeshBasicMaterial({ color: this.t.textMuted, toneMapped: false, fog: false });
    this.crosshair = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 1, 0.002), crossMat);
    this.crosshair.visible = false;
    this.crosshair.raycast = () => {};
    this.group.add(this.crosshair);
    this.disposables.push(crossMat, this.crosshair.geometry);

    this.tooltip = new CanvasPanel({ width: 460, height: 170, worldWidth: 0.55, renderer, name: "dashboard-tooltip" });
    this.tooltip.mesh.visible = false;
    this.tooltip.mesh.raycast = () => {};
    this.group.add(this.tooltip.mesh);

    this.closeButton = new CanvasPanel({ width: 120, height: 120, worldWidth: 0.11, renderer, name: "dashboard-close" });
    this.closeButton.draw("x", (ctx, w, h) => {
      ctx.fillStyle = this.t.surface;
      roundRect(ctx, 6, 6, w - 12, h - 12, (w - 12) / 2);
      ctx.fill();
      ctx.strokeStyle = this.t.axis;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = this.t.textSecondary;
      ctx.lineWidth = 9;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(40, 40);
      ctx.lineTo(80, 80);
      ctx.moveTo(80, 40);
      ctx.lineTo(40, 80);
      ctx.stroke();
    });
    this.closeButton.mesh.position.copy(toLocal(CANVAS_W - 70, 66, 0.012));
    this.group.add(this.closeButton.mesh);

    this.items.push(
      {
        id: "dashboard",
        object: this.group,
        onHoverDetail: (hit) => this.onPoint(hit),
      },
      { id: "dashboard-close", object: this.closeButton.mesh, fixed: true, onClick: onClose }
    );
  }

  // ---------------------------------------------------------------- backdrop (all text)

  private paintBackdrop(ctx: CanvasRenderingContext2D, d: Dashboard) {
    const t = this.t;
    ctx.fillStyle = t.surface;
    roundRect(ctx, 4, 4, CANVAS_W - 8, CANVAS_H - 8, 34);
    ctx.fill();
    ctx.strokeStyle = t.axis;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = t.textPrimary;
    ctx.font = `600 38px ${FONT}`;
    ctx.fillText(d.title.slice(0, 60), 40, 74);
    ctx.font = `400 22px ${FONT}`;
    ctx.fillStyle = t.textSecondary;
    ctx.fillText((d.subtitle || d.question).slice(0, 110), 40, 110);
    ctx.font = `400 18px ${FONT}`;
    ctx.fillStyle = t.textMuted;
    ctx.fillText(`For: “${d.question.slice(0, 120)}”`, 40, 140);

    // KPI tiles
    if (d.kpis.length) {
      const n = d.kpis.length;
      const gap = 18;
      const w = (CANVAS_W - 80 - gap * (n - 1)) / n;
      d.kpis.forEach((k, i) => {
        const x = 40 + i * (w + gap);
        const y = 166;
        roundRect(ctx, x, y, w, 110, 18);
        ctx.fillStyle = t.surface;
        ctx.fill();
        ctx.strokeStyle = t.grid;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = t.textSecondary;
        ctx.font = `400 19px ${FONT}`;
        ctx.fillText(k.label.slice(0, 34), x + 20, y + 34);
        let vx = x + 20;
        if (k.tone) {
          ctx.fillStyle = k.tone === "up" ? t.positive : t.negative;
          ctx.font = `400 18px ${FONT}`;
          ctx.fillText(k.tone === "up" ? "▲" : "▼", vx, y + 74);
          vx += 24;
        }
        ctx.fillStyle = t.textPrimary;
        ctx.font = `600 36px ${FONT}`;
        ctx.fillText(k.display, vx, y + 76);
        if (k.sub) {
          ctx.fillStyle = t.textMuted;
          ctx.font = `400 15px ${FONT}`;
          let sub = k.sub;
          while (ctx.measureText(sub).width > w - 40 && sub.length > 4) sub = sub.slice(0, -2);
          ctx.fillText(sub === k.sub ? sub : `${sub}…`, x + 20, y + 99);
        }
      });
    }

    // chart frames, gridlines and axis labels
    for (const l of this.layouts) {
      const { chart, cell, plot } = l;
      ctx.fillStyle = t.textPrimary;
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText(chart.title.slice(0, 48), cell.x + 6, cell.y + 28);
      ctx.fillStyle = t.textMuted;
      ctx.font = `400 16px ${FONT}`;
      const meta =
        (chart.granularity === "day" ? "Daily" : `Per ${chart.granularity}`) +
        (chart.type === "diverging_bar" ? " · blue gain, red loss" : chart.type === "candlestick" ? " · blue up, red down" : "") +
        (chart.highlight ? ` · ${formatX(chart.highlight, chart.granularity, true)} marked` : "");
      ctx.fillText(meta, cell.x + 6, cell.y + 50);

      const unit = chart.type === "candlestick" ? "$" : chart.unit;
      ctx.font = `400 15px ${FONT}`;
      ctx.textAlign = "right";
      for (const tick of l.ticks) {
        const y = this.yPx(l, tick);
        ctx.strokeStyle = tick === 0 && l.yMin < 0 ? t.axis : t.grid;
        ctx.lineWidth = tick === 0 && l.yMin < 0 ? 2 : 1.5;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();
        ctx.fillStyle = t.textMuted;
        ctx.fillText(formatTick(tick, unit), plot.x - 10, y + 5);
      }
      ctx.textAlign = "center";
      const n = chart.x.length;
      const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plot.w / 120))));
      for (let i = 0; i < n; i += labelEvery) {
        ctx.fillText(formatX(chart.x[i], chart.granularity), this.xPx(l, i), plot.y + plot.h + 26);
      }
      ctx.textAlign = "start";
      ctx.strokeStyle = t.axis;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(plot.x, plot.y + plot.h);
      ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
      ctx.stroke();
    }

    // footer: provenance + notes
    ctx.font = `400 15px ${FONT}`;
    ctx.fillStyle = t.textMuted;
    const footer = [
      `Source: ${d.source.document_name}${d.source.x_start ? ` · ${d.source.x_start} to ${d.source.x_end}` : ""} · values computed from the source rows`,
      ...d.notes,
    ].join("   ·   ");
    const lines = wrapLines(ctx, footer, CANVAS_W - 160);
    lines.slice(0, 2).forEach((line, i) => ctx.fillText(line, 40, CANVAS_H - 40 + i * 20 - (lines.length > 1 ? 10 : 0)));
  }

  private xPx(l: ChartLayout, i: number): number {
    const n = l.chart.x.length;
    const band = l.plot.w / Math.max(1, n);
    return l.plot.x + band * (i + 0.5);
  }

  private yPx(l: ChartLayout, v: number): number {
    return l.plot.y + l.plot.h - ((v - l.yMin) / (l.yMax - l.yMin || 1)) * l.plot.h;
  }

  // ---------------------------------------------------------------- 3D marks

  private material(color: string, opacity = 1) {
    const m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      toneMapped: false,
      fog: false,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
    });
    this.disposables.push(m);
    return m;
  }

  private instancedBoxes(count: number, place: (i: number, m: THREE.Matrix4, c: THREE.Color) => boolean) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false, fog: false });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    let used = 0;
    for (let i = 0; i < count; i++) {
      if (!place(i, m, c)) continue;
      mesh.setMatrixAt(used, m);
      mesh.setColorAt(used, c);
      used++;
    }
    mesh.count = used;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.raycast = () => {}; // pointing is resolved by the chart's hit plane
    this.disposables.push(geo, mat);
    this.group.add(mesh);
    return mesh;
  }

  private boxMatrix(m: THREE.Matrix4, cx: number, cy: number, w: number, h: number, depth: number, z: number) {
    const center = toLocal(cx, cy, z);
    m.compose(center, new THREE.Quaternion(), new THREE.Vector3(Math.max(w * PX, 0.0015), Math.max(h * PX, 0.0015), depth));
  }

  private buildMarks(l: ChartLayout, index: number) {
    const { chart, plot } = l;
    const t = this.t;
    const n = chart.x.length;
    const band = plot.w / Math.max(1, n);
    const barW = Math.max(2, Math.min(band * 0.72, 24));
    const base = this.yPx(l, Math.max(l.yMin, Math.min(0, l.yMax)));

    if (chart.type === "bar" || chart.type === "diverging_bar") {
      const s = chart.series[0];
      this.instancedBoxes(n, (i, m, c) => {
        const v = s.values[i];
        if (v === null || v === undefined) return false;
        const y = this.yPx(l, v);
        this.boxMatrix(m, this.xPx(l, i), (y + base) / 2, barW, Math.abs(base - y), MARK_DEPTH, MARK_DEPTH / 2 + 0.003);
        const color =
          chart.type === "diverging_bar"
            ? v >= 0 ? t.positive : t.negative
            : chart.highlight && chart.x[i] !== chart.highlight ? t.deemphasis : t.series[0];
        c.set(color);
        return true;
      });
    } else if (chart.type === "candlestick" && chart.ohlc) {
      const { open, high, low, close } = chart.ohlc;
      const bodyW = Math.max(2, Math.min(band * 0.7, 24));
      this.instancedBoxes(n, (i, m, c) => {
        const o = open[i], cl = close[i];
        if (o === null || cl === null) return false;
        const y1 = this.yPx(l, o), y2 = this.yPx(l, cl);
        this.boxMatrix(m, this.xPx(l, i), (y1 + y2) / 2, bodyW, Math.max(2, Math.abs(y1 - y2)), MARK_DEPTH, MARK_DEPTH / 2 + 0.003);
        c.set(cl >= o ? t.positive : t.negative);
        return true;
      });
      this.instancedBoxes(n, (i, m, c) => {
        const h = high[i], lo = low[i], o = open[i], cl = close[i];
        if (h === null || lo === null || o === null || cl === null) return false;
        const y1 = this.yPx(l, h), y2 = this.yPx(l, lo);
        this.boxMatrix(m, this.xPx(l, i), (y1 + y2) / 2, 2, Math.abs(y2 - y1), 0.004, MARK_DEPTH / 2 + 0.003);
        c.set(cl >= o ? t.positive : t.negative);
        return true;
      });
    } else {
      chart.series.forEach((s, si) => {
        const pts: THREE.Vector3[] = [];
        s.values.forEach((v, i) => {
          if (v !== null && v !== undefined) pts.push(toLocal(this.xPx(l, i), this.yPx(l, v), 0.012 + si * 0.002));
        });
        if (pts.length < 2) return;
        const color = t.series[si % 3];
        this.group.add(this.ribbon(pts, color));
        if (si === 0) this.group.add(this.areaWash(pts, toLocal(0, base).y, color, chart.type === "area" ? 0.16 : 0.08));
      });
    }

    // focus-date marker
    if (chart.highlight) {
      const i = chart.x.indexOf(chart.highlight);
      if (i >= 0) {
        const mat = this.material(t.textMuted);
        const marker = new THREE.Mesh(new THREE.BoxGeometry(0.0018, plot.h * PX, 0.002), mat);
        marker.position.copy(toLocal(this.xPx(l, i), plot.y + plot.h / 2, 0.002));
        marker.raycast = () => {};
        this.disposables.push(marker.geometry);
        this.group.add(marker);
        const v = chart.type === "candlestick" ? chart.ohlc?.close[i] : chart.series[0].values[i];
        if (v !== null && v !== undefined && (chart.type === "line" || chart.type === "area")) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.011, 16, 12), this.material(t.series[0]));
          dot.position.copy(toLocal(this.xPx(l, i), this.yPx(l, v), 0.016));
          dot.raycast = () => {};
          this.disposables.push(dot.geometry);
          this.group.add(dot);
        }
      }
    }

    // invisible hit plane over the plot: pointing here shows the tooltip
    const hitMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 });
    const hit = new THREE.Mesh(new THREE.PlaneGeometry(plot.w * PX, plot.h * PX), hitMat);
    hit.position.copy(toLocal(plot.x + plot.w / 2, plot.y + plot.h / 2, 0.04));
    hit.userData.chartIndex = index;
    this.disposables.push(hitMat, hit.geometry);
    this.hitPlanes.push(hit);
    this.group.add(hit);
  }

  private ribbon(points: THREE.Vector3[], color: string): THREE.Mesh {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dir = new THREE.Vector2(next.x - prev.x, next.y - prev.y).normalize();
      const nx = -dir.y * LINE_HALF_WIDTH;
      const ny = dir.x * LINE_HALF_WIDTH;
      const p = points[i];
      pos.push(p.x + nx, p.y + ny, p.z, p.x - nx, p.y - ny, p.z);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = this.material(color);
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.raycast = () => {};
    this.disposables.push(geo);
    return mesh;
  }

  private areaWash(points: THREE.Vector3[], baseY: number, color: string, opacity: number): THREE.Mesh {
    const pos: number[] = [];
    const idx: number[] = [];
    points.forEach((p, i) => {
      pos.push(p.x, p.y, 0.006, p.x, baseY, 0.006);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = this.material(color, opacity);
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.raycast = () => {};
    this.disposables.push(geo);
    return mesh;
  }

  // ---------------------------------------------------------------- pointing / tooltip

  private onPoint(hit: THREE.Intersection | null) {
    const plane = hit?.object;
    const ci = plane?.userData?.chartIndex;
    if (!hit || ci === undefined) {
      this.tooltip.mesh.visible = false;
      this.crosshair.visible = false;
      this.hoverKey = "";
      return;
    }
    const l = this.layouts[ci];
    const local = this.group.worldToLocal(hit.point.clone());
    const px = (local.x / WORLD_W + 0.5) * CANVAS_W;
    const n = l.chart.x.length;
    const i = Math.max(0, Math.min(n - 1, Math.floor(((px - l.plot.x) / l.plot.w) * n)));
    const key = `${ci}:${i}`;
    if (key === this.hoverKey) return;
    this.hoverKey = key;

    const c = l.chart;
    const rows: [string, string, string][] =
      c.type === "candlestick" && c.ohlc
        ? (["open", "high", "low", "close"] as const).map((k) => [
            formatValue(c.ohlc![k][i], "$"),
            k[0].toUpperCase() + k.slice(1),
            (c.ohlc!.close[i] ?? 0) >= (c.ohlc!.open[i] ?? 0) ? this.t.positive : this.t.negative,
          ])
        : c.series.map((s, si) => {
            const v = s.values[i];
            const color = c.type === "diverging_bar" ? ((v ?? 0) >= 0 ? this.t.positive : this.t.negative) : this.t.series[si % 3];
            return [formatValue(v, s.unit), s.name, color];
          });
    const t = this.t;
    this.tooltip.draw(key, (ctx, w, h) => {
      roundRect(ctx, 4, 4, w - 8, h - 8, 18);
      ctx.fillStyle = t.surface;
      ctx.fill();
      ctx.strokeStyle = t.axis;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = t.textMuted;
      ctx.font = `400 22px ${FONT}`;
      ctx.fillText(formatX(c.x[i], c.granularity, true), 22, 38);
      const shown = rows.slice(0, 4);
      const colW = (w - 44) / Math.min(2, shown.length);
      shown.forEach(([value, name, color], r) => {
        const x = 22 + (r % 2) * colW;
        const y = 82 + Math.floor(r / 2) * 52;
        ctx.fillStyle = color;
        ctx.fillRect(x, y - 9, 20, 4);
        ctx.fillStyle = t.textPrimary;
        ctx.font = `600 28px ${FONT}`;
        ctx.fillText(value, x + 30, y);
        const valueWidth = ctx.measureText(value).width;
        ctx.fillStyle = t.textSecondary;
        ctx.font = `400 18px ${FONT}`;
        ctx.fillText(name, x + 30 + valueWidth + 10, y);
      });
    });
    const x = this.xPx(l, i);
    this.crosshair.scale.y = l.plot.h * PX;
    this.crosshair.position.copy(toLocal(x, l.plot.y + l.plot.h / 2, 0.034));
    this.crosshair.visible = true;
    // keep the tooltip inside the chart cell, beside the crosshair
    const tipW = 0.55;
    const flip = x + 30 + (tipW / PX) > l.cell.x + l.cell.w;
    const tipX = flip ? x - 30 - tipW / PX / 2 : x + 30 + tipW / PX / 2;
    this.tooltip.mesh.position.copy(toLocal(tipX, l.plot.y + 70, 0.07));
    this.tooltip.mesh.visible = true;
  }

  get size() {
    return { width: WORLD_W, height: WORLD_H };
  }

  dispose() {
    this.backdrop.dispose();
    this.tooltip.dispose();
    this.closeButton.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
