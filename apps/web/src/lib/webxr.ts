import * as THREE from "three";

/**
 * Configure 6DoF laser beam motion controllers for Meta Quest and Apple Vision Pro.
 */
export function setupWebXrControllers(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer
): { controller0: THREE.XRTargetRaySpace; controller1: THREE.XRTargetRaySpace } {
  // Controller 0 (Primary Hand)
  const controller0 = renderer.xr.getController(0);
  scene.add(controller0);

  // Controller 1 (Secondary Hand)
  const controller1 = renderer.xr.getController(1);
  scene.add(controller1);

  // 6DoF Laser Ray Geometry
  const laserGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -5),
  ]);

  const laserMaterial = new THREE.LineBasicMaterial({
    color: 0x8b5cf6,
    transparent: true,
    opacity: 0.7,
  });

  const laserLine0 = new THREE.Line(laserGeometry, laserMaterial);
  laserLine0.name = "laser_line_0";
  controller0.add(laserLine0);

  const laserLine1 = new THREE.Line(laserGeometry, laserMaterial);
  laserLine1.name = "laser_line_1";
  controller1.add(laserLine1);

  return { controller0, controller1 };
}

/**
 * Enter WebXR Immersive 6DoF session with spatial computing support.
 */
export async function enterImmersiveVr(renderer: THREE.WebGLRenderer): Promise<void> {
  if (typeof window === "undefined" || !navigator.xr) {
    throw new Error("WebXR is not supported on this browser or platform.");
  }

  const isSupported = await navigator.xr.isSessionSupported("immersive-vr");
  if (!isSupported) {
    throw new Error("Immersive VR (immersive-vr) is not supported on this device.");
  }

  const session = await navigator.xr.requestSession("immersive-vr", {
    optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
  });

  await renderer.xr.setSession(session);
}

/**
 * Detect whether client is on a mobile handheld device (for Cardboard fallback).
 */
export function isMobileDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}
