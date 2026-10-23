"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { X, Smartphone } from "lucide-react";

interface StereoViewerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function StereoViewer({ isOpen, onClose }: StereoViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [gyroPermitted, setGyroPermitted] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    const container = containerRef.current;

    // Setup Split Screen Stereo Scene
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05050a, 0.05);

    const cameraLeft = new THREE.PerspectiveCamera(65, (container.clientWidth / 2) / container.clientHeight, 0.1, 100);
    const cameraRight = new THREE.PerspectiveCamera(65, (container.clientWidth / 2) / container.clientHeight, 0.1, 100);
    
    // Interpupillary distance (~64mm offset)
    cameraLeft.position.set(-0.032, 1.8, 4);
    cameraRight.position.set(0.032, 1.8, 4);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setScissorTest(true);
    container.appendChild(renderer.domElement);

    // Grid Floor
    const gridHelper = new THREE.GridHelper(25, 25, 0x00f0ff, 0x1f1f3a);
    gridHelper.position.y = -0.5;
    scene.add(gridHelper);

    // Central Core
    const ringGeo = new THREE.TorusGeometry(1.2, 0.04, 16, 80);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, wireframe: true });
    const coreRing = new THREE.Mesh(ringGeo, ringMat);
    coreRing.position.set(0, 1.8, 0);
    scene.add(coreRing);

    // Ambient & Point light
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const pLight = new THREE.PointLight(0x00f0ff, 2, 15);
    pLight.position.set(0, 3, 2);
    scene.add(pLight);

    // Orientation Controls (Mobile Gyroscope)
    let alpha = 0, beta = 0, gamma = 0;
    const handleOrientation = (e: DeviceOrientationEvent) => {
      alpha = e.alpha ? THREE.MathUtils.degToRad(e.alpha) : 0;
      beta = e.beta ? THREE.MathUtils.degToRad(e.beta - 90) : 0;
      gamma = e.gamma ? THREE.MathUtils.degToRad(e.gamma) : 0;
    };

    if (typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      window.addEventListener("deviceorientation", handleOrientation);
      setGyroPermitted(true);
    }

    let animId: number;
    const clock = new THREE.Clock();

    const renderStereo = () => {
      animId = requestAnimationFrame(renderStereo);
      const time = clock.getElapsedTime();
      coreRing.rotation.x = time * 0.5;
      coreRing.rotation.y = time * 0.7;

      // Apply Gyro rotation to both cameras
      const euler = new THREE.Euler(beta, alpha, -gamma, "YXZ");
      cameraLeft.quaternion.setFromEuler(euler);
      cameraRight.quaternion.setFromEuler(euler);

      const w = container.clientWidth;
      const h = container.clientHeight;

      // Render Left Eye
      renderer.setScissor(0, 0, w / 2, h);
      renderer.setViewport(0, 0, w / 2, h);
      renderer.render(scene, cameraLeft);

      // Render Right Eye
      renderer.setScissor(w / 2, 0, w / 2, h);
      renderer.setViewport(w / 2, 0, w / 2, h);
      renderer.render(scene, cameraRight);
    };

    renderStereo();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("deviceorientation", handleOrientation);
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div ref={containerRef} className="flex-1 w-full h-full relative" />
      {/* Center line separator for Google Cardboard lenses */}
      <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-aurora-cyan/30 pointer-events-none" />
      
      {/* Exit Button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-50 p-2 rounded-full bg-black/70 border border-aurora-cyan text-aurora-cyan hover:bg-black transition-colors"
      >
        <X className="w-6 h-6" />
      </button>
      
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 bg-black/80 px-4 py-1.5 rounded-full border border-aurora-border text-xs font-space text-aurora-muted flex items-center space-x-2">
        <Smartphone className="w-4 h-4 text-aurora-cyan" />
        <span>Mobile Cardboard Mode • Turn head to look around</span>
      </div>
    </div>
  );
}
