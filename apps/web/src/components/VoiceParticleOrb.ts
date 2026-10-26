import * as THREE from "three";

export interface VoiceParticleOrbController {
  group: THREE.Group;
  update: (time: number, isListening: boolean, audioLevels: number[]) => void;
  dispose: () => void;
}

/**
 * Lightweight, zero-overhead VoiceParticleOrb controller.
 * The heavy purple concentric rings (toruses) and 2,800-particle Fibonacci soundwave mesh
 * have been decommissioned to eliminate CPU/GPU rendering lag, unblock camera orbit drag,
 * and provide an unobstructed view of the 3D financial document slabs.
 */
export function createVoiceParticleOrb(_isLight: boolean = false): VoiceParticleOrbController {
  const group = new THREE.Group();

  return {
    group,
    update: () => {
      // Zero CPU overhead per frame
    },
    dispose: () => {
      // No heavy GPU geometries or materials to dispose
    },
  };
}
