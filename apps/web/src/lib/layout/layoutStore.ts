import { useSyncExternalStore } from "react";

/** Persisted positions/sizes of the floating 2D panels (per browser, via localStorage). */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayoutState {
  rects: Record<string, PanelRect>;
  hidden: Record<string, boolean>;
  order: string[];
  locked: boolean;
  /** Bumped on reset so panels recompute their default rectangles. */
  version: number;
}

const STORAGE_KEY = "aether_panel_layout_v2";

function load(): LayoutState {
  const empty: LayoutState = { rects: {}, hidden: {}, order: [], locked: false, version: 0 };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return { ...empty, ...parsed, version: 0 };
  } catch {
    return empty;
  }
}

let state: LayoutState | null = null;
const listeners = new Set<() => void>();

function current(): LayoutState {
  if (!state) state = load();
  return state;
}

function commit(next: LayoutState, persist = true) {
  state = next;
  if (persist && typeof window !== "undefined") {
    try {
      const { version, ...rest } = next;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch {
      /* storage blocked (private mode) - layout just won't persist */
    }
  }
  listeners.forEach((l) => l());
}

export const layoutStore = {
  get: current,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setRect(id: string, rect: PanelRect, persist = true) {
    const s = current();
    commit({ ...s, rects: { ...s.rects, [id]: rect } }, persist);
  },
  bringToFront(id: string) {
    const s = current();
    if (s.order[s.order.length - 1] === id) return;
    commit({ ...s, order: [...s.order.filter((o) => o !== id), id] }, false);
  },
  setHidden(id: string, hidden: boolean) {
    const s = current();
    commit({ ...s, hidden: { ...s.hidden, [id]: hidden } });
  },
  toggleLocked() {
    const s = current();
    commit({ ...s, locked: !s.locked });
  },
  resetAll() {
    const s = current();
    commit({ rects: {}, hidden: {}, order: [], locked: false, version: s.version + 1 });
  },
  zIndexOf(id: string): number {
    const idx = current().order.indexOf(id);
    return 30 + (idx < 0 ? 0 : idx + 1);
  },
};

const serverState: LayoutState = { rects: {}, hidden: {}, order: [], locked: false, version: 0 };

export function useLayoutState(): LayoutState {
  return useSyncExternalStore(layoutStore.subscribe, current, () => serverState);
}
