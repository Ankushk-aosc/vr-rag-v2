import * as THREE from "three";

export interface VoiceParticleOrbController {
  group: THREE.Group;
  update: (time: number, isListening: boolean, audioLevels: number[]) => void;
  dispose: () => void;
}

/**
 * Creates the restored Aether Sovereign Concentric Gyroscopic Rings & Voice Wave Core.
 * - Restored to the original center position of the pavilion (0, 1.35, 0)
 * - Restored original look: outer royal purple torus and inner counter-rotating ring
 * - When speaking/listening: center core activates into the 3D soundwave particle sphere from the reference image
 * - When idle: calm rotating concentric rings with subtle interior particles
 */
export function createVoiceParticleOrb(isLight: boolean = false): VoiceParticleOrbController {
  const group = new THREE.Group();
  // Restored to original pavilion center position
  group.position.set(0, 1.35, 0);

  // 1. Original Primary Outer Ring (Core Ring)
  const coreGeo = new THREE.TorusGeometry(1.25, 0.022, 16, 100);
  const coreMat = new THREE.MeshStandardMaterial({
    color: isLight ? 0x7C3AED : 0x8B5CF6,
    emissive: isLight ? 0x6D28D9 : 0x7C3AED,
    emissiveIntensity: isLight ? 0.9 : 1.3,
    roughness: 0.22,
    metalness: 0.8,
  });
  const coreRing = new THREE.Mesh(coreGeo, coreMat);
  group.add(coreRing);

  // 2. Original Inner Gyroscopic Counter-Rotating Ring
  const innerGeo = new THREE.TorusGeometry(0.85, 0.016, 16, 80);
  const innerMat = new THREE.MeshStandardMaterial({
    color: isLight ? 0xD4AF37 : 0xC4B5FD,
    emissive: isLight ? 0x9333EA : 0x7C3AED,
    emissiveIntensity: isLight ? 0.7 : 1.0,
    roughness: 0.3,
    metalness: 0.7,
  });
  const innerRing = new THREE.Mesh(innerGeo, innerMat);
  group.add(innerRing);

  // 3. Central Dynamic Voice Wave Mesh (Soundwave Cloud Lattice)
  const particleCount = 2800;
  const particleGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(particleCount * 3);
  const anglesPhi = new Float32Array(particleCount);
  const anglesTheta = new Float32Array(particleCount);

  const R_BASE = 0.36;
  for (let i = 0; i < particleCount; i++) {
    // Fibonacci sphere distribution for uniform coverage
    const phi = Math.acos(1 - 2 * (i + 0.5) / particleCount);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;

    anglesPhi[i] = phi;
    anglesTheta[i] = theta;

    positions[i * 3] = R_BASE * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = R_BASE * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = R_BASE * Math.cos(phi);
  }

  particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const particleMat = new THREE.PointsMaterial({
    color: isLight ? 0x6D28D9 : 0xA78BFA,
    size: 0.024,
    transparent: true,
    opacity: 0.22, // Subtle in idle mode so rings are the hero
    blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
  });

  const particleMesh = new THREE.Points(particleGeo, particleMat);
  group.add(particleMesh);

  // 4. Volumetric Core Light
  const orbLight = new THREE.PointLight(isLight ? 0x7C3AED : 0x8B5CF6, isLight ? 1.0 : 1.8, 6);
  group.add(orbLight);

  // Animation & morphing state
  let morphFactor = 0.0;

  const update = (time: number, isListening: boolean, audioLevels: number[]) => {
    // Target morph factor: 1.0 while listening, 0.0 in normal state
    const targetMorph = isListening ? 1.0 : 0.0;
    morphFactor = THREE.MathUtils.lerp(morphFactor, targetMorph, 0.08);

    // Original concentric gyroscopic rotations
    coreRing.rotation.x = time * (0.4 + morphFactor * 0.4);
    coreRing.rotation.y = time * (0.6 + morphFactor * 0.5);
    innerRing.rotation.x = -time * (0.5 + morphFactor * 0.4);
    innerRing.rotation.z = time * (0.7 + morphFactor * 0.6);

    // Dynamic ring scale pulse
    const ringScale = 1.0 + morphFactor * 0.08 + (morphFactor > 0.05 ? Math.sin(time * 6) * 0.02 : 0);
    coreRing.scale.setScalar(ringScale);

    // Particle opacity blooms when listening
    particleMat.opacity = THREE.MathUtils.lerp(0.22, 0.90, morphFactor);
    particleMat.size = THREE.MathUtils.lerp(0.022, 0.028, morphFactor);

    // Calculate live voice energy from audio levels
    const levels = audioLevels && audioLevels.length > 0 ? audioLevels : [15, 20, 25, 20, 15];
    const avgEnergy = levels.reduce((a, b) => a + b, 0) / (levels.length * 100);
    const voiceIntensity = isListening ? Math.max(0, (avgEnergy - 0.15) * 1.6) : 0;
    const dynamicAmplitude = (0.04 + voiceIntensity * 0.16) * morphFactor;

    // Morph particle positions
    const posAttr = particleGeo.attributes.position as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;

    for (let i = 0; i < particleCount; i++) {
      const phi = anglesPhi[i];
      const theta = anglesTheta[i];

      // In idle: calm breathing motion
      const idleOffset = Math.sin(time * 2.0 + phi * 3.0) * 0.008;

      // In speaking: 3D standing corrugated waves matching reference image
      const wave1 = Math.sin(6 * theta + time * 5.2) * Math.cos(5 * phi + time * 3.8);
      const wave2 = Math.sin(10 * phi - time * 4.2) * 0.5;
      const wave3 = Math.sin(3 * theta + 4 * phi + time * 6.0) * 0.35;
      const listeningDisplacement = (wave1 + wave2 + wave3) * dynamicAmplitude;

      const currentR = R_BASE + idleOffset * (1.0 - morphFactor) + listeningDisplacement;

      posArr[i * 3] = currentR * Math.sin(phi) * Math.cos(theta);
      posArr[i * 3 + 1] = currentR * Math.sin(phi) * Math.sin(theta);
      posArr[i * 3 + 2] = currentR * Math.cos(phi);
    }
    posAttr.needsUpdate = true;
  };

  const dispose = () => {
    coreGeo.dispose();
    coreMat.dispose();
    innerGeo.dispose();
    innerMat.dispose();
    particleGeo.dispose();
    particleMat.dispose();
  };

  return { group, update, dispose };
}
