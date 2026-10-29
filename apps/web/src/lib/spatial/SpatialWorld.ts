import * as THREE from "three";
import { Dashboard, DocumentRecord } from "../../types";
import { createDocTexture } from "../../components/docTextureHelper";
import { CanvasPanel } from "./CanvasPanel";
import { Dashboard3D } from "./Dashboard3D";
import { DraggableItem } from "./SpatialInteraction";
import { SpatialPlacement, spatialLayout } from "./spatialLayout";
import {
  SpatialState,
  dashboardButtonKey,
  dialogueKey,
  drawDashboardButton,
  drawDialoguePanel,
  drawOrbLabel,
  drawThinkingPanel,
  orbLabelKey,
  thinkingKey,
} from "./spatialPanels";
import { VoiceOrb3D } from "./VoiceOrb3D";

export interface SpatialWorldOptions {
  renderer: THREE.WebGLRenderer;
  theme: "light" | "dark";
  /** "pavilion" = podium room (main view); "void" = dark grid room (stereo viewer). */
  environment: "pavilion" | "void";
  documents: DocumentRecord[];
  onSelectDocument?: (doc: DocumentRecord) => void;
  onOrbTap?: () => void;
  /** The 3D "Create dashboard" button under the dialogue panel. */
  onCreateDashboard?: () => void;
  /** The close button on the 3D dashboard. */
  onCloseDashboard?: () => void;
}

const DEFAULTS: Record<string, SpatialPlacement> = {
  dialogue: { p: [-0.98, 1.48, -0.15], ry: 0.28 },
  thinking: { p: [1.32, 1.50, -0.05], ry: -0.36 },
  orb: { p: [0.15, 0.95, 0.70], ry: 0 },
};

function docDefault(i: number, n: number): SpatialPlacement {
  const theta = n <= 1 ? 0 : -0.85 + (1.7 * i) / (n - 1);
  const x = Math.sin(theta) * 2.5;
  const z = 0.3 - Math.cos(theta) * 2.5;
  return { p: [x, 1.48, z], ry: Math.atan2(-x, 0.3 - z) };
}

/** The 3D content shared by every immersive view. Each object can be moved independently. */
export class SpatialWorld {
  readonly scene = new THREE.Scene();
  /** Everything movable lives in here; positions are in this group's (= world) space. */
  readonly root = new THREE.Group();
  readonly items: DraggableItem[] = [];
  private dialogue: CanvasPanel;
  private thinking: CanvasPanel;
  private orbLabel: CanvasPanel;
  private orb: VoiceOrb3D;
  private orbGroup = new THREE.Group();
  private slabs: { group: THREE.Group; mesh: THREE.Mesh; id: string }[] = [];
  private dashboardButton: CanvasPanel;
  private dashboard3d: Dashboard3D | null = null;
  private dashboardFocus = 0;
  /** How far in front of the viewer new dashboards appear (VR has a much wider field of view). */
  spawnDistance = 2.3;
  private disposables: { dispose: () => void }[] = [];
  private unsubscribeReset: () => void;
  private opts: SpatialWorldOptions;

  constructor(opts: SpatialWorldOptions) {
    this.opts = opts;
    const isLight = opts.theme === "light" && opts.environment === "pavilion";
    this.scene.add(this.root);
    this.buildEnvironment(isLight);

    // Dialogue panel (3x supersampling)
    this.dialogue = new CanvasPanel({ width: 1200, height: 860, worldWidth: 1.9, pixelRatio: 3, renderer: opts.renderer, name: "dialogue" });
    this.root.add(this.dialogue.mesh);
    this.items.push({ id: "dialogue", object: this.dialogue.mesh });

    // "Create 3D dashboard" button, attached under the dialogue panel (moves with it, click only)
    this.dashboardButton = new CanvasPanel({ width: 620, height: 104, worldWidth: 0.95, pixelRatio: 3, renderer: opts.renderer, name: "dashboard-button" });
    this.dashboardButton.mesh.position.set(0, -(1.9 * 860) / 1200 / 2 - 0.1, 0.01);
    this.dashboardButton.mesh.visible = false;
    this.dialogue.mesh.add(this.dashboardButton.mesh);
    this.items.push({
      id: "dashboard-button",
      object: this.dashboardButton.mesh,
      fixed: true,
      onClick: () => this.opts.onCreateDashboard?.(),
    });

    // Reasoning panel (3x supersampling)
    this.thinking = new CanvasPanel({ width: 800, height: 640, worldWidth: 1.25, pixelRatio: 3, renderer: opts.renderer, name: "thinking" });
    this.root.add(this.thinking.mesh);
    this.items.push({ id: "thinking", object: this.thinking.mesh });

    // Voice orb + status label move together (3x supersampling)
    this.orb = new VoiceOrb3D(0.3);
    this.orbGroup.add(this.orb.group);
    this.orbLabel = new CanvasPanel({ width: 560, height: 120, worldWidth: 0.86, pixelRatio: 3, renderer: opts.renderer, name: "orb-label" });
    this.orbLabel.mesh.position.set(0, -0.47, 0);
    this.orbGroup.add(this.orbLabel.mesh);
    this.root.add(this.orbGroup);
    this.items.push({
      id: "orb",
      object: this.orbGroup,
      onClick: () => {
        this.orb.tapPulse();
        this.opts.onOrbTap?.();
      },
      onHover: (h) => this.orb.setHovered(h),
    });

    this.setDocuments(opts.documents);
    this.applyLayout();
    this.unsubscribeReset = spatialLayout.onReset(() => this.applyLayout());
  }

  private buildEnvironment(isLight: boolean) {
    const add = <T extends { dispose: () => void }>(d: T) => (this.disposables.push(d), d);
    if (this.opts.environment === "pavilion") {
      const bg = isLight ? 0xf2f2f7 : 0x040407;
      this.scene.background = new THREE.Color(bg);
      this.scene.fog = new THREE.FogExp2(bg, isLight ? 0.03 : 0.035);
      const podium = new THREE.Mesh(
        add(new THREE.CylinderGeometry(3.9, 4.1, 0.25, 72)),
        add(new THREE.MeshStandardMaterial({ color: isLight ? 0xe4e4ec : 0x1e1035, roughness: 0.65, metalness: 0.2 }))
      );
      podium.position.y = -0.12;
      this.scene.add(podium);
      const rim = new THREE.Mesh(
        add(new THREE.RingGeometry(3.85, 3.89, 96)),
        add(new THREE.MeshBasicMaterial({ color: isLight ? 0x7c3aed : 0xa855f7, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }))
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = 0.012;
      this.scene.add(rim);
    } else {
      this.scene.background = new THREE.Color(0x06040e);
      this.scene.fog = new THREE.FogExp2(0x06040e, 0.035);
      const grid = new THREE.GridHelper(30, 30, 0x8b5cf6, 0x1f192e);
      grid.position.y = -0.02;
      this.disposables.push(grid.geometry, grid.material as THREE.Material);
      this.scene.add(grid);
    }
    this.scene.add(new THREE.AmbientLight(0xffffff, isLight ? 0.6 : 0.65));
    const key = new THREE.DirectionalLight(0xfff8ee, isLight ? 0.7 : 0.85);
    key.position.set(4, 5, 3);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xe8e5f5, 0.4);
    fill.position.set(-4, 3, 2);
    this.scene.add(fill);
  }

  private clearSlabs() {
    for (const s of this.slabs) {
      this.root.remove(s.group);
      const mats = s.mesh.material as THREE.Material[];
      mats.forEach((m) => {
        (m as THREE.MeshBasicMaterial).map?.dispose();
        m.dispose();
      });
      s.mesh.geometry.dispose();
      const idx = this.items.findIndex((i) => i.id === s.id);
      if (idx >= 0) this.items.splice(idx, 1);
    }
    this.slabs = [];
  }

  /** Rebuild only the document slabs (keeps the rest of the scene and its placements). */
  setDocuments(documents: DocumentRecord[]) {
    this.clearSlabs();
    const docs = documents.slice(0, 6);
    const isLight = this.opts.theme === "light" && this.opts.environment === "pavilion";
    docs.forEach((doc, i) => {
      const tex = createDocTexture(doc, isLight, doc.original_name);
      const edge = new THREE.MeshStandardMaterial({ color: isLight ? 0xd9d3ee : 0x2a2140, roughness: 0.5 });
      const face = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, fog: false });
      // BoxGeometry face order: +x, -x, +y, -y, +z (front), -z (back)
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.88, 1.24, 0.03), [edge, edge, edge, edge, face, edge]);
      const group = new THREE.Group();
      group.add(mesh);
      this.root.add(group);
      const id = `doc:${doc.id || i}`;
      group.userData.defaultPlacement = docDefault(i, docs.length);
      spatialLayout.apply(id, group, group.userData.defaultPlacement);
      this.slabs.push({ group, mesh, id });
      this.items.push({
        id,
        object: group,
        onClick: () => this.opts.onSelectDocument?.(doc),
        onHover: (h) => mesh.scale.setScalar(h ? 1.04 : 1),
      });
    });
  }

  applyLayout() {
    if (this.dashboard3d) {
      const headerSaved = spatialLayout.get("dashboard-header");
      if (headerSaved) {
        spatialLayout.apply("dashboard-header", this.dashboard3d.headerGroup, headerSaved);
      }
      this.dashboard3d.graphs.forEach((g, idx) => {
        const graphSaved = spatialLayout.get(`dashboard-graph-${idx}`);
        if (graphSaved) {
          spatialLayout.apply(`dashboard-graph-${idx}`, g.group, graphSaved);
        }
      });
    }
    spatialLayout.apply("dialogue", this.dialogue.mesh, DEFAULTS.dialogue);
    spatialLayout.apply("thinking", this.thinking.mesh, DEFAULTS.thinking);
    spatialLayout.apply("orb", this.orbGroup, DEFAULTS.orb);
    for (const s of this.slabs) spatialLayout.apply(s.id, s.group, s.group.userData.defaultPlacement);
  }

  /** Put the dashboard in front of the viewer at eye height, facing them. */
  private placeInFront(group: THREE.Object3D, viewer?: THREE.Vector3, forward?: THREE.Vector3) {
    const eye = viewer || new THREE.Vector3(0, 1.6, 5);
    const dir = (forward || new THREE.Vector3(0, 0, -1)).clone();
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const dist = Math.min(this.spawnDistance, 2.6);
    const pos = eye.clone().addScaledVector(dir, dist);
    pos.y = THREE.MathUtils.clamp(eye.y - 0.05, 1.3, 1.7);
    group.position.copy(pos);
    group.rotation.set(0, Math.atan2(eye.x - pos.x, eye.z - pos.z), 0);
  }

  /** Show `dashboard` in 3D (replacing the previous one), or remove it when null. */
  private syncDashboard(dashboard: Dashboard | null, focus: number, viewer?: THREE.Vector3, forward?: THREE.Vector3) {
    const focusChanged = focus !== this.dashboardFocus;
    if (focusChanged) {
      this.dashboardFocus = focus;
    }

    const currentId = this.dashboard3d?.dashboardId || null;
    const targetId = dashboard?.id || null;

    if (currentId !== targetId) {
      if (this.dashboard3d) {
        this.root.remove(this.dashboard3d.group);
        for (const item of this.dashboard3d.items) {
          const i = this.items.indexOf(item);
          if (i >= 0) this.items.splice(i, 1);
        }
        this.dashboard3d.dispose();
        this.dashboard3d = null;
      }
      if (dashboard) {
        const theme = this.opts.theme === "light" && this.opts.environment === "pavilion" ? "light" : "dark";
        const d3 = new Dashboard3D(dashboard, theme, this.opts.renderer, () => this.opts.onCloseDashboard?.());
        this.dashboard3d = d3;
        this.root.add(d3.group);
        this.items.push(...d3.items);

        // Position individual graphs and header directly in front of viewer
        d3.layoutInFront(viewer, forward);
      }
    } else if (focusChanged && this.dashboard3d) {
      // User clicked "View in 3D" or refocused: bring right in front
      this.dashboard3d.layoutInFront(viewer, forward);
    }
  }

  /** Per-frame update. Panels only redraw when their content actually changes. */
  update(
    dt: number,
    now: number,
    state: SpatialState,
    levels: { mic: number; output: number },
    viewer?: THREE.Vector3,
    viewerForward?: THREE.Vector3
  ) {
    this.syncDashboard(state.dashboard, state.dashboardFocus, viewer, viewerForward);
    this.dashboardButton.mesh.visible = state.dashboardState !== "none";
    if (this.dashboardButton.mesh.visible) {
      this.dashboardButton.draw(dashboardButtonKey(state), (ctx, w, h) => drawDashboardButton(ctx, w, h, state));
    }
    this.dialogue.draw(dialogueKey(state), (ctx, w, h) => drawDialoguePanel(ctx, w, h, state));
    this.thinking.draw(thinkingKey(state, now), (ctx, w, h) => drawThinkingPanel(ctx, w, h, state, now));
    this.orbLabel.draw(orbLabelKey(state), (ctx, w, h) => drawOrbLabel(ctx, w, h, state));
    this.orb.update(dt, state.phase, state.conversation, levels.mic, levels.output);

    // the label under the orb always turns to the viewer
    if (viewer) {
      const local = this.orbGroup.worldToLocal(viewer.clone());
      this.orbLabel.mesh.rotation.y = Math.atan2(local.x, local.z);
    }
    const t = now / 1000;
    this.slabs.forEach((s, i) => {
      s.mesh.position.y = Math.sin(t * 0.8 + i * 1.3) * 0.025;
    });
  }

  dispose() {
    this.unsubscribeReset();
    this.clearSlabs();
    this.dashboard3d?.dispose();
    this.dashboardButton.dispose();
    this.dialogue.dispose();
    this.thinking.dispose();
    this.orbLabel.dispose();
    this.orb.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
