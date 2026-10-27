"use client";

import React from "react";
import { BarChart3, Box, Trash2, X } from "lucide-react";
import { Dashboard } from "../types";
import { FloatingPanel } from "./FloatingPanel";
import { DashboardView } from "./DashboardView";

interface DashboardPanelProps {
  isOpen: boolean;
  dashboards: Dashboard[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
  onViewIn3D: () => void;
  theme?: "dark" | "light";
}

/** Movable, resizable window holding the generated dashboards (one tab per dashboard). */
export function DashboardPanel({
  isOpen,
  dashboards,
  activeId,
  onSelect,
  onRemove,
  onClose,
  onViewIn3D,
  theme = "light",
}: DashboardPanelProps) {
  if (!isOpen || dashboards.length === 0) return null;
  const active = dashboards.find((d) => d.id === activeId) || dashboards[dashboards.length - 1];
  const isLight = theme === "light";
  const iconBtn = `p-1.5 rounded-full transition-colors ${
    isLight ? "text-black/50 hover:text-black hover:bg-black/5" : "text-white/50 hover:text-white hover:bg-white/10"
  }`;

  return (
    <FloatingPanel
      id="dashboard"
      theme={theme}
      ariaLabel="Dashboard"
      minW={360}
      minH={320}
      defaultRect={(vw, vh) => {
        const w = Math.min(780, vw - 48);
        return { x: 24, y: 104, w, h: Math.min(660, vh - 200) };
      }}
    >
      <section
        className={`w-full h-full flex flex-col rounded-2xl border shadow-2xl overflow-hidden ${
          isLight ? "bg-[#f9f9f7] border-black/10 text-black" : "bg-[#0d0d0d] border-white/10 text-white"
        }`}
      >
        <header
          data-drag-handle
          title="Drag to move • double-click to reset position"
          className={`px-4 pt-3 pb-2 border-b cursor-grab active:cursor-grabbing touch-none ${
            isLight ? "border-black/10" : "border-white/10"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 pointer-events-none">
              <div className="flex items-center gap-2">
                <BarChart3 className={`w-4 h-4 flex-shrink-0 ${isLight ? "text-[#6D28D9]" : "text-[#C4B5FD]"}`} />
                <h3 className="text-sm font-semibold truncate">{active.title}</h3>
              </div>
              {active.subtitle && (
                <p className={`text-[11px] mt-0.5 truncate ${isLight ? "text-black/55" : "text-white/55"}`}>{active.subtitle}</p>
              )}
              <p className={`text-[10.5px] mt-0.5 truncate ${isLight ? "text-black/40" : "text-white/40"}`}>
                For: “{active.question}”
              </p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={onViewIn3D}
                title="Show this dashboard in the 3D room / VR"
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                  isLight ? "bg-[#6D28D9] text-white hover:bg-[#5B21B6]" : "bg-[#7C3AED] text-white hover:bg-[#6D28D9]"
                }`}
              >
                <Box className="w-3.5 h-3.5" /> View in 3D
              </button>
              <button onClick={() => onRemove(active.id)} title="Delete this dashboard" className={iconBtn}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button onClick={onClose} title="Hide dashboards" className={iconBtn}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          {dashboards.length > 1 && (
            <div className="flex gap-1.5 mt-2 overflow-x-auto pb-0.5" data-no-drag>
              {dashboards.map((d) => (
                <button
                  key={d.id}
                  onClick={() => onSelect(d.id)}
                  className={`px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap border transition-colors ${
                    d.id === active.id
                      ? isLight
                        ? "bg-black text-white border-black"
                        : "bg-white text-black border-white"
                      : isLight
                      ? "border-black/10 text-black/65 hover:bg-black/5"
                      : "border-white/15 text-white/65 hover:bg-white/10"
                  }`}
                >
                  {d.title}
                </button>
              ))}
            </div>
          )}
        </header>
        <div className="flex-1 overflow-y-auto p-3.5 select-text">
          <DashboardView dashboard={active} theme={theme} />
        </div>
      </section>
    </FloatingPanel>
  );
}
