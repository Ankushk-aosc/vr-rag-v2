"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { setupWebXrControllers } from "../lib/webxr";
import { DocumentRecord } from "../types";

interface SpatialSceneProps {
  onRendererReady?: (renderer: THREE.WebGLRenderer) => void;
  onSelectDocument?: (docName: string, doc?: DocumentRecord) => void;
  theme?: "dark" | "light";
  documents?: DocumentRecord[];
  isListening?: boolean;
  audioLevels?: number[];
}

export function SpatialScene({
  onRendererReady,
  onSelectDocument,
  theme = "dark",
  documents,
  isListening = false,
  audioLevels,
}: SpatialSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isLight = theme === "light";

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
    renderer.toneMappingExposure = isLight ? 1.05 : 1.2;
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);

    if (onRendererReady) onRendererReady(renderer);

    // Setup WebXR 6DoF Laser Controllers
    setupWebXrControllers(scene, renderer);

    // 2. Architectural Gallery: Circular Podium
    const podiumGeo = new THREE.CylinderGeometry(3.6, 3.8, 0.25, 64);
    const podiumMat = new THREE.MeshStandardMaterial({
      color: isLight ? 0xE4E4EC : 0x0C0C14,
      roughness: 0.8,
      metalness: 0.2,
    });
    const podium = new THREE.Mesh(podiumGeo, podiumMat);
    podium.position.y = -0.12;
    scene.add(podium);

    // Clean subtle architectural contour hairline on podium
    const rimGeo = new THREE.RingGeometry(3.55, 3.58, 64);
    const rimMat = new THREE.MeshBasicMaterial({
      color: isLight ? 0xCBD5E1 : 0x27272A,
      transparent: true,
      opacity: isLight ? 0.35 : 0.45,
      side: THREE.DoubleSide,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.01;
    scene.add(rim);

    // 3. Document Slab Creation Helper with Real Financial Data Styling
    const createDocTexture = (
      doc: DocumentRecord | null,
      fallbackTitle: string = "AAPL Financial Data",
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

      // Background slab (distinct, visible frosted card surface)
      if (isLight) {
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, 512, 724);

        // Crisp subtle light border
        ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
        ctx.lineWidth = 4;
        ctx.strokeRect(12, 12, 488, 700);
      } else {
        // High-contrast clean dark card surface
        const grad = ctx.createLinearGradient(0, 0, 0, 724);
        grad.addColorStop(0, "#18181B");
        grad.addColorStop(1, "#09090B");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 512, 724);

        // Luminous subtle border around card
        ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
        ctx.lineWidth = 4;
        ctx.strokeRect(12, 12, 488, 700);
      }

      // Gold header hairline
      ctx.fillStyle = "#D4AF37";
      ctx.fillRect(40, 40, 432, 5);

      // Document Code / Seal
      ctx.font = "bold 20px monospace";
      ctx.fillStyle = isLight ? "#0F172A" : "#E2E8F0";
      ctx.fillText(code, 40, 85);

      // Format Badge Pill in Top Right
      ctx.fillStyle = isLight ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.10)";
      ctx.beginPath();
      ctx.roundRect(360, 62, 110, 32, 16);
      ctx.fill();
      ctx.fillStyle = isLight ? "#334155" : "#D4AF37";
      ctx.font = "bold 16px monospace";
      ctx.textAlign = "center";
      ctx.fillText(ext, 415, 84);
      ctx.textAlign = "start";

      // Document Title (High legibility, wrapped cleanly if long)
      ctx.font = "bold 24px sans-serif";
      ctx.fillStyle = isLight ? "#1A1A22" : "#FFFFFF";

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
      ctx.fillStyle = isLight ? "#52525B" : "#A78BFA";
      ctx.fillText(subtitle, 40, 202);

      // Simulated financial table headers & rows
      ctx.fillStyle = isLight ? "rgba(109, 40, 217, 0.1)" : "rgba(139, 92, 246, 0.2)";
      ctx.fillRect(40, 226, 432, 34);

      ctx.font = "bold 13px monospace";
      ctx.fillStyle = isLight ? "#4C1D95" : "#C4B5FD";
      ctx.fillText("DATE       OPEN    HIGH    CLOSE    VOL", 50, 248);

      // Financial data preview rows
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
          ctx.fillStyle = isLight ? "rgba(0, 0, 0, 0.04)" : "rgba(255, 255, 255, 0.04)";
          if (idx % 2 === 0) ctx.fillRect(40, yPos - 18, 432, 30);
          ctx.fillStyle = isLight ? "#27272A" : "rgba(255, 255, 255, 0.85)";
          ctx.fillText(rowText, 50, yPos);
        }
      });

      // Legal disclaimer footer
      ctx.font = "bold 13px monospace";
      ctx.fillStyle = isLight ? "rgba(109, 40, 217, 0.85)" : "#D4AF37";
      ctx.fillText(
        doc ? `SHA-256: ${doc.file_hash.slice(0, 20)}... • AUD APP 8` : "VERIFIED AUD RECORD • APP 8 LOCAL",
        40,
        680
      );

      const texture = new THREE.CanvasTexture(canvas);
      texture.anisotropy = 4;
      return texture;
    };

    const activeDocs: (DocumentRecord | null)[] =
      documents && documents.length > 0
        ? documents.slice(0, 5)
        : [
            {
              id: "doc-1",
              filename: "AAPL_financial_data_11558_rows.xlsx",
              original_name: "AAPL_financial_data_11558_rows.xlsx",
              mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              file_size: 539573,
              file_hash: "2af8528614ef4900a6e0b3c5825bc5e5",
              total_pages: 2,
              family_entity_id: "default_family",
              status: "indexed",
              uploaded_at: "",
            },
            {
              id: "doc-2",
              filename: "AAPL_financial_data_11558_rows.pdf",
              original_name: "AAPL_financial_data_11558_rows.pdf",
              mime_type: "application/pdf",
              file_size: 940280,
              file_hash: "cf9d93ed806e478fb18bc298d871be84",
              total_pages: 233,
              family_entity_id: "default_family",
              status: "indexed",
              uploaded_at: "",
            },
            {
              id: "doc-3",
              filename: "AAPL_financial_data_11558_rows.csv",
              original_name: "AAPL_financial_data_11558_rows.csv",
              mime_type: "text/csv",
              file_size: 710536,
              file_hash: "d2be779e1f104f279c13e51240a1b6ca",
              total_pages: 232,
              family_entity_id: "default_family",
              status: "indexed",
              uploaded_at: "",
            },
            {
              id: "doc-4",
              filename: "AAPL_financial_data_11558_rows.docx",
              original_name: "AAPL_financial_data_11558_rows.docx",
              mime_type: "application/docx",
              file_size: 346220,
              file_hash: "af7556c576aba4749f1b21396a84cbb0",
              total_pages: 1,
              family_entity_id: "default_family",
              status: "indexed",
              uploaded_at: "",
            },
            {
              id: "doc-5",
              filename: "AAPL_financial_data_11558_rows.txt",
              original_name: "AAPL_financial_data_11558_rows.txt",
              mime_type: "text/plain",
              file_size: 719771,
              file_hash: "d09437ff9af64f5095ce56a4297c55b7",
              total_pages: 1,
              family_entity_id: "default_family",
              status: "indexed",
              uploaded_at: "",
            },
          ];

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
      const texture = createDocTexture(cfg.doc, cfg.title);
      const slabMat = new THREE.MeshPhysicalMaterial({
        map: texture,
        color: 0xFFFFFF, // Full dynamic range for canvas texture
        emissive: isLight ? 0x000000 : 0x0F172A,
        emissiveIntensity: isLight ? 0.0 : 0.2,
        roughness: 0.2,
        metalness: 0.1,
        transparent: true,
        opacity: 0.98,
      });

      const slab = new THREE.Mesh(slabGeometry, slabMat);
      slab.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      slab.rotation.y = cfg.rotY;
      slab.userData = { title: cfg.title, originalY: cfg.pos[1], docRecord: cfg.doc };

      // Subtle crisp card edge wireframe
      const edgeLineMat = new THREE.LineBasicMaterial({
        color: isLight ? 0x94A3B8 : 0x475569,
        transparent: true,
        opacity: isLight ? 0.35 : 0.5,
        linewidth: 1,
      });
      const wireframeBorder = new THREE.LineSegments(slabEdgesGeometry, edgeLineMat);
      wireframeBorder.raycast = () => {}; // Do not intercept raycasting from slab parent
      wireframeBorder.userData = { title: cfg.title, docRecord: cfg.doc };
      slab.add(wireframeBorder);

      scene.add(slab);
      slabs.push(slab);
    });

    // 4. Studio Lighting
    scene.add(new THREE.AmbientLight(0xffffff, isLight ? 1.0 : 0.9));

    // Direct front fill light to illuminate document faces
    const frontLight = new THREE.DirectionalLight(0xffffff, isLight ? 0.8 : 1.1);
    frontLight.position.set(0, 2.0, 5.0);
    scene.add(frontLight);

    const keyLight = new THREE.DirectionalLight(0xfff8ee, isLight ? 1.2 : 1.4);
    keyLight.position.set(4, 5, 3);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xe8e5f5, isLight ? 0.9 : 0.8);
    fillLight.position.set(-4, 3, 2);
    scene.add(fillLight);

    // Clean architectural overhead studio light
    const overheadLight = new THREE.PointLight(0xffffff, isLight ? 0.7 : 0.9, 10);
    overheadLight.position.set(0, 3.5, -1);
    scene.add(overheadLight);

    // 6. Interactive Raycasting & Inertial Orbit Controls
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    let isDragging = false;
    let previousMousePosition = { x: 0, y: 0 };
    let cameraAngleY = 0;
    let cameraAngleX = 0;

    const onMouseDown = (e: MouseEvent) => {
      if (renderer.xr.isPresenting) return;
      isDragging = true;
      previousMousePosition = { x: e.clientX, y: e.clientY };
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / container.clientWidth) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / container.clientHeight) * 2 + 1;

      if (!isDragging || renderer.xr.isPresenting) return;
      const deltaX = e.clientX - previousMousePosition.x;
      const deltaY = e.clientY - previousMousePosition.y;

      cameraAngleY -= deltaX * 0.0035;
      cameraAngleX = Math.max(-0.25, Math.min(0.5, cameraAngleX + deltaY * 0.0035));

      const radius = 5.0;
      camera.position.x = radius * Math.sin(cameraAngleY) * Math.cos(cameraAngleX);
      camera.position.z = radius * Math.cos(cameraAngleY) * Math.cos(cameraAngleX);
      camera.position.y = 1.9 + radius * Math.sin(cameraAngleX);
      camera.lookAt(0, 1.2, 0);

      previousMousePosition = { x: e.clientX, y: e.clientY };
    };

    const onMouseUp = () => {
      isDragging = false;
    };

    const onClick = (e: MouseEvent) => {
      if (renderer.xr.isPresenting) return;
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / container.clientWidth) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / container.clientHeight) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(slabs, true);
      if (intersects.length > 0) {
        const hit = intersects[0].object;
        const title = hit.userData?.title || hit.parent?.userData?.title;
        const docRecord = hit.userData?.docRecord || hit.parent?.userData?.docRecord;
        if (title && onSelectDocument) {
          onSelectDocument(title, docRecord);
        }
      }
    };

    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("click", onClick);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    // 7. Animation Loop
    const clock = new THREE.Clock();

    renderer.setAnimationLoop(() => {
      const time = clock.getElapsedTime();


      // Floating document slabs with gentle breathing
      slabs.forEach((slab, idx) => {
        slab.position.y =
          slab.userData.originalY + Math.sin(time * 0.75 + idx * 1.5) * 0.04;
      });

      // Raycast hover check
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(slabs, true);
      slabs.forEach((slab) => {
        const isHovered = intersects.some(
          (hit) => hit.object === slab || hit.object.parent === slab
        );
        slab.scale.setScalar(isHovered ? 1.05 : 1.0);
      });

      renderer.render(scene, camera);
    });

    // 8. Resize Handler
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
      container.removeEventListener("click", onClick);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("resize", handleResize);
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [onRendererReady, onSelectDocument, isLight, documents]);

  return (
    <div className="relative w-full h-full min-h-[500px] overflow-hidden select-none">
      <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing" />
      {/* Telemetry Badge with Dynamic Voice Status */}
      <div
        className={`absolute top-20 left-6 pointer-events-none flex items-center space-x-2 text-[11px] font-medium px-3.5 py-1.5 rounded-full border backdrop-blur-2xl transition-all ${
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
    </div>
  );
}
