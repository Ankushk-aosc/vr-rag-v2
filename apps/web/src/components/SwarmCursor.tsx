"use client";

import React, { useEffect, useRef } from "react";
import "./SwarmCursor.css";
import {
  MAX_PARTICLES,
  INTRO_SECONDS,
  SHAPES,
  clamp,
} from "./swarm/swarmMath";
import { link, ShaderProgramLink } from "./swarm/swarmShaders";
import {
  SwarmSimulation,
  SwarmSettings,
  SwarmViewState,
} from "./swarm/swarmSimulation";

export interface SwarmCursorProps extends React.HTMLAttributes<HTMLDivElement> {
  count?: number;
  size?: number;
  shape?: "dot" | "square" | "streak";
  color?: string;
  accentColor?: string;
  spread?: number;
  speed?: number;
  swirl?: number;
  tail?: number;
  trail?: number;
  wander?: number;
  depth?: number;
  targets?: string;
  idle?: "roam" | "gather" | "hide";
  clickEffect?: "burst" | "pulse" | "none";
  hideCursor?: boolean;
  intro?: boolean;
  enabled?: boolean;
  lightMode?: boolean;
  dpr?: number;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const parseHexColor = (hex: string): [number, number, number] => {
  if (hex && hex.startsWith("#")) {
    const raw = hex.slice(1);
    if (raw.length === 6) {
      const r = parseInt(raw.slice(0, 2), 16) / 255;
      const g = parseInt(raw.slice(2, 4), 16) / 255;
      const b = parseInt(raw.slice(4, 6), 16) / 255;
      return [r, g, b];
    }
  }
  return [0.83, 0.68, 0.21]; // Sovereign Gold fallback
};

export function SwarmCursor({
  count = 800,
  size = 2.6,
  shape = "dot",
  color = "#D4AF37",
  accentColor = "#7C3AED",
  spread = 90,
  speed = 1,
  swirl = 0.6,
  tail = 0.5,
  trail = 0.6,
  wander = 0.5,
  depth = 0.7,
  targets = "a, button, input, [data-swarm-target]",
  idle = "roam",
  clickEffect = "burst",
  hideCursor = false,
  intro = true,
  enabled = true,
  lightMode = false,
  dpr,
  children,
  className = "",
  style,
  ...rest
}: SwarmCursorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wakeRef = useRef<(() => void) | null>(null);

  const settings: SwarmSettings = {
    count: Math.round(clamp(count, 1, MAX_PARTICLES)),
    size: clamp(size, 0.5, 16),
    shape: SHAPES[shape] ?? 0,
    color: color || "#D4AF37",
    accentColor: accentColor || color || "#7C3AED",
    spread: clamp(spread, 20, 400),
    speed: clamp(speed, 0, 4),
    swirl: clamp(swirl, 0, 1),
    tail: clamp(tail, 0, 1),
    trail: clamp(trail, 0, 3),
    wander: clamp(wander, 0, 2),
    depth: clamp(depth, 0, 1),
    targets,
    idle,
    clickEffect,
    hideCursor,
    intro,
    enabled,
    lightMode,
    dpr,
  };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return undefined;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) {
      console.warn("SwarmCursor: WebGL2 context not available.");
      return undefined;
    }

    const shader: ShaderProgramLink | null = link(gl);
    if (!shader) {
      console.warn("SwarmCursor: WebGL2 shaders could not be compiled.");
      return undefined;
    }
    const u = shader.uniforms;

    const slots = MAX_PARTICLES + 1;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const agentData = new Float32Array(slots * 4);
    const lookData = new Float32Array(slots * 4);
    const extraData = new Float32Array(slots * 2);

    const instanced = (location: number, width: number, data: Float32Array) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, width, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location, 1);
      return buffer;
    };

    const agentBuffer = instanced(1, 4, agentData);
    const lookBuffer = instanced(2, 4, lookData);
    const extraBuffer = instanced(3, 2, extraData);
    gl.bindVertexArray(null);

    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const view: SwarmViewState = { width: 1, height: 1, ratio: 1 };
    const sim = new SwarmSimulation();

    let raf = 0;
    let last = 0;
    let visible = true;

    const locate = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      return { x, y, inside: x >= 0 && y >= 0 && x <= rect.width && y <= rect.height };
    };

    const draw = () => {
      const s = settingsRef.current;
      const n = s.count;
      const fade = sim.introClock * sim.introClock * (3 - 2 * sim.introClock) * sim.presence;
      const zr = Math.max(s.spread * 0.55, 10);

      if (sim.sorted !== n) {
        for (let a = 0; a < n; a++) sim.order[a] = a;
        sim.sorted = n;
      }
      for (let a = 1; a < n; a++) {
        const value = sim.order[a];
        const key = sim.pz[value];
        let b = a - 1;
        while (b >= 0 && sim.pz[sim.order[b]] > key) {
          sim.order[b + 1] = sim.order[b];
          b--;
        }
        sim.order[b + 1] = value;
      }

      const flash = sim.burst.age < 1.2 ? Math.exp(-sim.burst.age / 0.3) : 0;
      const front = sim.ping.age * 520;
      let written = 0;

      for (let a = 0; a < n; a++) {
        const i = sim.order[a];
        const near = clamp(sim.pz[i] / zr, -1, 1);
        const scale = 1 + s.depth * 0.6 * near;
        const body = s.size * sim.grain[i] * scale;
        const soft = s.depth * s.size * (s.lightMode ? 0.35 : 1.4) * Math.pow(Math.abs(near), 1.6);
        const flat = Math.hypot(sim.vx[i], sim.vy[i]);
        const dx = flat > 0.001 ? sim.vx[i] / flat : 1;
        const dy = flat > 0.001 ? sim.vy[i] / flat : 0;
        let wave = 0;
        if (sim.ping.age < 1.6) {
          const offset = (Math.hypot(sim.px[i] - sim.ping.x, sim.py[i] - sim.ping.y) - front) / 40;
          wave = Math.exp(-offset * offset) * (1 - sim.ping.age / 1.6);
        }
        const tint = Math.max(clamp((flat - 380) / 900, 0, 1), flash, wave);
        const width = body * (1 + wave * 0.8);
        let length = width + Math.min(flat * s.trail * 0.02, body * 14);
        if (s.shape === 2) length = width * 2.6 + Math.min(flat * s.trail * 0.03, body * 18);
        const twinkle = 0.86 + 0.14 * Math.sin(sim.time * 3.1 + sim.glint[i]);
        const dim = 1 - s.depth * 0.45 * Math.max(0, -near);
        const o = written * 4;

        agentData[o] = sim.px[i];
        agentData[o + 1] = sim.py[i];
        agentData[o + 2] = dx;
        agentData[o + 3] = dy;
        lookData[o] = length;
        lookData[o + 1] = width;
        lookData[o + 2] = clamp(0.95 * dim * (body / (body + soft)) * twinkle * (1 + wave * 0.4), 0, 1) * fade;
        lookData[o + 3] = tint;
        extraData[written * 2] = soft;
        extraData[written * 2 + 1] = s.shape;
        written++;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!s.enabled || !written) return;

      gl.useProgram(shader.program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, agentBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, agentData, 0, written * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, lookBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, lookData, 0, written * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, extraBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, extraData, 0, written * 2);
      gl.uniform2f(u.uView, view.width, view.height);
      gl.uniform3fv(u.uColor, parseHexColor(s.color));
      gl.uniform3fv(u.uAccent, parseHexColor(s.accentColor));
      gl.uniform1f(u.uRatio, view.ratio);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, written);
      gl.bindVertexArray(null);
    };

    const frame = (now: number) => {
      raf = 0;
      if (!visible || (typeof document !== "undefined" && document.hidden)) return;
      const s = settingsRef.current;
      const dt = last ? clamp((now - last) / 1000, 0.001, 1 / 30) : 1 / 60;
      last = now;

      if (!s.enabled || reduce) {
        draw();
        return;
      }

      sim.time += dt;
      sim.burst.age += dt;
      sim.ping.age += dt;
      if (sim.introClock < 1) sim.introClock = Math.min(1, sim.introClock + dt / INTRO_SECONDS);
      const ease = sim.introClock * sim.introClock * (3 - 2 * sim.introClock);

      sim.hovered = sim.findTarget(container, s.targets);
      sim.updateAnchor(container, s, view, dt);
      sim.stir(s, dt, ease);
      sim.flow(s, dt);
      sim.move(s, view, dt / 2, ease);
      sim.move(s, view, dt / 2, ease);
      draw();
      raf = requestAnimationFrame(frame);
    };

    function wake() {
      if (!raf && visible && (typeof document === "undefined" || !document.hidden)) {
        raf = requestAnimationFrame(frame);
      }
    }

    const resize = () => {
      const s = settingsRef.current;
      const w = container.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 800);
      const h = container.clientHeight || (typeof window !== "undefined" ? window.innerHeight : 600);
      view.width = Math.max(1, w);
      view.height = Math.max(1, h);
      view.ratio = Math.min(s.dpr || (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1, 2);
      canvas.width = Math.max(1, Math.round(view.width * view.ratio));
      canvas.height = Math.max(1, Math.round(view.height * view.ratio));

      sim.allocate(view);
      if (!sim.seeded) {
        sim.seed();
        sim.updateAnchor(container, s, view, 0);
        if (reduce) {
          sim.anchor.x = view.width / 2;
          sim.anchor.y = view.height / 2;
        }
        sim.anchor.lastX = sim.anchor.x;
        sim.anchor.lastY = sim.anchor.y;
        sim.place(view, s, sim.introClock >= 1);
      }
      draw();
      wake();
    };

    const onPointerMove = (event: PointerEvent) => {
      const { x, y, inside } = locate(event);
      sim.pointer.x = x;
      sim.pointer.y = y;
      sim.pointer.inside = inside;
    };

    const onPointerDown = (event: PointerEvent) => {
      const s = settingsRef.current;
      const { x, y, inside } = locate(event);
      if (!inside || !s.enabled || reduce || s.clickEffect === "none") return;
      const reachOut = s.spread * 2.2;
      if (s.clickEffect === "pulse") {
        sim.ping.x = x;
        sim.ping.y = y;
        sim.ping.age = 0;
      } else {
        sim.burst.age = 0;
      }
      const kick = s.clickEffect === "pulse" ? 160 : 780;
      for (let i = 0; i < s.count; i++) {
        const dx = sim.px[i] - x;
        const dy = sim.py[i] - y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > reachOut) continue;
        const k = (1 - d / reachOut) * kick * (0.6 + 0.4 * sim.grain[i]);
        sim.vx[i] += (dx / d) * k;
        sim.vy[i] += (dy / d) * k;
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") sim.pointer.inside = false;
    };

    const onPointerLeave = () => {
      sim.pointer.inside = false;
    };

    const onVisibility = () => {
      last = 0;
      wake();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", onVisibility);

    resize();
    wakeRef.current = wake;

    return () => {
      cancelAnimationFrame(raf);
      wakeRef.current = null;
      resizeObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteBuffer(cornerBuffer);
      gl.deleteBuffer(agentBuffer);
      gl.deleteBuffer(lookBuffer);
      gl.deleteBuffer(extraBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(shader.program);
    };
  }, []);

  useEffect(() => {
    wakeRef.current?.();
  });

  return (
    <div
      ref={containerRef}
      className={`swarm-cursor fixed inset-0 w-full h-full pointer-events-none z-[1] overflow-hidden ${className}`}
      style={{ background: "transparent", ...style }}
      {...rest}
    >
      <canvas
        ref={canvasRef}
        className="swarm-cursor-canvas"
        style={{ background: "transparent" }}
        aria-hidden="true"
      />
      {children ? <div className="swarm-cursor-content">{children}</div> : null}
    </div>
  );
}

export default SwarmCursor;
