import * as THREE from "three";

// Initialize WebXR Polyfill for desktop/laptop browsers without native WebXR runtime
if (typeof window !== "undefined") {
  try {
    const WebXRPolyfill = require("webxr-polyfill").default || require("webxr-polyfill");
    new WebXRPolyfill();
  } catch (e) {
    // Non-blocking fallback for SSR or environments where polyfill is unneeded
  }
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
    // controllers and hand pinch both drive grabbing (see SpatialInteraction)
    optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
  });

  try {
    await renderer.xr.setSession(session);
  } catch (err) {
    // Never leave an orphaned XR session holding the headset
    await session.end().catch(() => {});
    throw err;
  }
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
