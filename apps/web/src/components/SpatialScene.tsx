"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Compass, Move3d, RotateCcw } from "lucide-react";
import { DocumentRecord } from "../types";
import { SpatialWorld } from "../lib/spatial/SpatialWorld";
import { SpatialInteraction } from "../lib/spatial/SpatialInteraction";
import { SpatialState } from "../lib/spatial/spatialPanels";
import { spatialLayout } from "../lib/spatial/spatialLayout";
import { liveLevels } from "../lib/voice/voiceStore";
import { layoutStore } from "../lib/layout/layoutStore";
import { FloatingPanel } from "./FloatingPanel";

interface SpatialSceneProps {
  onRendererReady?: (renderer: THREE.WebGLRenderer) => void;
  onSelectDocument?: (doc: DocumentRecord) => void;
  /** Tap on the 3D voice orb (desktop click or XR select). */
  onOrbTap?: () => void;
  onCreateDashboard?: () => void;
  onCloseDashboard?: () => void;
  theme?: "dark" | "light";
  documents?: DocumentRecord[];
  /** Latest dialogue / voice state, read every frame. */
  stateRef: React.MutableRefObject<SpatialState>;
  /** Skip rendering while another full-screen view (stereo viewer) is open. */
  paused?: boolean;
}

const TARGET = new THREE.Vector3(0, 1.3, 0);
const XR_STANDING_SPOT = new THREE.Vector3(0, 0, 2.7);

export function SpatialScene({
  onRendererReady,
  onSelectDocument,
  onOrbTap,
  onCreateDashboard,
  onCloseDashboard,
  theme = "light",
  documents,
  stateRef,
  paused = false,
}: SpatialSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<SpatialWorld | null>(null);
  const pausedRef = useRef(paused);
  const callbacks = useRef({ onRendererReady, onSelectDocument, onOrbTap, onCreateDashboard, onCloseDashboard });
  callbacks.current = { onRendererReady, onSelectDocument, onOrbTap, onCreateDashboard, onCloseDashboard };
  pausedRef.current = paused;
  const documentsRef = useRef(documents || []);
  const enableGyroRef = useRef<() => void>(() => {});
  const [canRequestMotion, setCanRequestMotion] = useState(false);
  const [hasGyro, setHasGyro] = useState(false);
  const isLight = theme === "light";

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3.0));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    // render panels at a higher resolution in the headset for legible text
    renderer.xr.setFramebufferScaleFactor(1.25);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = "none";
    callbacks.current.onRendererReady?.(renderer);

    const world = new SpatialWorld({
      renderer,
      theme: isLight ? "light" : "dark",
      environment: "pavilion",
      documents: documentsRef.current,
      onSelectDocument: (doc) => callbacks.current.onSelectDocument?.(doc),
      onOrbTap: () => callbacks.current.onOrbTap?.(),
      onCreateDashboard: () => callbacks.current.onCreateDashboard?.(),
      onCloseDashboard: () => callbacks.current.onCloseDashboard?.(),
    });
    worldRef.current = world;

    // Camera rig: the dolly is the user's "feet" in VR and the orbit pivot on desktop
    const dolly = new THREE.Group();
    world.scene.add(dolly);
    const camera = new THREE.PerspectiveCamera(52, container.clientWidth / container.clientHeight, 0.05, 100);
    dolly.add(camera);

    let yaw = 0;
    let pitch = 0.05;
    let radius = 2.45;
    let gyroYaw = 0;
    let gyroPitch = 0;
    const placeCamera = () => {
      const y = yaw + gyroYaw;
      const p = THREE.MathUtils.clamp(pitch + gyroPitch, -0.35, 0.75);
      camera.position.set(
        TARGET.x + radius * Math.sin(y) * Math.cos(p),
        TARGET.y + radius * Math.sin(p),
        TARGET.z + radius * Math.cos(y) * Math.cos(p)
      );
      camera.lookAt(TARGET);
    };
    placeCamera();

    const interaction = new SpatialInteraction({
      dom: renderer.domElement,
      scene: world.scene,
      getItems: () => world.items,
      renderer,
      xrParent: dolly,
      isLocked: () => layoutStore.get().locked,
      pick: (clientX, clientY) => {
        const rect = renderer.domElement.getBoundingClientRect();
        return {
          camera,
          ndc: new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
          ),
        };
      },
      onBackgroundDrag: (dx, dy) => {
        yaw -= dx * 0.005;
        pitch = THREE.MathUtils.clamp(pitch + dy * 0.004, -0.35, 0.75);
        placeCamera();
      },
      onBackgroundWheel: (dy) => {
        radius = THREE.MathUtils.clamp(radius * (1 + Math.sign(dy) * 0.08), 1.4, 6.5);
        placeCamera();
      },
      onThumbstick: (hand, x, y, dt) => {
        const head = renderer.xr.getCamera();
        if (hand === "right") {
          // smooth turn around the user's head
          const headPos = head.getWorldPosition(new THREE.Vector3());
          const angle = -x * dt * 1.6;
          dolly.position.sub(headPos).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).add(headPos);
          dolly.rotation.y += angle;
        } else {
          const forward = head.getWorldDirection(new THREE.Vector3());
          forward.y = 0;
          forward.normalize();
          const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
          dolly.position.addScaledVector(forward, -y * dt * 1.8).addScaledVector(right, x * dt * 1.8);
        }
      },
    });

    if (process.env.NODE_ENV !== "production") {
      // test hook: where is a 3D object on screen? (used by the browser end-to-end tests)
      (window as any).__spatialDebug = {
        ids: () => world.items.map((i) => i.id),
        screenOf: (id: string) => {
          const item = world.items.find((i) => i.id === id);
          if (!item) return null;
          const v = item.object.getWorldPosition(new THREE.Vector3()).project(camera);
          const r = renderer.domElement.getBoundingClientRect();
          return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, inView: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
        },
        positionOf: (id: string) => world.items.find((i) => i.id === id)?.object.getWorldPosition(new THREE.Vector3()).toArray(),
        objectVisible: (name: string) => {
          let visible = false;
          world.scene.traverse((o) => {
            if (o.name === name) visible = o.visible;
          });
          return visible;
        },
      };
    }

    const onSessionStart = () => {
      dolly.position.copy(XR_STANDING_SPOT);
      dolly.rotation.set(0, 0, 0);
      camera.position.set(0, 0, 0);
      camera.rotation.set(0, 0, 0);
    };
    const onSessionEnd = () => {
      dolly.position.set(0, 0, 0);
      dolly.rotation.set(0, 0, 0);
      placeCamera();
    };
    renderer.xr.addEventListener("sessionstart", onSessionStart);
    renderer.xr.addEventListener("sessionend", onSessionEnd);

    // Gyroscope look-around on phones / tablets
    let gyroBase: { a: number; b: number } | null = null;
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null) return;
      if (!gyroBase) gyroBase = { a: e.alpha, b: e.beta };
      const da = ((e.alpha - gyroBase.a + 540) % 360) - 180;
      gyroYaw = THREE.MathUtils.degToRad(-da) * 0.7;
      gyroPitch = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(e.beta - gyroBase.b, -25, 25)) * 0.7;
      placeCamera();
    };
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile && "DeviceOrientationEvent" in window) {
      if (typeof (DeviceOrientationEvent as any).requestPermission === "function") setCanRequestMotion(true);
      else {
        window.addEventListener("deviceorientation", onOrientation);
        setHasGyro(true);
      }
    }
    const enableGyro = () => {
      window.addEventListener("deviceorientation", onOrientation);
      setHasGyro(true);
      setCanRequestMotion(false);
    };
    enableGyroRef.current = enableGyro;

    const clock = new THREE.Clock();
    const viewer = new THREE.Vector3();
    const forward = new THREE.Vector3();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.1);
      if (pausedRef.current && !renderer.xr.isPresenting) return;
      interaction.update(dt);
      const eye = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
      world.spawnDistance = renderer.xr.isPresenting ? 2.3 : 3.2;
      eye.getWorldPosition(viewer);
      eye.getWorldDirection(forward);
      world.update(dt, performance.now(), stateRef.current, liveLevels, viewer, forward);
      renderer.render(world.scene, camera);
    });

    const onResize = () => {
      if (renderer.xr.isPresenting) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      // Leaving the room must also release the headset
      renderer.xr.getSession()?.end().catch(() => {});
      renderer.setAnimationLoop(null);
      ro.disconnect();
      if (process.env.NODE_ENV !== "production") delete (window as any).__spatialDebug;
      window.removeEventListener("deviceorientation", onOrientation);
      renderer.xr.removeEventListener("sessionstart", onSessionStart);
      renderer.xr.removeEventListener("sessionend", onSessionEnd);
      interaction.dispose();
      world.dispose();
      worldRef.current = null;
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [isLight, stateRef]);

  // Swap document slabs in place instead of rebuilding the whole scene
  useEffect(() => {
    documentsRef.current = documents || [];
    worldRef.current?.setDocuments(documentsRef.current);
  }, [documents]);

  return (
    <div className="relative w-full h-full overflow-hidden select-none">
      <div ref={containerRef} className="w-full h-full" />

      {/* Subtle enterprise workspace layer */}
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity ${
          isLight ? "bg-gradient-to-b from-white/20 via-transparent to-slate-100/40" : "bg-gradient-to-b from-black/20 via-transparent to-black/40"
        }`}
      />

      {/* Discreet 3D interaction hint */}
      <div className="absolute bottom-5 left-5 z-20 hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[11px] font-medium backdrop-blur-md transition-all shadow-sm bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">
        <Move3d className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
        <span>Spatial Workspace • Drag to inspect 3D items</span>
        <button
          onClick={() => spatialLayout.reset()}
          title="Reset 3D layout"
          className="ml-1 p-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      </div>

      {(hasGyro || canRequestMotion) && (
        <div className="absolute top-28 right-6 z-20">
          {hasGyro ? (
            <div
              className={`flex items-center space-x-1.5 text-[11px] font-medium px-3 py-1.5 rounded-full border ${
                isLight ? "bg-white border-black/10 text-emerald-700" : "bg-black/60 border-emerald-500/30 text-emerald-300"
              }`}
            >
              <Compass className="w-3.5 h-3.5" />
              <span>Gyroscope active</span>
            </div>
          ) : (
            <button
              onClick={async () => {
                try {
                  const perm = await (DeviceOrientationEvent as any).requestPermission();
                  if (perm === "granted") enableGyroRef.current();
                } catch (e) {
                  console.warn("Motion permission error:", e);
                }
              }}
              className={`flex items-center space-x-1.5 text-[11px] font-medium px-3.5 py-1.5 rounded-full border ${
                isLight ? "bg-purple-50 border-purple-300 text-purple-700" : "bg-purple-950/60 border-purple-500/40 text-purple-200"
              }`}
            >
              <Compass className="w-3.5 h-3.5" />
              <span>Enable gyroscope</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
