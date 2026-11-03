import * as THREE from "three";
import { DashboardChart } from "../../types";
import { formatTick, formatValue, formatX } from "../charts/chartTheme";
import { CanvasPanel, FONT, MONO, roundRect } from "./CanvasPanel";
import { BOX_D, BOX_H, BOX_W, PillarData, ThemeConfig, niceTicks, valuesOf } from "./dashboard3dShared";


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
