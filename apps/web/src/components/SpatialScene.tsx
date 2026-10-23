"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { setupWebXrControllers } from "../lib/webxr";

interface SpatialSceneProps {
  onRendererReady?: (renderer: THREE.WebGLRenderer) => void;
}

export function SpatialScene({ onRendererReady }: SpatialSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // 1. Scene, Camera, Renderer
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05050a, 0.04);

    const camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    camera.position.set(0, 2.5, 6);
    camera.lookAt(0, 1.2, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    
    // Enable WebXR on the renderer
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);

    if (onRendererReady) {
      onRendererReady(renderer);
    }

    // Setup WebXR 6DoF Laser Controllers
    const { controller1, controller2 } = setupWebXrControllers(scene, renderer);

    // 2. Cyber-Grid Floor
    const gridHelper = new THREE.GridHelper(30, 30, 0x00f0ff, 0x1a1a3a);
    gridHelper.position.y = -0.5;
    scene.add(gridHelper);

    // 3. Central Holographic Audio Core Ring
    const coreGeometry = new THREE.TorusGeometry(1.2, 0.04, 16, 100);
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      wireframe: true,
    });
    const coreRing = new THREE.Mesh(coreGeometry, coreMaterial);
    coreRing.position.set(0, 1.8, 0);
    scene.add(coreRing);

    // Inner Violet Ring
    const innerGeometry = new THREE.TorusGeometry(0.8, 0.03, 16, 100);
    const innerMaterial = new THREE.MeshBasicMaterial({
      color: 0x7928ca,
      wireframe: true,
    });
    const innerRing = new THREE.Mesh(innerGeometry, innerMaterial);
    innerRing.position.set(0, 1.8, 0);
    scene.add(innerRing);

    // 4. Floating Holographic Data Pillars (Representing Australian Documents/Vault)
    const pillarGeometry = new THREE.BoxGeometry(0.6, 1.8, 0.6);
    const pillarMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a1020,
      emissive: 0x003344,
      roughness: 0.2,
      metalness: 0.8,
      transparent: true,
      opacity: 0.75,
    });

    const pillars: THREE.Mesh[] = [];
    const pillarPositions = [
      [-2.8, 0.6, -1.5],
      [2.8, 0.6, -1.5],
      [-1.8, 0.6, -3.2],
      [1.8, 0.6, -3.2],
    ];

    pillarPositions.forEach((pos) => {
      const p = new THREE.Mesh(pillarGeometry, pillarMaterial);
      p.position.set(pos[0], pos[1], pos[2]);
      scene.add(p);
      pillars.push(p);

      const edges = new THREE.EdgesGeometry(pillarGeometry);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.5 })
      );
      p.add(line);
    });

    // 5. Floating Star Dust
    const particleCount = 180;
    const particlesGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount * 3; i += 3) {
      positions[i] = (Math.random() - 0.5) * 20;
      positions[i + 1] = Math.random() * 8;
      positions[i + 2] = (Math.random() - 0.5) * 20;
    }

    particlesGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const particlesMaterial = new THREE.PointsMaterial({
      color: 0x00f0ff,
      size: 0.05,
      transparent: true,
      opacity: 0.6,
    });
    const particleSystem = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particleSystem);

    // 6. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0x00f0ff, 2, 10);
    pointLight.position.set(0, 3, 2);
    scene.add(pointLight);

    // 7. Interactive Orbit Drag Controls (Active when not in WebXR)
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
      if (!isDragging || renderer.xr.isPresenting) return;
      const deltaX = e.clientX - previousMousePosition.x;
      const deltaY = e.clientY - previousMousePosition.y;

      cameraAngleY -= deltaX * 0.005;
      cameraAngleX = Math.max(-0.5, Math.min(0.8, cameraAngleX + deltaY * 0.005));

      const radius = 6;
      camera.position.x = radius * Math.sin(cameraAngleY) * Math.cos(cameraAngleX);
      camera.position.z = radius * Math.cos(cameraAngleY) * Math.cos(cameraAngleX);
      camera.position.y = 2.5 + radius * Math.sin(cameraAngleX);
      camera.lookAt(0, 1.2, 0);

      previousMousePosition = { x: e.clientX, y: e.clientY };
    };

    const onMouseUp = () => {
      isDragging = false;
    };

    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    // 8. Unified WebXR-Safe Animation Loop
    let clock = new THREE.Clock();

    renderer.setAnimationLoop(() => {
      const elapsedTime = clock.getElapsedTime();

      // Rotate Rings
      coreRing.rotation.x = elapsedTime * 0.4;
      coreRing.rotation.y = elapsedTime * 0.6;
      innerRing.rotation.x = -elapsedTime * 0.5;
      innerRing.rotation.z = elapsedTime * 0.7;

      // Float Pillars gently
      pillars.forEach((p, idx) => {
        p.position.y = pillarPositions[idx][1] + Math.sin(elapsedTime * 1.5 + idx) * 0.08;
      });

      // Slowly drift particles
      particleSystem.rotation.y = elapsedTime * 0.03;

      renderer.render(scene, camera);
    });

    // 9. Resize Handling
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
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("resize", handleResize);
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative w-full h-full min-h-[300px] rounded-2xl overflow-hidden border border-aurora-cyan/30 shadow-glass">
      <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing" />
      <div className="absolute top-3 left-3 pointer-events-none flex items-center space-x-2 text-[10px] font-space text-aurora-cyan uppercase tracking-wider bg-aurora-panel/80 px-2.5 py-1 rounded-md border border-aurora-border/60 backdrop-blur-md">
        <span className="w-2 h-2 rounded-full bg-aurora-cyan animate-ping" />
        <span>3D Spatial Room • WebXR Enabled</span>
      </div>
    </div>
  );
}
