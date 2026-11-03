import * as THREE from "three";
import { Dashboard } from "../../types";
import { CanvasPanel, FONT, MONO, roundRect } from "./CanvasPanel";
import { DraggableItem } from "./SpatialInteraction";
import { THEMES, ThemeConfig } from "./dashboard3dShared";
import { Individual3DGraph } from "./Individual3DGraph";

// The column-graph class and shared theme/geometry live in Individual3DGraph.ts and dashboard3dShared.ts (Audit I-22)
export { Individual3DGraph } from "./Individual3DGraph";
export type { PillarData } from "./dashboard3dShared";

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
