"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { X, Smartphone, Compass } from "lucide-react";
import { DocumentRecord } from "../types";
import { createVoiceParticleOrb } from "./VoiceParticleOrb";
import { DEFAULT_SPATIAL_DOCS } from "./docTextureHelper";

interface StereoViewerProps {
  isOpen: boolean;
  onClose: () => void;
  documents?: DocumentRecord[];
  isListening?: boolean;
  audioLevels?: number[];
}

export function StereoViewer({
  isOpen,
  onClose,
  documents,
  isListening = false,
  audioLevels,
}: StereoViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hasGyro, setHasGyro] = useState<boolean>(false);

  const isListeningRef = useRef<boolean>(false);
  const audioLevelsRef = useRef<number[]>([15, 20, 30, 25, 18]);

  useEffect(() => {
    isListeningRef.current = !!isListening;
  }, [isListening]);

  useEffect(() => {
    if (audioLevels && audioLevels.length > 0) {
      audioLevelsRef.current = audioLevels;
    }
  }, [audioLevels]);

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    const container = containerRef.current;

    // 1. Scene & Environment
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x06040e, 0.04);

    const aspect = (container.clientWidth / 2) / container.clientHeight;
    const cameraLeft = new THREE.PerspectiveCamera(65, aspect, 0.1, 100);
    const cameraRight = new THREE.PerspectiveCamera(65, aspect, 0.1, 100);

    // Human IPD (~64mm offset)
    const ipd = 0.032;
    cameraLeft.position.set(-ipd, 1.6, 2.2);
    cameraRight.position.set(ipd, 1.6, 2.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setScissorTest(true);
    container.appendChild(renderer.domElement);

    // Architectural Ground Grid
    const gridHelper = new THREE.GridHelper(30, 30, 0x8b5cf6, 0x1f192e);
    gridHelper.position.y = -0.05;
    scene.add(gridHelper);

    // Warm Studio Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const goldLight = new THREE.PointLight(0xd4af37, 2, 12);
    goldLight.position.set(0, 3, 1);
    scene.add(goldLight);

    const ambientFillLight = new THREE.PointLight(0xffffff, 1.2, 15);
    ambientFillLight.position.set(0, 1.8, -2);
    scene.add(ambientFillLight);

    // 2. Texture Generator for Real Financial Document Slabs
    const texturesToDispose: THREE.Texture[] = [];
    const geometriesToDispose: THREE.BufferGeometry[] = [];
    const materialsToDispose: THREE.Material[] = [];

    const createDocTexture = (
      doc: DocumentRecord | null,
      fallbackTitle: string = "AAPL Financial Ledger",
      fallbackSub: string = "11,558 Rows • AUD Synthesized",
      fallbackCode: string = "AAPL • FY20-24"
    ) => {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 724;
      const ctx = canvas.getContext("2d")!;

      const ext = doc ? doc.original_name.split(".").pop()?.toUpperCase() || "DOC" : "DOC";
      const title = doc ? doc.original_name : fallbackTitle;
      const sizeKb = doc ? (doc.file_size / 1024).toFixed(0) : "500";
      const totalPages = doc ? doc.total_pages : 1;
      const subtitle = doc
        ? `${totalPages} Page(s) • ${sizeKb} KB • Verified Ledger`
        : fallbackSub;
      const code = doc
        ? `${ext} • ${doc.file_hash.slice(0, 8).toUpperCase()}`
        : fallbackCode;

      // Dark slate-purple background gradient
      const grad = ctx.createLinearGradient(0, 0, 0, 724);
      grad.addColorStop(0, "#231f36");
      grad.addColorStop(1, "#151224");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 512, 724);

      // Luminous purple border
      ctx.strokeStyle = "rgba(167, 139, 250, 0.75)";
      ctx.lineWidth = 8;
      ctx.strokeRect(12, 12, 488, 700);

      // Gold top hairline
      ctx.fillStyle = "#d4af37";
      ctx.fillRect(40, 40, 432, 5);

      // Document Code / Seal
      ctx.font = "bold 20px monospace";
      ctx.fillStyle = "#c4b5fd";
      ctx.fillText(code, 40, 85);

      // Format Pill in Top Right
      ctx.fillStyle = "rgba(167, 139, 250, 0.25)";
      ctx.beginPath();
      ctx.roundRect(360, 62, 110, 32, 16);
      ctx.fill();
      ctx.fillStyle = "#d4af37";
      ctx.font = "bold 16px monospace";
      ctx.textAlign = "center";
      ctx.fillText(ext, 415, 84);
      ctx.textAlign = "start";

      // Document Title
      ctx.font = "bold 24px sans-serif";
      ctx.fillStyle = "#ffffff";
      const words = title.split(/[_\s]+/);
      let line = "";
      let lineY = 135;
      for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + " ";
        const metrics = ctx.measureText(testLine);
        if (metrics.width > 420 && n > 0) {
          ctx.fillText(line.trim(), 40, lineY);
          line = words[n] + " ";
          lineY += 30;
          if (lineY > 170) break;
        } else {
          line = testLine;
        }
      }
      if (line.trim() && lineY <= 170) {
        ctx.fillText(line.trim(), 40, lineY);
      }

      // Subtitle
      ctx.font = "18px sans-serif";
      ctx.fillStyle = "#a78bfa";
      ctx.fillText(subtitle, 40, 202);

      // Financial Data Header
      ctx.fillStyle = "rgba(139, 92, 246, 0.2)";
      ctx.fillRect(40, 226, 432, 34);
      ctx.font = "bold 13px monospace";
      ctx.fillStyle = "#c4b5fd";
      ctx.fillText("DATE       OPEN    HIGH    CLOSE    VOL", 50, 248);

      // AAPL Financial Sample Rows
      ctx.font = "13px monospace";
      const sampleRows = [
        "2020-04-01  59.45   59.99   58.11   176.2M",
        "2020-04-02  57.97   59.13   59.08   165.9M",
        "2020-04-03  58.56   59.26   58.23   129.8M",
        "2020-04-06  60.12   61.50   60.75   201.3M",
        "2020-04-07  63.15   64.00   62.54   187.5M",
        "2020-04-08  62.50   63.75   63.02   168.0M",
        "2020-04-09  63.80   67.44   67.09   201.1M",
        "2020-04-13  67.08   67.20   65.85   131.0M",
        "2020-04-14  67.50   71.72   71.70   194.9M",
        "2020-04-15  70.60   71.58   71.11   131.1M",
      ];

      sampleRows.forEach((rowText, idx) => {
        const yPos = 290 + idx * 36;
        if (yPos < 650) {
          if (idx % 2 === 0) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
            ctx.fillRect(40, yPos - 18, 432, 30);
          }
          ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
          ctx.fillText(rowText, 50, yPos);
        }
      });

      // Verification seal footer
      ctx.font = "bold 13px monospace";
      ctx.fillStyle = "#d4af37";
      ctx.fillText(
        doc ? `SHA-256: ${doc.file_hash.slice(0, 20)}... • AUD LEDGER` : "VERIFIED AUD RECORD • AETHER SOVEREIGN",
        40,
        680
      );

      const texture = new THREE.CanvasTexture(canvas);
      texture.anisotropy = 4;
      texturesToDispose.push(texture);
      return texture;
    };

    // 3. Fallback Documents (Real AAPL data matching SQLite DB)
    const activeDocs: (DocumentRecord | null)[] =
      documents && documents.length > 0
        ? documents.slice(0, 5)
        : DEFAULT_SPATIAL_DOCS;

    // 4. Construct Floating Document Slabs along an arc
    const count = activeDocs.length;
    const slabGeo = new THREE.BoxGeometry(0.85, 1.2, 0.025);
    geometriesToDispose.push(slabGeo);

    const docMeshes: THREE.Mesh[] = [];

    activeDocs.forEach((doc, idx) => {
      const theta = count === 1 ? 0 : -0.75 + (1.5 * idx) / (count - 1);
      const radius = 2.6;
      const x = Math.sin(theta) * radius;
      const z = -Math.cos(theta) * radius + 1.2;
      const y = 1.6 + (idx % 2 === 0 ? 0.04 : -0.04);

      const texture = createDocTexture(doc);
      const frontMat = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.35,
        metalness: 0.15,
      });
      const backMat = new THREE.MeshStandardMaterial({
        color: 0x181528,
        roughness: 0.8,
      });
      materialsToDispose.push(frontMat, backMat);

      const materials = [backMat, backMat, backMat, backMat, frontMat, backMat];
      const mesh = new THREE.Mesh(slabGeo, materials);
      mesh.position.set(x, y, z);
      mesh.rotation.y = -theta;
      mesh.userData = { initialY: y };
      scene.add(mesh);
      docMeshes.push(mesh);
    });

    // 4.5. Floating 3D Voice Sphere in Stereoscopic Room
    const voiceOrb = createVoiceParticleOrb(false);
    voiceOrb.group.position.set(0, 1.35, -0.6);
    scene.add(voiceOrb.group);

    // 5. Controls: Damped Gyroscope with Unified Pointer Orbit
    let targetAlpha = 0, targetBeta = 0, targetGamma = 0;
    let currentAlpha = 0, currentBeta = 0, currentGamma = 0;
    let isDragging = false;
    let prevPointerX = 0, prevPointerY = 0;
    let velocityX = 0, velocityY = 0;
    let targetManualYaw = 0, targetManualPitch = 0;
    let currentManualYaw = 0, currentManualPitch = 0;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha !== null && e.beta !== null) {
        setHasGyro(true);
        targetAlpha = THREE.MathUtils.degToRad(e.alpha || 0);
        targetBeta = THREE.MathUtils.degToRad((e.beta || 90) - 90);
        targetGamma = THREE.MathUtils.degToRad(e.gamma || 0);
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      isDragging = true;
      prevPointerX = e.clientX;
      prevPointerY = e.clientY;
      velocityX = 0;
      velocityY = 0;

      try {
        (e.target as HTMLElement)?.setPointerCapture?.(e.pointerId);
      } catch {
        // Fallback
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const deltaX = e.clientX - prevPointerX;
      const deltaY = e.clientY - prevPointerY;
      prevPointerX = e.clientX;
      prevPointerY = e.clientY;

      const sensitivity = 0.0035;
      targetManualYaw -= deltaX * sensitivity;
      targetManualPitch = Math.max(-0.6, Math.min(0.6, targetManualPitch - deltaY * sensitivity));

      velocityX = deltaX * sensitivity;
      velocityY = deltaY * sensitivity;
    };

    const handlePointerUp = (e: PointerEvent) => {
      isDragging = false;
      try {
        (e.target as HTMLElement)?.releasePointerCapture?.(e.pointerId);
      } catch {
        // Fallback
      }
    };

    const handlePointerCancel = () => {
      isDragging = false;
    };

    if (typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      window.addEventListener("deviceorientation", handleOrientation);
    }
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerup", handlePointerUp);
    container.addEventListener("pointercancel", handlePointerCancel);

    // 6. Animation and Split-Screen Stereo Render Loop with Smooth Damping
    let animId: number;
    const clock = new THREE.Clock();

    const renderStereo = () => {
      animId = requestAnimationFrame(renderStereo);
      const delta = Math.min(clock.getDelta(), 0.1);
      const time = clock.getElapsedTime();

      // Inertial coasting when releasing drag
      if (!isDragging) {
        targetManualYaw -= velocityX * (60 * delta);
        targetManualPitch = Math.max(-0.6, Math.min(0.6, targetManualPitch - velocityY * (60 * delta)));
        const friction = Math.pow(0.88, delta * 60);
        velocityX *= friction;
        velocityY *= friction;
        if (Math.abs(velocityX) < 0.00001) velocityX = 0;
        if (Math.abs(velocityY) < 0.00001) velocityY = 0;
      }

      // Smooth damping interpolation
      const dampFactor = 1 - Math.exp(-12 * delta);
      currentManualYaw += (targetManualYaw - currentManualYaw) * dampFactor;
      currentManualPitch += (targetManualPitch - currentManualPitch) * dampFactor;

      const gyroDamp = 1 - Math.exp(-10 * delta);
      currentAlpha += (targetAlpha - currentAlpha) * gyroDamp;
      currentBeta += (targetBeta - currentBeta) * gyroDamp;
      currentGamma += (targetGamma - currentGamma) * gyroDamp;

      // Gentle floating animation anchored to initialY (no drift)
      docMeshes.forEach((mesh, i) => {
        const initialY = mesh.userData.initialY ?? mesh.position.y;
        mesh.position.y = initialY + Math.sin(time * 1.5 + i * 0.8) * 0.04;
      });

      // Animate 3D Voice & Resonance Sphere in VR
      voiceOrb.update(time, isListeningRef.current, audioLevelsRef.current);

      // Apply Orientation / Look rotation to cameras smoothly
      const euler = new THREE.Euler(
        currentBeta + currentManualPitch,
        currentAlpha + currentManualYaw,
        -currentGamma,
        "YXZ"
      );
      cameraLeft.quaternion.setFromEuler(euler);
      cameraRight.quaternion.setFromEuler(euler);

      const w = container.clientWidth;
      const h = container.clientHeight;

      // Render Left Eye (Left Half)
      renderer.setScissor(0, 0, w / 2, h);
      renderer.setViewport(0, 0, w / 2, h);
      renderer.render(scene, cameraLeft);

      // Render Right Eye (Right Half)
      renderer.setScissor(w / 2, 0, w / 2, h);
      renderer.setViewport(w / 2, 0, w / 2, h);
      renderer.render(scene, cameraRight);
    };

    renderStereo();

    // 7. Cleanup
    return () => {
      cancelAnimationFrame(animId);
      voiceOrb.dispose();
      scene.remove(voiceOrb.group);
      window.removeEventListener("deviceorientation", handleOrientation);
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerup", handlePointerUp);
      container.removeEventListener("pointercancel", handlePointerCancel);

      geometriesToDispose.forEach((g) => g.dispose());
      materialsToDispose.forEach((m) => m.dispose());
      texturesToDispose.forEach((t) => t.dispose());

      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [isOpen, documents]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#06040e] flex flex-col select-none overflow-hidden">
      {/* Stereoscopic Three.js canvas viewport */}
      <div ref={containerRef} className="flex-1 w-full h-full relative touch-none cursor-grab active:cursor-grabbing" />

      {/* Optical Divider for Google Cardboard / VR Headsets */}
      <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-gradient-to-b from-white/20 via-purple-500/30 to-white/20 pointer-events-none" />

      {/* Top Left: VisionOS Spatial Telemetry */}
      <div className="absolute top-6 left-6 z-50 pointer-events-none flex items-center space-x-2 bg-[#14121e]/80 backdrop-blur-xl border border-white/10 px-3.5 py-1.5 rounded-full text-xs text-white/80">
        {isListening ? (
          <>
            <span className="w-2 h-2 rounded-full bg-violet-400 animate-ping" />
            <span className="font-semibold text-violet-300">Voice Active • Neural Waves</span>
          </>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-semibold text-[#a78bfa]">Aether Sovereign VR</span>
            <span className="text-white/40">•</span>
            <span className="text-white/60">Stereoscopic Pavilion</span>
          </>
        )}
      </div>

      {/* Exit Button: Apple visionOS Glassmorphic Pill */}
      <button
        onClick={onClose}
        aria-label="Exit stereo view"
        className="absolute top-6 right-6 z-50 p-3 rounded-full bg-[#14121e]/80 border border-white/20 text-white/90 hover:text-white hover:bg-white/10 hover:border-purple-400/50 transition-all backdrop-blur-xl shadow-lg"
      >
        <X className="w-5 h-5" />
      </button>

      {/* Bottom Center: VR Orientation Badge */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#14121e]/85 backdrop-blur-xl px-5 py-2 rounded-full border border-purple-500/30 text-xs text-white/80 flex items-center space-x-2.5 shadow-2xl pointer-events-none">
        {hasGyro ? (
          <>
            <Smartphone className="w-4 h-4 text-emerald-400" />
            <span>Mobile Gyroscope Active • Tilt headset to inspect records</span>
          </>
        ) : (
          <>
            <Compass className="w-4 h-4 text-[#a78bfa]" />
            <span>Cardboard VR Mode • Drag or tilt device to look around</span>
          </>
        )}
      </div>
    </div>
  );
}
