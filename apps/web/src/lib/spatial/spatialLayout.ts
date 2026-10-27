import * as THREE from "three";

/**
 * Where the user has placed each 3D object (panels, orb, document slabs). Shared by the desktop
 * room, immersive WebXR and the stereo viewer, persisted in localStorage.
 */
export interface SpatialPlacement {
  p: [number, number, number];
  ry: number;
  s?: number;
}

const KEY = "aether_spatial_layout_v2";
type Layout = Record<string, SpatialPlacement>;
const listeners = new Set<() => void>();

function read(): Layout {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function write(layout: Layout) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable */
  }
}

export const spatialLayout = {
  get(id: string): SpatialPlacement | undefined {
    return read()[id];
  },
  save(id: string, obj: THREE.Object3D) {
    const layout = read();
    layout[id] = {
      p: [obj.position.x, obj.position.y, obj.position.z].map((v) => Math.round(v * 1000) / 1000) as [
        number,
        number,
        number
      ],
      ry: Math.round(obj.rotation.y * 1000) / 1000,
      s: Math.round(obj.scale.x * 1000) / 1000,
    };
    write(layout);
  },
  /** Apply a saved placement, or the default when there is none. */
  apply(id: string, obj: THREE.Object3D, fallback: SpatialPlacement) {
    const placed = read()[id] || fallback;
    obj.position.set(...placed.p);
    obj.rotation.set(0, placed.ry, 0);
    obj.scale.setScalar(placed.s || fallback.s || 1);
  },
  reset() {
    write({});
    listeners.forEach((l) => l());
  },
  onReset(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
