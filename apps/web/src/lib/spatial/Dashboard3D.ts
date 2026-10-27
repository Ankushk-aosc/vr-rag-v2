import * as THREE from "three";
import { Dashboard, DashboardChart } from "../../types";
import { formatTick, formatValue, formatX } from "../charts/chartTheme";
import { CanvasPanel, FONT, MONO, roundRect } from "./CanvasPanel";
import { DraggableItem } from "./SpatialInteraction";

/**
 * 3D Discrete Column Plot System with Ultra-Crisp High-DPI Text and Non-Occluding Tooltips.
 *
 * Enhancements:
 *  - Tooltip never cuts or hides underneath front pillars: depthTest is disabled and renderOrder=9999
 *    so tooltips float completely on top in full view.
 *  - 3x supersampled retina text rendering on all components (Title Badge, Tooltips, Rim Markings, Header, KPIs).
 *  - Every bar is 100% hoverable and clickable with instant glowing highlight and floating value card.
 *  - Click to pin / unpin with amber border.
 */

const THEMES = {
  dark: {
    bgGradTop: "rgba(18, 14, 38, 0.92)",
    bgGradBottom: "rgba(10, 8, 24, 0.82)",
    glassBorder: "rgba(168, 85, 247, 0.50)",
    glassBorderSubtle: "rgba(139, 92, 246, 0.25)",
    plinthBase: 0x111625,
    plinthBevel: 0xa855f7,
    floorTile: 0x222a3f,
    floorTileGlow: 0x3b4668,
    accentChip: "rgba(124, 58, 237, 0.35)",
    accentText: "#C4B5FD",
    textPrimary: "#FFFFFF",
    textSecondary: "#DDD6FE",
    textMuted: "#94A3B8",
    barBlueSide: 0x1e88e5, // Vibrant sapphire blue
    barBlueTop: 0x072b4f,  // Deep navy cap
    barGreenSide: 0x10b981,
    barGreenTop: 0x064e3b,
    barRedSide: 0xf43f5e,
    barRedTop: 0x881337,
  },
  light: {
    bgGradTop: "rgba(255, 255, 255, 0.96)",
    bgGradBottom: "rgba(241, 245, 249, 0.90)",
    glassBorder: "rgba(109, 40, 217, 0.40)",
    glassBorderSubtle: "rgba(109, 40, 217, 0.20)",
    plinthBase: 0xf1f5f9,
    plinthBevel: 0x7c3aed,
    floorTile: 0xe2e8f0,
    floorTileGlow: 0xcbd5e1,
    accentChip: "rgba(109, 40, 217, 0.15)",
    accentText: "#6D28D9",
    textPrimary: "#0F172A",
    textSecondary: "#334155",
    textMuted: "#64748B",
    barBlueSide: 0x1976d2,
    barBlueTop: 0x0a2f58,
    barGreenSide: 0x059669,
    barGreenTop: 0x064e3b,
    barRedSide: 0xe11d48,
    barRedTop: 0x881337,
  },
};

type ThemeConfig = typeof THEMES["dark"];

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

// Compact, elegant proportions for spatial 3D graphs (fits easily in VR / desktop FOV)
const BOX_W = 0.74; // Width along X
const BOX_H = 0.38; // Height along Y
const BOX_D = 0.52; // Depth along Z

export interface PillarData {
  isPillar: boolean;
  ix: number;
  iz: number;
  dataIdx: number;
  xLabel: string;
  zLabel: string;
  value: number;
  formattedValue: string;
  originalMats: THREE.Material[];
}

/**
 * Individual 3D Discrete Column Plot (Clean Pedestal Plinth Edition).
 * Features clean 3D solid blue pillars with interactive hover and click inspection,
 * floating 3D tooltips, dynamic title badge updates, and NO background cage walls.
 */
export class Individual3DGraph {
  readonly group = new THREE.Group();
  readonly pivotGroup = new THREE.Group();
  readonly pillars: THREE.Mesh[] = [];
  private titlePanel: CanvasPanel;
  private rimPanel: CanvasPanel;
  private tooltipPanel: CanvasPanel;
  private disposables: { dispose: () => void }[] = [];
  readonly chart: DashboardChart;
  readonly index: number;
  private t: ThemeConfig;

  private minVal: number;
  private maxVal: number;
  private vals: number[];

  private hoveredPillar: THREE.Mesh | null = null;
  private pinnedPillar: THREE.Mesh | null = null;
  private highlightMats: THREE.Material[];

  constructor(chart: DashboardChart, index: number, theme: ThemeConfig, renderer: THREE.WebGLRenderer) {
    this.chart = chart;
    this.index = index;
    this.t = theme;
    this.group.name = `individual-3d-graph-${index}`;

    // Compute value bounds
    this.vals = valuesOf(chart);
    let yMin = this.vals.length ? Math.min(...this.vals) : 0;
    let yMax = this.vals.length ? Math.max(...this.vals) : 100;
    if (chart.type === "bar" || chart.type === "diverging_bar") {
      yMin = Math.min(0, yMin);
      yMax = Math.max(0, yMax);
    }
    const ticks = niceTicks(yMin, yMax, 4);
    this.minVal = ticks[0];
    this.maxVal = ticks[ticks.length - 1];

    // Highlight materials for hovered / pinned bar (luminous cyan glow)
    const hlSideMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.55,
      roughness: 0.15,
      metalness: 0.25,
    });
    const hlTopMat = new THREE.MeshStandardMaterial({
      color: 0x7dd3fc,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.65,
      roughness: 0.12,
      metalness: 0.30,
    });
    const bottomMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.highlightMats = [hlSideMat, hlSideMat, hlTopMat, bottomMat, hlSideMat, hlSideMat];
    this.disposables.push(hlSideMat, hlTopMat, bottomMat);

    // 1. Sleek Floating Title Badge (3x High-DPI supersampling for razor sharp text)
    this.titlePanel = new CanvasPanel({
      width: 1000,
      height: 120,
      worldWidth: BOX_W * 0.98,
      pixelRatio: 3,
      renderer,
      depthWrite: false,
      name: `graph-title-${index}`,
    });
    this.updateTitleBadge(null);
    this.titlePanel.mesh.position.set(0, BOX_H / 2 + 0.15, 0);
    this.group.add(this.titlePanel.mesh);

    // 2. Isometric Pivot (Gentle angle: viewer looks slightly down onto the floor pedestal)
    this.pivotGroup.rotation.set(0.26, -0.34, 0);
    this.group.add(this.pivotGroup);

    // 3. Dedicated Local Lighting for photorealistic 3D face shading
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    dirLight.position.set(2.2, 4.0, 3.2);
    this.pivotGroup.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.45);
    fillLight.position.set(-2.5, 2.0, -1.0);
    this.pivotGroup.add(fillLight);

    const ambLight = new THREE.AmbientLight(0xffffff, 0.60);
    this.pivotGroup.add(ambLight);

    // 4. Build the Clean Floating Pedestal Plinth & Discrete 3D Solid Blue Pillars (NO background grids!)
    this.buildCleanPedestalAndPillars();

    // 5. Floating 3D Holographic Tooltip
    // depthTest: false & renderOrder: 9999 guarantee it is NEVER cut or hidden underneath front pillars!
    this.tooltipPanel = new CanvasPanel({
      width: 520,
      height: 160,
      worldWidth: 0.28,
      pixelRatio: 3,
      renderer,
      depthWrite: false,
      depthTest: false,
      renderOrder: 9999,
      name: `pillar-tooltip-${index}`,
    });
    this.tooltipPanel.mesh.visible = false;
    this.tooltipPanel.mesh.raycast = () => {}; // Never obstruct bar raycasts
    this.pivotGroup.add(this.tooltipPanel.mesh);

    // 6. Minimalist Front Rim Markings directly along the plinth base (3x High-DPI supersampling)
    this.rimPanel = new CanvasPanel({
      width: 1200,
      height: 80,
      worldWidth: BOX_W,
      pixelRatio: 3,
      renderer,
      depthWrite: false,
      name: `rim-panel-${index}`,
    });
    this.rimPanel.mesh.raycast = () => {}; // Never obstruct bar raycasts
    this.rimPanel.draw(`rim-${chart.id}`, (ctx) => {
      ctx.textAlign = "center";
      const n = chart.x.length;
      const numTicks = 5;
      for (let i = 0; i < numTicks; i++) {
        const idx = Math.min(n - 1, Math.floor((i / (numTicks - 1)) * (n - 1)));
        const x = (i / (numTicks - 1)) * 1060 + 70;
        // Small vertical tick notch
        ctx.fillStyle = "rgba(168, 85, 247, 0.65)";
        ctx.fillRect(x - 1.5, 4, 3, 8);

        ctx.fillStyle = "#FFFFFF";
        ctx.font = `700 18px ${FONT}`;
        ctx.fillText(formatX(chart.x[idx], chart.granularity), x, 36);
      }
      ctx.font = `700 14px ${MONO}`;
      ctx.fillStyle = "#C4B5FD";
      ctx.fillText("TIME / CURRENT → (HOVER OR CLICK ANY BAR FOR VALUE)", 600, 68);
    });
    this.rimPanel.mesh.position.set(0, -BOX_H / 2 - 0.04, BOX_D / 2 + 0.03);
    this.pivotGroup.add(this.rimPanel.mesh);
  }

  private getZLabel(iz: number): string {
    const chart = this.chart;
    if (chart.type === "candlestick" && chart.ohlc) {
      return ["Low", "Open", "Close", "High"][iz] || "Price";
    }
    if (chart.series.length > 1) {
      return chart.series[iz]?.name || `Series ${iz + 1}`;
    }
    return ["Spot", "MA-5", "MA-15", "Volatility Band"][iz] || `Channel ${iz + 1}`;
  }

  /**
   * Builds the clean floating pedestal plinth and discrete solid 3D pillars with metadata for value inspection.
   * Ensures EVERY cell has an active 3D pillar (no skipped tiles).
   */
  private buildCleanPedestalAndPillars() {
    const hw = BOX_W / 2, hh = BOX_H / 2, hd = BOX_D / 2;
    const minVal = this.minVal;
    const maxVal = this.maxVal;
    const valRange = maxVal - minVal || 1;

    // 1. Elegant Floating Pedestal Slab (Double layered with glowing accent edge)
    const plinthGeo = new THREE.BoxGeometry(BOX_W, 0.018, BOX_D);
    const plinthMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.t.plinthBase),
      roughness: 0.35,
      metalness: 0.25,
    });
    const plinth = new THREE.Mesh(plinthGeo, plinthMat);
    plinth.position.set(0, -hh - 0.009, 0);
    this.pivotGroup.add(plinth);
    this.disposables.push(plinthGeo, plinthMat);

    // Subtle edge rim line around pedestal
    const edgePositions = [
      -hw, -hh, -hd,  hw, -hh, -hd,
       hw, -hh, -hd,  hw, -hh,  hd,
       hw, -hh,  hd, -hw, -hh,  hd,
      -hw, -hh,  hd, -hw, -hh, -hd,
    ];
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
    const edgeMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(this.t.plinthBevel),
      transparent: true,
      opacity: 0.7,
    });
    this.pivotGroup.add(new THREE.LineSegments(edgeGeo, edgeMat));
    this.disposables.push(edgeGeo, edgeMat);

    // 2. Matrix Dimensions: 7 columns along X, and 4 to 5 channels along Z
    const isCandle = this.chart.type === "candlestick" && !!this.chart.ohlc;
    const isMultiSeries = this.chart.series.length > 1;
    const Nx = 7;
    const Nz = isCandle ? 4 : isMultiSeries ? Math.min(5, this.chart.series.length) : 4;

    const cellW = (BOX_W * 0.92) / Nx;
    const cellD = (BOX_D * 0.92) / Nz;
    const tileW = cellW * 0.86;
    const tileD = cellD * 0.86;
    const tileThick = 0.005;

    // 3. Dark Checkered Floor Tiles on top of the Pedestal
    const tileGeo = new THREE.BoxGeometry(tileW, tileThick, tileD);
    const tileMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.t.floorTile),
      roughness: 0.40,
      metalness: 0.20,
    });
    const tileMesh = new THREE.InstancedMesh(tileGeo, tileMat, Nx * Nz);
    const mat4 = new THREE.Matrix4();

    for (let iz = 0; iz < Nz; iz++) {
      const z = -hd + cellD * (iz + 0.5) + (BOX_D * 0.04);
      for (let ix = 0; ix < Nx; ix++) {
        const x = -hw + cellW * (ix + 0.5) + (BOX_W * 0.04);
        const idx = iz * Nx + ix;
        mat4.setPosition(x, -hh + tileThick / 2, z);
        tileMesh.setMatrixAt(idx, mat4);
      }
    }
    tileMesh.instanceMatrix.needsUpdate = true;
    this.pivotGroup.add(tileMesh);
    this.disposables.push(tileGeo, tileMat);

    // 4. Data Sampling for Pillars
    const chart = this.chart;
    const s0 = chart.series[0]?.values || [];
    const n = Math.max(1, chart.x.length);
    const isDiverging = chart.type === "diverging_bar";
    const ohlc = chart.ohlc;

    // Solid 3D Pillar Materials (Vivid blue sides, dark navy top cap)
    const sideMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.t.barBlueSide),
      roughness: 0.24,
      metalness: 0.18,
    });
    const topMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.t.barBlueTop),
      roughness: 0.20,
      metalness: 0.25,
    });
    const bottomMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const blueBoxMats = [sideMat, sideMat, topMat, bottomMat, sideMat, sideMat];
    this.disposables.push(sideMat, topMat, bottomMat);

    // Diverging materials for positive/negative returns
    const posSideMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.t.barGreenSide), roughness: 0.26 });
    const posTopMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.t.barGreenTop), roughness: 0.22 });
    const posBoxMats = [posSideMat, posSideMat, posTopMat, bottomMat, posSideMat, posSideMat];
    this.disposables.push(posSideMat, posTopMat);

    const negSideMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.t.barRedSide), roughness: 0.26 });
    const negTopMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.t.barRedTop), roughness: 0.22 });
    const negBoxMats = [negSideMat, negSideMat, negTopMat, bottomMat, negSideMat, negSideMat];
    this.disposables.push(negSideMat, negTopMat);

    // 5. Generate Solid 3D Pillars on ALL active tiles so every bar is inspectable
    const pillarGroup = new THREE.Group();
    pillarGroup.name = "pillars";
    this.pillars.length = 0;

    for (let iz = 0; iz < Nz; iz++) {
      const z = -hd + cellD * (iz + 0.5) + (BOX_D * 0.04);
      for (let ix = 0; ix < Nx; ix++) {
        const x = -hw + cellW * (ix + 0.5) + (BOX_W * 0.04);
        const fx = ix / (Nx - 1);
        const dataIdx = Math.min(n - 1, Math.floor(fx * n));

        let val: number = minVal;

        if (chart.type === "candlestick" && ohlc) {
          if (iz === 0) val = ohlc.low?.[dataIdx] ?? minVal;
          else if (iz === 1) val = ohlc.open?.[dataIdx] ?? minVal;
          else if (iz === 2) val = ohlc.close?.[dataIdx] ?? minVal;
          else val = ohlc.high?.[dataIdx] ?? minVal;
        } else if (chart.series.length > 1) {
          const s = chart.series[iz];
          val = s?.values[dataIdx] ?? minVal;
        } else {
          // Single series: Duration slices & frequency occurrences
          const baseV = s0[dataIdx] ?? minVal;
          if (iz === 0) {
            val = baseV;
          } else if (iz === 1) {
            const start = Math.max(0, dataIdx - 5);
            const slice = s0.slice(start, dataIdx + 1).filter((v): v is number => v !== null);
            val = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : baseV;
          } else if (iz === 2) {
            const start = Math.max(0, dataIdx - 15);
            const slice = s0.slice(start, dataIdx + 1).filter((v): v is number => v !== null);
            val = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : baseV;
          } else {
            const start = Math.max(0, dataIdx - 10);
            const slice = s0.slice(start, dataIdx + 1).filter((v): v is number => v !== null);
            const maxS = slice.length ? Math.max(...slice) : baseV;
            val = maxS;
          }
        }

        const normH = Math.max(0, Math.min(1, (val - minVal) / valRange));
        // Minimum pillar height guarantees that even lowest values have a solid, hoverable 3D bar
        const pillarH = Math.max(0.024, normH * BOX_H * 0.85);
        const pGeo = new THREE.BoxGeometry(tileW * 0.90, pillarH, tileD * 0.90);
        this.disposables.push(pGeo);

        const mats = isDiverging
          ? val >= 0
            ? posBoxMats
            : negBoxMats
          : blueBoxMats;

        const pillar = new THREE.Mesh(pGeo, mats);
        pillar.position.set(x, -hh + tileThick + pillarH / 2, z);

        const zLabel = this.getZLabel(iz);
        const xLabel = formatX(chart.x[dataIdx], chart.granularity);
        const formatted = formatValue(val, chart.unit);

        const pillarData: PillarData = {
          isPillar: true,
          ix,
          iz,
          dataIdx,
          xLabel,
          zLabel,
          value: val,
          formattedValue: formatted,
          originalMats: mats,
        };
        pillar.userData = pillarData;

        pillarGroup.add(pillar);
        this.pillars.push(pillar);
      }
    }

    this.pivotGroup.add(pillarGroup);
  }

  /**
   * Comprehensive raycast inspector:
   * Handles direct bar hits, bar top/side hits, and floor-foot hits near any bar.
   */
  inspectRay(hit: THREE.Intersection | null, isClick = false) {
    if (!hit) {
      if (!isClick) this.inspectPillar(null, false);
      return;
    }

    // Direct pillar hit
    const obj = hit.object as THREE.Mesh;
    if (obj?.userData?.isPillar) {
      this.inspectPillar(obj, isClick);
      return;
    }

    // If ray hit the plinth or a floor tile, find the closest pillar to the hit point
    if (hit.point && this.pillars.length) {
      const localPt = hit.point.clone();
      this.pivotGroup.worldToLocal(localPt);
      let closest: THREE.Mesh | null = null;
      let closestDist = 0.14; // Within 14cm local radius of the bar's foot
      for (const p of this.pillars) {
        const d = Math.hypot(p.position.x - localPt.x, p.position.z - localPt.z);
        if (d < closestDist) {
          closestDist = d;
          closest = p;
        }
      }
      if (closest) {
        this.inspectPillar(closest, isClick);
        return;
      }
    }

    if (isClick) {
      this.inspectPillar(null, true);
    }
  }

  /**
   * Hover or Click a particular bar to inspect its exact value.
   * Highlights the bar, floats a non-occluding 3D holographic tooltip above it, and updates the title badge.
   */
  inspectPillar(pillar: THREE.Mesh | null, isClick = false) {
    if (isClick && pillar) {
      if (this.pinnedPillar === pillar) {
        // Unpin if clicked again
        this.pinnedPillar = null;
      } else {
        // Pin this bar
        this.pinnedPillar = pillar;
      }
    } else if (isClick && !pillar) {
      // Clicked background: unpin
      this.pinnedPillar = null;
    }

    const target = this.pinnedPillar || pillar;

    // Reset previous hovered mesh material if it changed
    if (this.hoveredPillar && this.hoveredPillar !== target) {
      if (this.hoveredPillar.userData.originalMats) {
        this.hoveredPillar.material = this.hoveredPillar.userData.originalMats;
      }
    }

    if (!target || !target.userData.isPillar) {
      this.hoveredPillar = null;
      this.tooltipPanel.mesh.visible = false;
      this.updateTitleBadge(null);
      return;
    }

    this.hoveredPillar = target;
    target.material = this.highlightMats;

    const data = target.userData as PillarData;
    const pH = (target.geometry as THREE.BoxGeometry).parameters.height;

    // Position tooltip above the pillar top cap and slightly forward in local Z so it is never cut
    this.tooltipPanel.mesh.position.set(
      target.position.x,
      target.position.y + pH / 2 + 0.12,
      target.position.z - 0.05
    );
    this.tooltipPanel.mesh.visible = true;

    // Draw the 3D Holographic Tooltip (Retina 3x supersampling with high-contrast typography)
    this.tooltipPanel.draw(`tip-${data.ix}-${data.iz}-${data.value}-${this.pinnedPillar === target ? 'pin' : 'hov'}`, (ctx, w, h) => {
      // Frosted dark glass rounded card with rich border
      ctx.fillStyle = "rgba(8, 12, 28, 0.96)";
      roundRect(ctx, 4, 4, w - 8, h - 8, 16);
      ctx.fill();
      ctx.strokeStyle = this.pinnedPillar === target ? "rgba(245, 158, 11, 0.95)" : "rgba(56, 189, 248, 0.95)";
      ctx.lineWidth = 3;
      ctx.stroke();

      // Top line: Channel & Date badge
      ctx.fillStyle = this.pinnedPillar === target ? "#FBBF24" : "#38BDF8";
      ctx.font = `700 16px ${MONO}`;
      const badgeIcon = this.pinnedPillar === target ? "📌 " : "✦ ";
      ctx.fillText(`${badgeIcon}${data.zLabel} • ${data.xLabel}`, 22, 36);

      // Large Value in brilliant white
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `800 38px ${FONT}`;
      ctx.fillText(data.formattedValue, 22, 88);

      // Subtitle / Pin hint
      ctx.fillStyle = "#94A3B8";
      ctx.font = `600 14px ${FONT}`;
      const hint = this.pinnedPillar === target ? "PINNED VALUE (Click to unpin)" : "Click to pin in place";
      ctx.fillText(hint, 22, 130);
    });

    // Also update the Title Badge for instant clear reading
    this.updateTitleBadge(data);
  }

  private updateTitleBadge(inspected: PillarData | null) {
    const chart = this.chart;
    const minVal = this.minVal;
    const maxVal = this.maxVal;
    const latestVal = this.vals[this.vals.length - 1];

    this.titlePanel.draw(
      inspected ? `title-insp-${inspected.xLabel}-${inspected.zLabel}-${inspected.value}-${this.pinnedPillar ? 'pin' : 'hov'}` : `title-def-${chart.id}`,
      (ctx) => {
        const grad = ctx.createLinearGradient(0, 0, 1000, 0);
        grad.addColorStop(0, this.t.bgGradTop);
        grad.addColorStop(1, this.t.bgGradBottom);
        ctx.fillStyle = grad;
        roundRect(ctx, 4, 4, 992, 112, 18);
        ctx.fill();
        ctx.strokeStyle = inspected ? "rgba(56, 189, 248, 0.90)" : this.t.glassBorder;
        ctx.lineWidth = inspected ? 2.5 : 1.5;
        ctx.stroke();

        // Badge pill
        ctx.fillStyle = inspected ? "rgba(56, 189, 248, 0.25)" : this.t.accentChip;
        roundRect(ctx, 22, 18, inspected ? 150 : 140, 30, 8);
        ctx.fill();
        ctx.strokeStyle = inspected ? "#38BDF8" : this.t.glassBorderSubtle;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.font = `700 13px ${MONO}`;
        ctx.fillStyle = inspected ? "#38BDF8" : this.t.accentText;
        ctx.fillText(inspected ? (this.pinnedPillar ? "📌 PINNED" : "INSPECTED") : "3D DISCRETE", 32, 38);

        // Chart Title
        ctx.font = `700 24px ${FONT}`;
        ctx.fillStyle = this.t.textPrimary;
        ctx.fillText(chart.title.slice(0, 34), 190, 40);

        // Subtitle
        ctx.font = `500 15px ${FONT}`;
        ctx.fillStyle = this.t.textMuted;
        if (inspected) {
          ctx.fillText(`📅 ${inspected.xLabel} • Channel: ${inspected.zLabel}`, 24, 88);
        } else {
          const meta =
            (chart.granularity === "day" ? "Daily" : `Per ${chart.granularity}`) +
            ` • Range: ${formatTick(minVal, chart.unit)} to ${formatTick(maxVal, chart.unit)} • ☩ Moveable`;
          ctx.fillText(meta, 24, 88);
        }

        // Value Display on the Right
        ctx.textAlign = "right";
        ctx.font = `800 32px ${FONT}`;
        ctx.fillStyle = inspected ? "#38BDF8" : this.t.textPrimary;
        const valText = inspected
          ? inspected.formattedValue
          : latestVal !== undefined && latestVal !== null
          ? formatValue(latestVal, chart.unit)
          : "";
        ctx.fillText(valText, 970, 44);

        ctx.font = `600 13px ${FONT}`;
        ctx.fillStyle = inspected ? "#7DD3FC" : this.t.textMuted;
        ctx.fillText(
          inspected ? (this.pinnedPillar ? "PINNED VALUE" : "HOVERED VALUE") : "LATEST VALUE",
          970,
          82
        );
        ctx.textAlign = "left";
      }
    );
  }

  dispose() {
    this.titlePanel.dispose();
    this.rimPanel.dispose();
    this.tooltipPanel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * 3D Sovereign Pavilion Dashboard.
 *
 * Holds the Floating Header HUD Capsule and an array of INDIVIDUAL 3D Discrete Column Graphs.
 * Positioned in an open, elegant spatial crescent gallery with clear sightlines to the Orb.
 */
export class Dashboard3D {
  readonly group = new THREE.Group();
  readonly headerGroup = new THREE.Group();
  readonly items: DraggableItem[] = [];
  readonly dashboardId: string;
  readonly graphs: Individual3DGraph[] = [];

  private headerPanel: CanvasPanel;
  private kpiPanel: CanvasPanel | null = null;
  private closeButton: CanvasPanel;
  private disposables: { dispose: () => void }[] = [];
  private t: ThemeConfig;

  constructor(dashboard: Dashboard, theme: "light" | "dark", renderer: THREE.WebGLRenderer, onClose: () => void) {
    this.dashboardId = dashboard.id;
    this.t = THEMES[theme];
    this.group.name = "dashboard-3d-root";

    const charts = dashboard.charts || [];

    // 1. Floating Header HUD Capsule Group (Sky Canopy, 3x High-DPI supersampling)
    this.headerGroup.name = "dashboard-header-group";
    this.group.add(this.headerGroup);

    this.headerPanel = new CanvasPanel({
      width: 1500,
      height: 120,
      worldWidth: 2.2,
      pixelRatio: 3,
      renderer,
      depthWrite: false,
      name: "dashboard-header-panel",
    });
    this.headerPanel.draw(dashboard.id, (ctx) => this.paintHeader(ctx, dashboard));
    this.headerPanel.mesh.position.set(0, 0, 0);
    this.headerGroup.add(this.headerPanel.mesh);

    // Interactive circular glass Close Button
    this.closeButton = new CanvasPanel({
      width: 110,
      height: 110,
      worldWidth: 0.13,
      pixelRatio: 3,
      renderer,
      depthWrite: false,
      name: "dashboard-close",
    });
    this.closeButton.draw("close", (ctx, w, h) => {
      ctx.fillStyle = this.t.bgGradTop;
      roundRect(ctx, 4, 4, w - 8, h - 8, (w - 8) / 2);
      ctx.fill();
      ctx.strokeStyle = this.t.glassBorder;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.strokeStyle = this.t.textSecondary;
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(34, 34);
      ctx.lineTo(76, 76);
      ctx.moveTo(76, 34);
      ctx.lineTo(34, 76);
      ctx.stroke();
    });
    this.closeButton.mesh.position.set(1.20, 0, 0.02);
    this.headerGroup.add(this.closeButton.mesh);

    // Floating KPI Glass Tiles (3x High-DPI supersampling)
    if (dashboard.kpis && dashboard.kpis.length > 0) {
      this.kpiPanel = new CanvasPanel({
        width: 1500,
        height: 105,
        worldWidth: 2.15,
        pixelRatio: 3,
        renderer,
        depthWrite: false,
        name: "dashboard-kpis",
      });
      this.kpiPanel.draw(`kpis-${dashboard.id}`, (ctx) => this.paintKpis(ctx, dashboard));
      this.kpiPanel.mesh.position.set(0, -0.20, 0.02);
      this.headerGroup.add(this.kpiPanel.mesh);
    }

    // Register Header as its own moveable DraggableItem
    this.items.push(
      {
        id: "dashboard-header",
        object: this.headerGroup,
        faceCamera: true,
      },
      {
        id: "dashboard-close",
        object: this.closeButton.mesh,
        fixed: true,
        onClick: onClose,
      }
    );

    // 2. Individual 3D Discrete Column Graphs with Hover & Click Inspection on EVERY bar
    charts.slice(0, 4).forEach((chart, i) => {
      const graph3D = new Individual3DGraph(chart, i, this.t, renderer);
      this.graphs.push(graph3D);
      this.group.add(graph3D.group);

      // Register EACH graph as its own independent DraggableItem!
      // faceCamera: false preserves the 3D perspective angle while dragging
      this.items.push({
        id: `dashboard-graph-${i}`,
        object: graph3D.group,
        faceCamera: false,
        onHoverDetail: (hit) => graph3D.inspectRay(hit, false),
        onClickDetail: (hit) => graph3D.inspectRay(hit, true),
      });
    });
  }

  /**
   * Layout each individual component in front of the viewer in 3D world space.
   * Arranges graphs in an open, elegant spatial crescent gallery with clear sightlines to the Orb.
   */
  layoutInFront(viewer?: THREE.Vector3, forward?: THREE.Vector3) {
    const eye = viewer ? viewer.clone() : new THREE.Vector3(0, 1.6, 5);
    const dir = (forward || new THREE.Vector3(0, 0, -1)).clone();
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();

    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const spawnDist = 2.80; // Comfortable distance so graphs have breathing room
    const center = eye.clone().addScaledVector(dir, spawnDist);
    center.y = THREE.MathUtils.clamp(eye.y - 0.05, 1.3, 1.7);

    const yaw = Math.atan2(eye.x - center.x, eye.z - center.z);

    // 1. Position Floating Header HUD Capsule well above (Canopy height)
    const headerPos = center.clone().add(new THREE.Vector3(0, 0.72, 0));
    this.headerGroup.position.copy(headerPos);
    this.headerGroup.rotation.set(0, yaw, 0);

    // 2. Position Each 3D Graph in a spacious Crescent Gallery
    const n = this.graphs.length;
    // Set graphs at showcase height (clear of the bottom dialogue bar)
    const graphY = center.y - 0.22;

    if (n === 1) {
      const g0 = this.graphs[0];
      g0.group.position.set(center.x, graphY, center.z);
      g0.group.rotation.set(0, yaw, 0);
    } else if (n === 2) {
      // 2 graphs side by side, center completely open
      const offsets = [-0.85, 0.85];
      this.graphs.forEach((g, i) => {
        const pos = center.clone().addScaledVector(right, offsets[i]);
        pos.addScaledVector(dir, 0.08); // Slight arc depth
        pos.y = graphY;
        g.group.position.copy(pos);
        g.group.rotation.set(0, yaw + (i === 0 ? 0.16 : -0.16), 0);
      });
    } else if (n === 3) {
      // 3 graphs in an arc with wide spacing
      const offsets = [-1.18, 0.0, 1.18];
      const yaws = [0.20, 0.0, -0.20];
      this.graphs.forEach((g, i) => {
        const pos = center.clone().addScaledVector(right, offsets[i]);
        // Arc depth curve
        pos.addScaledVector(dir, Math.abs(offsets[i]) * 0.10);
        pos.y = graphY;
        g.group.position.copy(pos);
        g.group.rotation.set(0, yaw + yaws[i], 0);
      });
    } else {
      // 4 graphs in a panoramic crescent gallery (Center is open for the Orb!)
      const offsets = [-1.65, -0.58, 0.58, 1.65];
      const yaws = [0.26, 0.09, -0.09, -0.26];
      this.graphs.forEach((g, i) => {
        const pos = center.clone().addScaledVector(right, offsets[i]);
        // Crescent curve: outer graphs pushed slightly forward or back for perfect viewing
        pos.addScaledVector(dir, (Math.abs(offsets[i]) - 0.58) * 0.12);
        pos.y = graphY;
        g.group.position.copy(pos);
        g.group.rotation.set(0, yaw + yaws[i], 0);
      });
    }
  }

  private paintHeader(ctx: CanvasRenderingContext2D, d: Dashboard) {
    const t = this.t;
    const w = 1500;
    const h = 120;

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, t.bgGradTop);
    grad.addColorStop(1, t.bgGradBottom);

    ctx.fillStyle = grad;
    roundRect(ctx, 4, 4, w - 8, h - 8, 20);
    ctx.fill();

    ctx.strokeStyle = t.glassBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 3D badge pill
    ctx.fillStyle = t.accentChip;
    roundRect(ctx, 24, 20, 52, 42, 12);
    ctx.fill();
    ctx.strokeStyle = t.glassBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = t.accentText;
    ctx.font = `700 20px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("3D", 50, 42);
    ctx.textAlign = "left";

    // Title
    ctx.fillStyle = t.textPrimary;
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText(d.title.slice(0, 52), 92, 42);

    // Subtitle & Question
    ctx.fillStyle = t.textSecondary;
    ctx.font = `500 16px ${FONT}`;
    const sub = d.subtitle || `For: “${d.question}”`;
    ctx.fillText(sub.slice(0, 90), 92, 78);

    // Right source badge
    ctx.fillStyle = t.textMuted;
    ctx.font = `500 14px ${MONO}`;
    ctx.textAlign = "right";
    const src = `SOURCE: ${d.source.document_name} • ${d.source.rows_used.toLocaleString()} ROWS`;
    ctx.fillText(src.slice(0, 55), w - 34, 42);
    ctx.fillText(d.question.slice(0, 60), w - 34, 78);
    ctx.textAlign = "left";
  }

  private paintKpis(ctx: CanvasRenderingContext2D, d: Dashboard) {
    const t = this.t;
    const n = Math.min(d.kpis.length, 4);
    if (!n) return;

    const w = 1500;
    const gap = 16;
    const tileW = (w - gap * (n - 1)) / n;

    d.kpis.slice(0, 4).forEach((k, i) => {
      const x = i * (tileW + gap);

      ctx.fillStyle = t.bgGradBottom;
      roundRect(ctx, x, 4, tileW, 97, 16);
      ctx.fill();
      ctx.strokeStyle = t.glassBorderSubtle;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = t.textSecondary;
      ctx.font = `600 15px ${FONT}`;
      ctx.fillText(k.label.slice(0, 28), x + 18, 28);

      let vx = x + 18;
      if (k.tone) {
        ctx.fillStyle = k.tone === "up" ? "#06B6D4" : "#F43F5E";
        ctx.font = `700 16px ${FONT}`;
        ctx.fillText(k.tone === "up" ? "▲" : "▼", vx, 64);
        vx += 22;
      }

      ctx.fillStyle = t.textPrimary;
      ctx.font = `800 32px ${FONT}`;
      ctx.fillText(k.display, vx, 66);

      if (k.sub) {
        ctx.fillStyle = t.textMuted;
        ctx.font = `500 13px ${FONT}`;
        ctx.fillText(k.sub.slice(0, 36), x + 18, 88);
      }
    });
  }

  dispose() {
    this.headerPanel.dispose();
    this.kpiPanel?.dispose();
    this.closeButton.dispose();
    this.graphs.forEach((g) => g.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
