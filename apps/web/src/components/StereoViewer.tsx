"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { AnaglyphEffect } from "three/examples/jsm/effects/AnaglyphEffect.js";
import { X, Eye, Glasses, Monitor, Move, RotateCcw } from "lucide-react";
import { DocumentRecord } from "../types";
import { SpatialWorld } from "../lib/spatial/SpatialWorld";
import { SpatialInteraction } from "../lib/spatial/SpatialInteraction";
import { SpatialState } from "../lib/spatial/spatialPanels";
import { spatialLayout } from "../lib/spatial/spatialLayout";
import { liveLevels } from "../lib/voice/voiceStore";
import { layoutStore } from "../lib/layout/layoutStore";
import { FloatingPanel } from "./FloatingPanel";

type ViewMode = "sbs" | "anaglyph" | "mono";

interface StereoViewerProps {
  isOpen: boolean;
  onClose: () => void;
  documents?: DocumentRecord[];
  stateRef: React.MutableRefObject<SpatialState>;
  onOrbTap?: () => void;
  onSelectDocument?: (doc: DocumentRecord) => void;
  onCreateDashboard?: () => void;
  onCloseDashboard?: () => void;
}

const IPD = 0.064;

export function StereoViewer({
  isOpen,
  onClose,
  documents,
  stateRef,
  onOrbTap,
  onSelectDocument,
  onCreateDashboard,
  onCloseDashboard,
}: StereoViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("mono");
  const viewModeRef = useRef<ViewMode>("mono");
  viewModeRef.current = viewMode;
  const callbacks = useRef({ onOrbTap, onSelectDocument, onCreateDashboard, onCloseDashboard });
  callbacks.current = { onOrbTap, onSelectDocument, onCreateDashboard, onCloseDashboard };
  const documentsRef = useRef(documents || []);
  documentsRef.current = documents || [];
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    const container = containerRef.current;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.touchAction = "none";
    container.appendChild(renderer.domElement);
    const anaglyph = new AnaglyphEffect(renderer);
    anaglyph.setSize(container.clientWidth, container.clientHeight);

    const world = new SpatialWorld({
      renderer,
      theme: "dark",
      environment: "void",
      documents: documentsRef.current,
      onOrbTap: () => callbacks.current.onOrbTap?.(),
      onSelectDocument: (doc) => callbacks.current.onSelectDocument?.(doc),
      onCreateDashboard: () => callbacks.current.onCreateDashboard?.(),
      onCloseDashboard: () => callbacks.current.onCloseDashboard?.(),
    });

    world.spawnDistance = 2.7;
    const eyeAspect = () => (viewModeRef.current === "sbs" ? container.clientWidth / 2 : container.clientWidth) / container.clientHeight;
    const camLeft = new THREE.PerspectiveCamera(70, eyeAspect(), 0.05, 100);
    const camRight = new THREE.PerspectiveCamera(70, eyeAspect(), 0.05, 100);
    const camMono = new THREE.PerspectiveCamera(70, eyeAspect(), 0.05, 100);

    const player = new THREE.Vector3(0, 1.6, 3.0);
    let yaw = 0;
    let pitch = -0.05;
    let gyro = { a: 0, b: 0, g: 0, active: false };

    const placeCameras = () => {
      const look = new THREE.Euler(
        THREE.MathUtils.clamp(pitch + (gyro.active ? gyro.b : 0), -1.2, 1.2),
        yaw + (gyro.active ? gyro.a : 0),
        gyro.active ? -gyro.g : 0,
        "YXZ"
      );
      const right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, look.y, 0));
      for (const [cam, offset] of [
        [camLeft, -IPD / 2],
        [camRight, IPD / 2],
        [camMono, 0],
      ] as [THREE.PerspectiveCamera, number][]) {
        cam.quaternion.setFromEuler(look);
        cam.position.copy(player).addScaledVector(right, offset);
        cam.updateMatrixWorld();
      }
    };
    placeCameras();

    const interaction = new SpatialInteraction({
      dom: renderer.domElement,
      scene: world.scene,
      getItems: () => world.items,
      isLocked: () => layoutStore.get().locked,
      pick: (clientX, clientY) => {
        const rect = renderer.domElement.getBoundingClientRect();
        const lx = clientX - rect.left;
        const ly = clientY - rect.top;
        if (viewModeRef.current === "sbs") {
          const half = rect.width / 2;
          const isRight = lx >= half;
          return {
            camera: isRight ? camRight : camLeft,
            ndc: new THREE.Vector2((((isRight ? lx - half : lx) / half) * 2) - 1, -(ly / rect.height) * 2 + 1),
          };
        }
        return { camera: camMono, ndc: new THREE.Vector2((lx / rect.width) * 2 - 1, -(ly / rect.height) * 2 + 1) };
      },
      onBackgroundDrag: (dx, dy) => {
        yaw -= dx * 0.0035;
        pitch = THREE.MathUtils.clamp(pitch - dy * 0.0035, -1.2, 1.2);
      },
    });

    const keys: Record<string, boolean> = {};
    const isTyping = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest?.("input, textarea");
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      keys[e.code] = true;
      if (e.code === "Escape") onCloseRef.current();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.code] = false;
    };
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null) return;
      gyro = {
        a: THREE.MathUtils.degToRad(e.alpha),
        b: THREE.MathUtils.degToRad((e.beta || 90) - 90),
        g: THREE.MathUtils.degToRad(e.gamma || 0),
        active: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
      };
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("deviceorientation", onOrientation);

    const clock = new THREE.Clock();
    const viewer = new THREE.Vector3();
    const forward = new THREE.Vector3();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.1);
      const speed = 2.6 * dt;
      const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      if (keys.KeyW || keys.ArrowUp) player.addScaledVector(forward, speed);
      if (keys.KeyS || keys.ArrowDown) player.addScaledVector(forward, -speed);
      if (keys.KeyA || keys.ArrowLeft) player.addScaledVector(right, -speed);
      if (keys.KeyD || keys.ArrowRight) player.addScaledVector(right, speed);
      if (keys.Space) player.y = Math.min(3.5, player.y + speed * 0.8);
      if (keys.ShiftLeft || keys.KeyC) player.y = Math.max(0.6, player.y - speed * 0.8);
      placeCameras();

      world.update(
        dt,
        performance.now(),
        stateRef.current,
        liveLevels,
        camMono.getWorldPosition(viewer),
        camMono.getWorldDirection(forward)
      );

      const w = container.clientWidth;
      const h = container.clientHeight;
      const mode = viewModeRef.current;
      const aspect = eyeAspect();
      [camLeft, camRight, camMono].forEach((c) => {
        if (c.aspect !== aspect) {
          c.aspect = aspect;
          c.updateProjectionMatrix();
        }
      });
      if (mode === "anaglyph") {
        renderer.setScissorTest(false);
        anaglyph.render(world.scene, camMono);
      } else if (mode === "mono") {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
        renderer.render(world.scene, camMono);
      } else {
        renderer.setScissorTest(true);
        renderer.setScissor(0, 0, w / 2, h);
        renderer.setViewport(0, 0, w / 2, h);
        renderer.render(world.scene, camLeft);
        renderer.setScissor(w / 2, 0, w / 2, h);
        renderer.setViewport(w / 2, 0, w / 2, h);
        renderer.render(world.scene, camRight);
        renderer.setScissorTest(false);
      }
    });

    const ro = new ResizeObserver(() => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      anaglyph.setSize(container.clientWidth, container.clientHeight);
    });
    ro.observe(container);

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("deviceorientation", onOrientation);
      interaction.dispose();
      world.dispose();
      anaglyph.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [isOpen, stateRef]);

  if (!isOpen) return null;

  const modeBtn = (mode: ViewMode, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => setViewMode(mode)}
      className={`px-3 py-1 rounded-full font-medium transition-all flex items-center space-x-1.5 ${
        viewMode === mode ? "bg-purple-600 text-white shadow-md" : "text-white/70 hover:text-white hover:bg-white/10"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] bg-[#06040e] select-none overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />

      {viewMode === "sbs" && (
        <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-gradient-to-b from-white/20 via-purple-500/30 to-white/20 pointer-events-none" />
      )}

      <FloatingPanel
        id="stereo-toolbar"
        theme="dark"
        resize="none"
        showGrip
        minW={300}
        minH={40}
        style={{ zIndex: 70 }}
        defaultRect={(vw) => ({ x: 24, y: 24, w: Math.min(520, vw - 110), h: 40 })}
      >
        <div
          data-drag-handle
          className="w-full h-full flex items-center space-x-1 bg-[#14121e] border border-white/15 p-1 rounded-full text-xs shadow-xl cursor-grab"
        >
          {modeBtn("mono", <Monitor className="w-3.5 h-3.5" />, "Desktop 6DoF")}
          {modeBtn("sbs", <Glasses className="w-3.5 h-3.5" />, "Split SBS")}
          {modeBtn("anaglyph", <Eye className="w-3.5 h-3.5 text-cyan-400" />, "Red/Cyan 3D")}
          <button
            onClick={() => spatialLayout.reset()}
            title="Reset 3D layout"
            className="ml-auto p-1.5 rounded-full text-white/70 hover:text-white hover:bg-white/10"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </FloatingPanel>

      <button
        onClick={onClose}
        aria-label="Exit stereo view"
        className="absolute top-6 right-6 z-[70] p-3 rounded-full bg-[#14121e] border border-white/20 text-white/90 hover:text-white hover:bg-white/10 transition-all shadow-lg"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-[#14121e] px-5 py-2 rounded-full border border-purple-500/30 text-xs text-white/80 flex items-center space-x-3 shadow-2xl pointer-events-none whitespace-nowrap">
        <span className="flex items-center gap-1 text-[#D4AF37]">
          <Move className="w-3.5 h-3.5" />
          <span className="font-mono font-bold">WASD</span>
        </span>
        <span className="text-white/60">walk • drag background to look • drag any panel to move it • tap orb to talk</span>
      </div>
    </div>
  );
}
