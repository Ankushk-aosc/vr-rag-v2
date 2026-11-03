/** Themes, tick maths, box geometry and pillar data shared by the 3D dashboard (split from Dashboard3D.ts, Audit I-22). */
import * as THREE from "three";
import { DashboardChart } from "../../types";

export const THEMES = {
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

export type ThemeConfig = typeof THEMES["dark"];

export function niceTicks(min: number, max: number, count = 4): number[] {
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

export function valuesOf(chart: DashboardChart): number[] {
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
export const BOX_W = 0.74; // Width along X
export const BOX_H = 0.38; // Height along Y
export const BOX_D = 0.52; // Depth along Z

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
