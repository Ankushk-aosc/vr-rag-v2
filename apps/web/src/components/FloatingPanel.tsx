"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GripHorizontal } from "lucide-react";
import { layoutStore, PanelRect, useLayoutState } from "../lib/layout/layoutStore";

export interface FloatingPanelProps {
  /** Stable id used to persist this panel's position. */
  id: string;
  /** Default rectangle, computed from the viewport size. */
  defaultRect: (vw: number, vh: number) => PanelRect;
  /** "both" = free resize, "x" = width only (height follows content), "none" = fixed size. */
  resize?: "both" | "x" | "none";
  minW?: number;
  minH?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Show the small grip pill on top (for panels without their own header). */
  showGrip?: boolean;
  theme?: "dark" | "light";
  children: React.ReactNode;
  ariaLabel?: string;
}

const EDGE_MARGIN = 8;
const NO_DRAG = "button, input, textarea, select, a, [data-no-drag], [contenteditable='true']";

function clampRect(r: PanelRect, vw: number, vh: number, minW: number, minH: number): PanelRect {
  const w = Math.min(Math.max(r.w, minW), vw - EDGE_MARGIN * 2);
  const h = Math.min(Math.max(r.h, minH), vh - EDGE_MARGIN * 2);
  // keep at least the header reachable on screen
  const x = Math.min(Math.max(r.x, EDGE_MARGIN - w + 80), vw - 80);
  const y = Math.min(Math.max(r.y, EDGE_MARGIN), vh - 48);
  return { x, y, w, h };
}

/**
 * A movable, resizable window. Drag it by any element marked `data-drag-handle` (or by the grip);
 * resize from the bottom-right corner. Position and size persist per browser.
 * Double-click a drag handle to snap the panel back to its default place.
 */
export function FloatingPanel({
  id,
  defaultRect,
  resize = "both",
  minW = 220,
  minH = 120,
  className = "",
  style,
  showGrip = false,
  theme = "light",
  children,
  ariaLabel,
}: FloatingPanelProps) {
  const layout = useLayoutState();
  const [viewport, setViewport] = useState<{ w: number; h: number } | null>(null);
  const [live, setLive] = useState<PanelRect | null>(null);
  const [dragging, setDragging] = useState<"move" | "resize" | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origin: PanelRect; mode: "move" | "resize" } | null>(null);
  const defaultRectRef = useRef(defaultRect);
  defaultRectRef.current = defaultRect;

  // a window that has just been opened belongs on top of the others
  useEffect(() => {
    layoutStore.bringToFront(id);
  }, [id]);

  useLayoutEffect(() => {
    const update = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const stored = layout.rects[id];
  const base: PanelRect | null = viewport
    ? clampRect(stored || defaultRectRef.current(viewport.w, viewport.h), viewport.w, viewport.h, minW, minH)
    : null;
  const rect = live || base;

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      layoutStore.bringToFront(id);
      if (e.button !== 0 || layoutStore.get().locked || !rect) return;
      const target = e.target as HTMLElement;
      const isResize = !!target.closest("[data-resize-handle]");
      const isHandle = !!target.closest("[data-drag-handle]");
      if (!isResize && (!isHandle || target.closest(NO_DRAG))) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startY: e.clientY, origin: rect, mode: isResize ? "resize" : "move" };
      setDragging(isResize ? "resize" : "move");
      setLive(rect);
    },
    [id, rect]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || !viewport) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const next =
        d.mode === "move"
          ? { ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy }
          : {
              ...d.origin,
              w: d.origin.w + dx,
              h: resize === "both" ? d.origin.h + dy : d.origin.h,
            };
      setLive(clampRect(next, viewport.w, viewport.h, minW, minH));
    },
    [viewport, resize, minW, minH]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      dragRef.current = null;
      setDragging(null);
      if (live) layoutStore.setRect(id, live);
      setLive(null);
    },
    [id, live]
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-drag-handle]") || target.closest(NO_DRAG) || !viewport) return;
      layoutStore.setRect(id, defaultRectRef.current(viewport.w, viewport.h));
    },
    [id, viewport]
  );

  // Re-clamp persisted panels when the window shrinks
  useEffect(() => {
    if (!viewport || !stored) return;
    const c = clampRect(stored, viewport.w, viewport.h, minW, minH);
    if (c.x !== stored.x || c.y !== stored.y || c.w !== stored.w || c.h !== stored.h) {
      layoutStore.setRect(id, c, false);
    }
  }, [viewport, stored, id, minW, minH]);

  if (!rect) return null;
  const isLight = theme === "light";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      className={`fixed group/panel ${dragging ? "select-none" : ""} ${className}`}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: resize === "both" || resize === "none" ? rect.h : undefined,
        zIndex: layoutStore.zIndexOf(id) + (dragging ? 100 : 0),
        transition: dragging ? "none" : "box-shadow 0.2s ease",
        boxShadow: dragging ? "0 30px 60px -20px rgba(76, 29, 149, 0.45)" : undefined,
        ...style,
      }}
    >
      {showGrip && !layout.locked && (
        <div
          data-drag-handle
          title="Drag to move • double-click to reset"
          className={`absolute -top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-0.5 rounded-full border cursor-grab active:cursor-grabbing opacity-0 group-hover/panel:opacity-100 transition-opacity touch-none ${
            isLight ? "bg-white border-black/15 text-black/50" : "bg-[#1C1C24] border-white/20 text-white/60"
          }`}
        >
          <GripHorizontal className="w-3.5 h-3.5 pointer-events-none" />
        </div>
      )}
      {children}
      {resize !== "none" && !layout.locked && (
        <div
          data-resize-handle
          title="Drag to resize"
          className={`absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize touch-none opacity-0 group-hover/panel:opacity-100 transition-opacity`}
        >
          <svg viewBox="0 0 20 20" className={`w-full h-full ${isLight ? "text-black/35" : "text-white/40"}`}>
            <path d="M15 7 L7 15 M15 11 L11 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  );
}
