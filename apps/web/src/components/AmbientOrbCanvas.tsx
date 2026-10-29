"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";

interface AmbientOrbCanvasProps {
  className?: string;
  is3DMode?: boolean;
}

export function AmbientOrbCanvas({ className, is3DMode = true }: AmbientOrbCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const is3DModeRef = useRef(is3DMode);
  is3DModeRef.current = is3DMode;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let animId = 0;
    let mouseX = 0;
    let mouseY = 0;
    let targetX = 0;
    let targetY = 0;

    const width = window.innerWidth;
    const height = window.innerHeight;

    // 1. Scene & Camera
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    camera.position.set(0, 0, 5.2);

    // 2. WebGL Renderer with High-DPI support
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // 3. Central Holographic Celestial Core (Spherical Cloud)
    const coreCount = 1400;
    const corePositions = new Float32Array(coreCount * 3);
    const coreColors = new Float32Array(coreCount * 3);

    const gold = new THREE.Color("#D4AF37");
    const royalPurple = new THREE.Color("#7C3AED");
    const sapphire = new THREE.Color("#38BDF8");
    const radiant = new THREE.Color("#FDE047");

    for (let i = 0; i < coreCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 1.4 + (Math.random() - 0.5) * 0.45;

      corePositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      corePositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      corePositions[i * 3 + 2] = r * Math.cos(phi);

      const dice = Math.random();
      const col = dice < 0.4 ? gold : dice < 0.75 ? royalPurple : dice < 0.9 ? sapphire : radiant;
      coreColors[i * 3] = col.r;
      coreColors[i * 3 + 1] = col.g;
      coreColors[i * 3 + 2] = col.b;
    }

    const coreGeo = new THREE.BufferGeometry();
    coreGeo.setAttribute("position", new THREE.BufferAttribute(corePositions, 3));
    coreGeo.setAttribute("color", new THREE.BufferAttribute(coreColors, 3));

    const coreMat = new THREE.PointsMaterial({
      size: 0.042,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
    });
    const coreMesh = new THREE.Points(coreGeo, coreMat);
    scene.add(coreMesh);

    // 4. Wide Field Ambient Deep-Space Starfield (Fills Full Viewport)
    const starCount = 1200;
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      starPositions[i * 3] = (Math.random() - 0.5) * 22;
      starPositions[i * 3 + 1] = (Math.random() - 0.5) * 14;
      starPositions[i * 3 + 2] = (Math.random() - 0.5) * 10 - 2;

      const dice = Math.random();
      const col = dice < 0.5 ? gold : dice < 0.8 ? royalPurple : sapphire;
      starColors[i * 3] = col.r;
      starColors[i * 3 + 1] = col.g;
      starColors[i * 3 + 2] = col.b;
    }

    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute("color", new THREE.BufferAttribute(starColors, 3));

    const starMat = new THREE.PointsMaterial({
      size: 0.024,
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
    });
    const starMesh = new THREE.Points(starGeo, starMat);
    scene.add(starMesh);

    // 5. Gyroscopic Orbital Celestial Rings (Sovereign Gold & Purple)
    const ringMat1 = new THREE.MeshBasicMaterial({
      color: 0xd4af37,
      wireframe: true,
      transparent: true,
      opacity: 0.32,
    });
    const ringGeo1 = new THREE.TorusGeometry(1.9, 0.007, 8, 90);
    const ringMesh1 = new THREE.Mesh(ringGeo1, ringMat1);
    scene.add(ringMesh1);

    const ringMat2 = new THREE.MeshBasicMaterial({
      color: 0x7c3aed,
      wireframe: true,
      transparent: true,
      opacity: 0.38,
    });
    const ringGeo2 = new THREE.TorusGeometry(1.65, 0.006, 8, 80);
    const ringMesh2 = new THREE.Mesh(ringGeo2, ringMat2);
    ringMesh2.rotation.x = Math.PI / 3;
    scene.add(ringMesh2);

    const ringMat3 = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.22,
    });
    const ringGeo3 = new THREE.TorusGeometry(2.15, 0.005, 8, 90);
    const ringMesh3 = new THREE.Mesh(ringGeo3, ringMat3);
    ringMesh3.rotation.y = Math.PI / 4;
    scene.add(ringMesh3);

    // 6. Mouse Parallax Tracking
    const handleMouseMove = (e: MouseEvent) => {
      const x = (e.clientX / window.innerWidth) * 2 - 1;
      const y = -(e.clientY / window.innerHeight) * 2 + 1;
      targetX = x * 0.45;
      targetY = y * 0.35;
    };
    window.addEventListener("mousemove", handleMouseMove, { passive: true });

    // 7. Animation Loop with Smooth Parallax LERP
    let clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();
      const in3D = is3DModeRef.current;

      // Dynamic velocity factor based on 3D vs 2D mode
      const speedFactor = in3D ? 1.0 : 0.45;

      // Parallax smooth interpolation
      mouseX += (targetX - mouseX) * 0.04;
      mouseY += (targetY - mouseY) * 0.04;

      if (in3D) {
        camera.position.x = mouseX * 1.2;
        camera.position.y = mouseY * 0.8;
      } else {
        camera.position.x += (0 - camera.position.x) * 0.05;
        camera.position.y += (0 - camera.position.y) * 0.05;
      }
      camera.lookAt(0, 0, 0);

      // Core rotation & gentle breathing pulse
      coreMesh.rotation.y = elapsed * 0.16 * speedFactor;
      coreMesh.rotation.x = Math.sin(elapsed * 0.2) * 0.12;

      const pulse = 1.0 + Math.sin(elapsed * 1.6) * 0.045;
      coreMesh.scale.set(pulse, pulse, pulse);

      // Starfield gentle drift
      starMesh.rotation.y = elapsed * 0.02 * speedFactor;
      starMesh.rotation.x = elapsed * 0.015 * speedFactor;

      // Gyroscopic rings
      ringMesh1.rotation.z = elapsed * 0.22 * speedFactor;
      ringMesh1.rotation.x = Math.cos(elapsed * 0.14) * 0.3;

      ringMesh2.rotation.y = elapsed * -0.28 * speedFactor;
      ringMesh2.rotation.z = Math.sin(elapsed * 0.18) * 0.22;

      ringMesh3.rotation.x = elapsed * 0.15 * speedFactor;
      ringMesh3.rotation.y = Math.cos(elapsed * 0.2) * 0.25;

      renderer.render(scene, camera);
    };

    animate();

    // 8. Viewport Resize Handler
    const handleResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    // 9. Cleanup
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("resize", handleResize);
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      coreGeo.dispose();
      coreMat.dispose();
      starGeo.dispose();
      starMat.dispose();
      ringGeo1.dispose();
      ringMat1.dispose();
      ringGeo2.dispose();
      ringMat2.dispose();
      ringGeo3.dispose();
      ringMat3.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 w-full h-full pointer-events-none -z-10 overflow-hidden ${className || ""}`}
    />
  );
}
