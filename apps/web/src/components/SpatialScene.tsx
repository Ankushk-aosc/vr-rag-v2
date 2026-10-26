"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { setupWebXrControllers } from "../lib/webxr";
import { createDocTexture, DEFAULT_SPATIAL_DOCS } from "./docTextureHelper";
import Strands from "./Strands";
import { DocumentRecord } from "../types";
import { Compass } from "lucide-react";

interface SpatialSceneProps {
  onRendererReady?: (renderer: THREE.WebGLRenderer) => void;
  onSelectDocument?: (docName: string, doc?: DocumentRecord) => void;
  onVoiceOrbClick?: () => void;
  theme?: "dark" | "light";
  documents?: DocumentRecord[];
  isListening?: boolean;
  audioLevels?: number[];
  isProcessing?: boolean;
}

export function SpatialScene({
  onRendererReady,
  onSelectDocument,
  onVoiceOrbClick,
  theme = "light",
  documents,
  isListening = false,
  audioLevels,
  isProcessing = false,
}: SpatialSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const strandsAnchorRef = useRef<HTMLDivElement | null>(null);
  const isLight = theme === "light";
  const [hasGyro, setHasGyro] = useState<boolean>(false);
  const [canRequestMotion, setCanRequestMotion] = useState<boolean>(false);

  const onRendererReadyRef = useRef(onRendererReady);
  useEffect(() => {
    onRendererReadyRef.current = onRendererReady;
  }, [onRendererReady]);

  const onSelectDocumentRef = useRef(onSelectDocument);
  useEffect(() => {
    onSelectDocumentRef.current = onSelectDocument;
  }, [onSelectDocument]);

  const onVoiceOrbClickRef = useRef(onVoiceOrbClick);
  useEffect(() => {
    onVoiceOrbClickRef.current = onVoiceOrbClick;
  }, [onVoiceOrbClick]);

  const isListeningRef = useRef<boolean>(false);
  const audioLevelsRef = useRef<number[]>([15, 20, 30, 25, 18]);
  const isProcessingRef = useRef<boolean>(false);

  useEffect(() => {
    isProcessingRef.current = !!isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    isListeningRef.current = !!isListening;
  }, [isListening]);

  useEffect(() => {
    if (audioLevels && audioLevels.length > 0) {
      audioLevelsRef.current = audioLevels;
    }
  }, [audioLevels]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // 1. Scene, Camera, Renderer
    const scene = new THREE.Scene();
    const bgColor = isLight ? 0xF2F2F7 : 0x040407;
    scene.background = new THREE.Color(bgColor);
    scene.fog = new THREE.FogExp2(bgColor, isLight ? 0.04 : 0.045);

    const camera = new THREE.PerspectiveCamera(
      52,
      container.clientWidth / container.clientHeight,
      0.1,
      100
    );
    camera.position.set(0, 1.9, 5.0);
    camera.lookAt(0, 1.2, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = isLight ? 0.95 : 1.05;
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);

    if (onRendererReadyRef.current) onRendererReadyRef.current(renderer);

    // Setup WebXR 6DoF Laser Controllers
    setupWebXrControllers(scene, renderer);

    // 2. Architectural Gallery: Sovereign Royal Purple Circular Podium
    const podiumGeo = new THREE.CylinderGeometry(3.6, 3.8, 0.25, 64);
    const podiumMat = new THREE.MeshStandardMaterial({
      color: isLight ? 0xE4E4EC : 0x1E1035, // Sovereign royal purple in both light and dark mode
      roughness: isLight ? 0.6 : 0.7,
      metalness: isLight ? 0.15 : 0.25,
    });
    const podium = new THREE.Mesh(podiumGeo, podiumMat);
    podium.position.y = -0.12;
    scene.add(podium);

    // Clean subtle architectural contour hairline on podium
    const rimGeo = new THREE.RingGeometry(3.55, 3.58, 64);
    const rimMat = new THREE.MeshBasicMaterial({
      color: isLight ? 0x7C3AED : 0xA855F7,
      transparent: true,
      opacity: isLight ? 0.75 : 0.85,
      side: THREE.DoubleSide,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.01;
    scene.add(rim);

    // 3. Active Document Slabs Configuration
    const activeDocs: (DocumentRecord | null)[] =
      documents && documents.length > 0
        ? documents.slice(0, 5)
        : DEFAULT_SPATIAL_DOCS;

    const count = activeDocs.length;
    const docConfigs = activeDocs.map((doc, idx) => {
      const theta = count === 1 ? 0 : -0.85 + (1.7 * idx) / (count - 1);
      const radius = 2.85;
      const x = Math.sin(theta) * radius;
      const z = -Math.cos(theta) * radius + 1.25;
      const y = 1.35 + (idx % 2 === 0 ? 0.05 : -0.05);
      const rotY = -theta * 0.88;
      return {
        doc,
        title: doc ? doc.original_name : `Document ${idx + 1}`,
        pos: [x, y, z] as [number, number, number],
        rotY,
      };
    });

    const slabGeometry = new THREE.BoxGeometry(0.95, 1.35, 0.04);
    const slabEdgesGeometry = new THREE.EdgesGeometry(slabGeometry);
    const slabs: THREE.Mesh[] = [];

    docConfigs.forEach((cfg) => {
      const texture = createDocTexture(cfg.doc, isLight, cfg.title);
      const slabMat = new THREE.MeshPhysicalMaterial({
        map: texture,
        color: 0xFFFFFF, // Full dynamic range for canvas texture
        emissive: isLight ? 0x000000 : 0x1E1B2E,
        emissiveIntensity: isLight ? 0.0 : 0.15,
        roughness: 0.45, // Soft non-glaring surface so text is crystal clear
        metalness: 0.02,
        transparent: true,
        opacity: 1.0,
      });

      const slab = new THREE.Mesh(slabGeometry, slabMat);
      slab.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      slab.rotation.y = cfg.rotY;
      slab.userData = { title: cfg.title, originalY: cfg.pos[1], docRecord: cfg.doc };

      // Crisp vivid card edge border line
      const edgeLineMat = new THREE.LineBasicMaterial({
        color: isLight ? 0x6D28D9 : 0xA78BFA,
        transparent: true,
        opacity: isLight ? 0.8 : 0.9,
        linewidth: 2,
      });
      const wireframeBorder = new THREE.LineSegments(slabEdgesGeometry, edgeLineMat);
      wireframeBorder.raycast = () => {}; // Do not intercept raycasting from slab parent
      wireframeBorder.userData = { title: cfg.title, docRecord: cfg.doc };
      slab.add(wireframeBorder);

      scene.add(slab);
      slabs.push(slab);
    });

    // 4. Studio Lighting (Balanced to prevent overexposure/bleaching)
    scene.add(new THREE.AmbientLight(0xffffff, isLight ? 0.55 : 0.6));

    // Direct front fill light to illuminate document faces
    const frontLight = new THREE.DirectionalLight(0xffffff, isLight ? 0.45 : 0.65);
    frontLight.position.set(0, 2.0, 5.0);
    scene.add(frontLight);

    const keyLight = new THREE.DirectionalLight(0xfff8ee, isLight ? 0.65 : 0.85);
    keyLight.position.set(4, 5, 3);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xe8e5f5, isLight ? 0.35 : 0.45);
    fillLight.position.set(-4, 3, 2);
    scene.add(fillLight);

    // Clean architectural overhead studio light
    const overheadLight = new THREE.PointLight(0xffffff, isLight ? 0.35 : 0.45, 10);
    overheadLight.position.set(0, 3.5, -1);
    scene.add(overheadLight);

    // 5. Interactive Raycasting & Direct 1:1 Orbit Drag Controls
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2(-1000, -1000);

    let isDragging = false;
    let dragDistance = 0;
    let previousPosition = { x: 0, y: 0 };
    let cameraAngleY = 0;
    let cameraAngleX = 0;

    const updateCameraPosition = () => {
      const radius = 5.0;
      camera.position.x = radius * Math.sin(cameraAngleY) * Math.cos(cameraAngleX);
      camera.position.z = radius * Math.cos(cameraAngleY) * Math.cos(cameraAngleX);
      camera.position.y = 1.9 + radius * Math.sin(cameraAngleX);
      camera.lookAt(0, 1.2, 0);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (renderer.xr.isPresenting || e.button !== 0) return;
      isDragging = true;
      dragDistance = 0;
      previousPosition = { x: e.clientX, y: e.clientY };
      container.style.cursor = "grabbing";
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const isInside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      if (isInside) {
        mouse.x = ((e.clientX - rect.left) / container.clientWidth) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / container.clientHeight) * 2 + 1;
      } else if (!isDragging) {
        mouse.set(-1000, -1000);
      }

      if (!isDragging || renderer.xr.isPresenting) return;

      const deltaX = e.clientX - previousPosition.x;
      const deltaY = e.clientY - previousPosition.y;
      dragDistance += Math.hypot(deltaX, deltaY);

      cameraAngleY -= deltaX * 0.005;
      cameraAngleX = Math.max(-0.4, Math.min(0.6, cameraAngleX + deltaY * 0.005));

      updateCameraPosition();
      previousPosition = { x: e.clientX, y: e.clientY };
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      container.style.cursor = "grab";

      // Intentional click (< 6px movement)
      if (dragDistance < 6 && !renderer.xr.isPresenting) {
        camera.updateMatrixWorld();
        raycaster.setFromCamera(mouse, camera);

        // Click on Document Slab
        const intersects = raycaster.intersectObjects(slabs, true);
        if (intersects.length > 0) {
          let hitMesh: THREE.Object3D | null = intersects[0].object;
          while (hitMesh && !slabs.includes(hitMesh as THREE.Mesh)) {
            hitMesh = hitMesh.parent;
          }
          if (hitMesh) {
            const title = hitMesh.userData?.title;
            const docRecord = hitMesh.userData?.docRecord;
            if (title && onSelectDocumentRef.current) {
              onSelectDocumentRef.current(title, docRecord);
            }
          }
        }
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (renderer.xr.isPresenting || e.touches.length === 0) return;
      isDragging = true;
      dragDistance = 0;
      previousPosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging || renderer.xr.isPresenting || e.touches.length === 0) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - previousPosition.x;
      const deltaY = touch.clientY - previousPosition.y;
      dragDistance += Math.hypot(deltaX, deltaY);

      cameraAngleY -= deltaX * 0.005;
      cameraAngleX = Math.max(-0.4, Math.min(0.6, cameraAngleX + deltaY * 0.005));

      updateCameraPosition();
      previousPosition = { x: touch.clientX, y: touch.clientY };
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isDragging) return;
      isDragging = false;

      if (dragDistance < 6 && !renderer.xr.isPresenting && e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        const rect = container.getBoundingClientRect();
        mouse.x = ((touch.clientX - rect.left) / container.clientWidth) * 2 - 1;
        mouse.y = -((touch.clientY - rect.top) / container.clientHeight) * 2 + 1;
        camera.updateMatrixWorld();
        raycaster.setFromCamera(mouse, camera);

        // Touch on Document Slab
        const intersects = raycaster.intersectObjects(slabs, true);
        if (intersects.length > 0) {
          let hitMesh: THREE.Object3D | null = intersects[0].object;
          while (hitMesh && !slabs.includes(hitMesh as THREE.Mesh)) {
            hitMesh = hitMesh.parent;
          }
          if (hitMesh) {
            const title = hitMesh.userData?.title;
            const docRecord = hitMesh.userData?.docRecord;
            if (title && onSelectDocumentRef.current) {
              onSelectDocumentRef.current(title, docRecord);
            }
          }
        }
      }
    };

    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);

    // 7. Safe Gyroscope Tracking (Strictly for mobile or manual opt-in)
    let gyroBaselineAlpha: number | null = null;
    let gyroBaselineBeta: number | null = null;

    const onDeviceOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha === null || e.beta === null) return;
      if (gyroBaselineAlpha === null || gyroBaselineBeta === null) {
        gyroBaselineAlpha = e.alpha;
        gyroBaselineBeta = e.beta;
        return;
      }

      let deltaAlpha = e.alpha - gyroBaselineAlpha;
      deltaAlpha = ((deltaAlpha + 180) % 360) - 180;
      const deltaBeta = e.beta - gyroBaselineBeta;

      const gyroYaw = THREE.MathUtils.degToRad(-deltaAlpha) * 0.7;
      const gyroPitch = THREE.MathUtils.degToRad(Math.max(-25, Math.min(25, deltaBeta))) * 0.7;

      const radius = 5.0;
      const currentY = cameraAngleY + gyroYaw;
      const currentX = Math.max(-0.4, Math.min(0.6, cameraAngleX + gyroPitch));
      camera.position.x = radius * Math.sin(currentY) * Math.cos(currentX);
      camera.position.z = radius * Math.cos(currentY) * Math.cos(currentX);
      camera.position.y = 1.9 + radius * Math.sin(currentX);
      camera.lookAt(0, 1.2, 0);
    };

    // Gate gyroscope: ONLY attach on genuine mobile phones/tablets or when user requests motion
    const isRealMobile =
      typeof window !== "undefined" &&
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    if (isRealMobile && typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      if (typeof (DeviceOrientationEvent as any).requestPermission === "function") {
        setCanRequestMotion(true);
      } else {
        window.addEventListener("deviceorientation", onDeviceOrientation);
        setHasGyro(true);
      }
    }

    // 8. Animation Loop
    const clock = new THREE.Clock();

    renderer.setAnimationLoop(() => {
      const time = clock.getElapsedTime();

      // Floating document slabs with gentle breathing
      slabs.forEach((slab, idx) => {
        slab.position.y =
          slab.userData.originalY + Math.sin(time * 0.75 + idx * 1.5) * 0.04;
      });

      // Raycast hover check (only when not actively dragging)
      if (!isDragging) {
        raycaster.setFromCamera(mouse, camera);

        // Slab Hover Check
        const intersects = raycaster.intersectObjects(slabs, true);
        const isOverAnyCard = intersects.length > 0;
        container.style.cursor = isOverAnyCard ? "pointer" : "grab";
        slabs.forEach((slab) => {
          const isHovered = intersects.some(
            (hit) => hit.object === slab || hit.object.parent === slab
          );
          slab.scale.setScalar(isHovered ? 1.05 : 1.0);
        });
      } else {
        container.style.cursor = "grabbing";
        slabs.forEach((slab) => slab.scale.setScalar(1.0));
      }

      // Track 3D podium anchor for Strands visualizer (centered on podium floor among cards)
      if (strandsAnchorRef.current && container) {
        const anchor = new THREE.Vector3(0, 0.45, 0);
        anchor.project(camera);
        if (anchor.z < 1.0) {
          const x = (anchor.x * 0.5 + 0.5) * container.clientWidth;
          const y = (-anchor.y * 0.5 + 0.5) * container.clientHeight;
          strandsAnchorRef.current.style.transform = `translate3d(${x}px, ${y}px, 0px) translate(-50%, -50%)`;
        }
      }

      renderer.render(scene, camera);
    });

    // 9. Resize Handler
    const handleResize = () => {
      if (!container || renderer.xr.isPresenting) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      renderer.setAnimationLoop(null);
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("deviceorientation", onDeviceOrientation);
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [isLight, documents]);

  // Map frequency bands to normalized 0.0-1.0 scalar for Strands shader
  const micLevel = audioLevels && audioLevels.length > 0
    ? Math.min(1.0, Math.max(0.0, (audioLevels.reduce((a, b) => a + b, 0) / audioLevels.length - 15) / 75))
    : 0;

  const isActive = isListening || isProcessing;

  return (
    <div className="relative w-full h-full min-h-[500px] overflow-hidden select-none">
      <div
        ref={containerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing touch-none select-none"
      />

      {/* Interactive Strands 3D Podium Visualizer (Positioned on Podium between Cards) */}
      <div
        ref={strandsAnchorRef}
        className={`absolute top-0 left-0 pointer-events-none z-10 transition-opacity duration-500 ease-out ${
          isActive ? "opacity-100" : "opacity-0"
        }`}
        style={{
          transform: "translate3d(50%, 65%, 0px) translate(-50%, -50%)",
          willChange: "transform, opacity",
        }}
      >
        <div
          className={`w-[180px] sm:w-[220px] h-[180px] sm:h-[220px] relative pointer-events-auto cursor-pointer transition-transform duration-500 ease-out ${
            isActive ? "scale-100" : "scale-75"
          }`}
          onClick={() => onVoiceOrbClick?.()}
          title="Click to interact with Aether Voice Intelligence"
        >
          <Strands
            colors={["#7C3AED", "#8B5CF6", "#A855F7", "#C084FC", "#A855F7", "#8B5CF6", "#7C3AED", "#6D28D9"]}
            count={3}
            speed={isActive ? 1.35 : 0.85}
            amplitude={isActive ? 1.15 : 0.75}
            waviness={1}
            energy={isActive ? 0.75 : 0.45}
            thickness={1.1}
            spread={1}
            glow={1.2}
            taper={1}
            intensity={1.2}
            saturation={1}
            hueShift={0}
            scale={1}
            glass={false}
            glassSize={1}
            refraction={1}
            rim={1}
            dispersion={1}
            listening={isActive}
            level={micLevel}
            interactive={true}
            clickPulse={true}
            intro={true}
            lightMode={false}
          />
        </div>
      </div>

      {/* Telemetry Badge with Dynamic Voice Status */}
      <div
        className={`absolute top-28 left-6 pointer-events-none flex items-center space-x-2 text-[11px] font-medium px-3.5 py-1.5 rounded-full border backdrop-blur-2xl transition-all ${
          isLight
            ? "bg-white/80 border-black/10 text-black/75 shadow-sm"
            : "bg-black/50 border-white/10 text-white/70 shadow-lg"
        }`}
      >
        {isListening ? (
          <>
            <span className="w-2 h-2 rounded-full bg-violet-400 animate-ping" />
            <span className={isLight ? "text-purple-700 font-semibold" : "text-violet-300 font-semibold"}>
              Aether Voice Active • Neural Wave Resonance
            </span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6] animate-pulse" />
            <span>Aether Sovereign Pavilion • Spatial Evidence Room</span>
          </>
        )}
      </div>

      {/* Gyroscope Indicator / Enable Motion Action for iOS */}
      <div className="absolute top-28 right-6 flex items-center space-x-2">
        {hasGyro ? (
          <div
            className={`flex items-center space-x-1.5 text-[11px] font-medium px-3 py-1.5 rounded-full border backdrop-blur-2xl transition-all ${
              isLight
                ? "bg-white/80 border-black/10 text-emerald-700 shadow-sm"
                : "bg-black/50 border-emerald-500/30 text-emerald-300 shadow-lg"
            }`}
          >
            <Compass className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: "14s" }} />
            <span>Gyroscope Active</span>
          </div>
        ) : canRequestMotion ? (
          <button
            onClick={async () => {
              if (
                typeof DeviceOrientationEvent !== "undefined" &&
                typeof (DeviceOrientationEvent as any).requestPermission === "function"
              ) {
                try {
                  const perm = await (DeviceOrientationEvent as any).requestPermission();
                  if (perm === "granted") {
                    setHasGyro(true);
                    setCanRequestMotion(false);
                    window.location.reload();
                  }
                } catch (e) {
                  console.warn("Motion permission error:", e);
                }
              }
            }}
            className={`flex items-center space-x-1.5 text-[11px] font-medium px-3.5 py-1.5 rounded-full border backdrop-blur-2xl transition-all cursor-pointer hover:scale-105 active:scale-95 ${
              isLight
                ? "bg-purple-50 border-purple-300 text-purple-700 shadow-sm"
                : "bg-purple-950/60 border-purple-500/40 text-purple-200 shadow-lg"
            }`}
          >
            <Compass className="w-3.5 h-3.5" />
            <span>Enable Gyroscope</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
