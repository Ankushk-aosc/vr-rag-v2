"use client";

import React, { useEffect, useRef } from "react";
import { liveLevels } from "../lib/voice/voiceStore";

interface LevelBarsProps {
  source: "mic" | "output";
  bars?: number;
  className?: string;
  barClassName?: string;
}

/** Waveform bars driven straight from the voice engine's live levels (no React re-renders). */
export function LevelBars({ source, bars = 5, className = "", barClassName = "" }: LevelBarsProps) {
  const refs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    let raf = 0;
    const phases = Array.from({ length: bars }, (_, i) => i * 1.7);
    const loop = (t: number) => {
      const level = liveLevels[source];
      refs.current.forEach((el, i) => {
        if (!el) return;
        const wobble = 0.55 + 0.45 * Math.abs(Math.sin(t / 140 + phases[i]));
        const h = 18 + Math.min(82, level * 100 * wobble * (i % 2 ? 0.85 : 1));
        el.style.height = `${h}%`;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [source, bars]);

  return (
    <div className={`flex items-center gap-[3px] h-6 ${className}`} aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`w-[3px] rounded-full aether-wave-gradient ${barClassName}`}
          style={{ height: "18%" }}
        />
      ))}
    </div>
  );
}
