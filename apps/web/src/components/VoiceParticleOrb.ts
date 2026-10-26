import * as THREE from "three";

export interface VoiceParticleOrbController {
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  update: (
    time: number,
    isListening: boolean,
    audioLevels: number[],
    isProcessing?: boolean
  ) => void;
  setHovered: (hovered: boolean) => void;
  dispose: () => void;
}

/**
 * High-performance, GPU-efficient NCS (NoCopyrightSounds) Circular Audio Visualizer.
 * Displays an upright circular soundwave ring with dynamic radial waveform spikes
 * that bounce and ripple in real-time when speaking, agent replies, or on hover.
 */
export function createVoiceParticleOrb(isLight: boolean = false): VoiceParticleOrbController {
  const group = new THREE.Group();
  // Positioned directly in front of the document cards arc on the circular stage
  group.position.set(0, 1.25, 0.4);

  const primaryColor = isLight ? 0x7C3AED : 0xA855F7;
  const secondaryColor = isLight ? 0x6D28D9 : 0xC084FC;
  const accentGlow = isLight ? 0x9333EA : 0x8B5CF6;

  // 1. Center Clickable Backdrop Disc (Raycasting anchor & soft glow aura)
  const discGeo = new THREE.CircleGeometry(0.47, 48);
  const discMat = new THREE.MeshBasicMaterial({
    color: isLight ? 0xEDE9FE : 0x1E1035,
    transparent: true,
    opacity: isLight ? 0.35 : 0.45,
    side: THREE.DoubleSide,
  });
  const coreMesh = new THREE.Mesh(discGeo, discMat);
  coreMesh.userData = { isVoiceOrb: true };
  group.add(coreMesh);

  // 2. Solid Inner Baseline Hairline Ring
  const innerRingGeo = new THREE.RingGeometry(0.475, 0.49, 64);
  const innerRingMat = new THREE.MeshBasicMaterial({
    color: secondaryColor,
    transparent: true,
    opacity: isLight ? 0.75 : 0.85,
    side: THREE.DoubleSide,
  });
  const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
  group.add(innerRing);

  // 3. Dynamic NCS Waveform Perimeter Line Loop
  const WAVE_SEGMENTS = 180;
  const wavePositions = new Float32Array((WAVE_SEGMENTS + 1) * 3);
  const waveGeometry = new THREE.BufferGeometry();
  waveGeometry.setAttribute("position", new THREE.BufferAttribute(wavePositions, 3));

  const waveMaterial = new THREE.LineBasicMaterial({
    color: primaryColor,
    linewidth: 2,
    transparent: true,
    opacity: 0.95,
  });
  const waveLine = new THREE.LineLoop(waveGeometry, waveMaterial);
  group.add(waveLine);

  // 4. Radial Frequency Audio Spectrum Bars (The NCS Soundwave Spikes)
  const BAR_COUNT = 64;
  const barPositions = new Float32Array(BAR_COUNT * 2 * 3);
  const barGeometry = new THREE.BufferGeometry();
  barGeometry.setAttribute("position", new THREE.BufferAttribute(barPositions, 3));

  const barMaterial = new THREE.LineBasicMaterial({
    color: accentGlow,
    linewidth: 2,
    transparent: true,
    opacity: 0.85,
  });
  const barSegments = new THREE.LineSegments(barGeometry, barMaterial);
  group.add(barSegments);

  // Animation & Lerping State
  let currentScale = 1.0;
  let targetScale = 1.0;
  let isHovered = false;
  const baseY = 1.25;
  const baseRadius = 0.52;
  const innerBaseRadius = 0.48;

  return {
    group,
    coreMesh,
    setHovered: (hovered: boolean) => {
      isHovered = hovered;
    },
    update: (
      time: number,
      isListening: boolean,
      audioLevels: number[],
      isProcessing: boolean = false
    ) => {
      // Gentle floating breathing oscillation
      const floatOffset = Math.sin(time * 1.8) * 0.035;
      group.position.y = baseY + floatOffset;

      // Slow ambient rotation of the visualizer ring
      const spinSpeed = isHovered ? 0.015 : isListening ? 0.02 : 0.005;
      group.rotation.z += spinSpeed;

      // Calculate Audio Energy from voice
      let voiceEnergy = 0;
      if (isListening && audioLevels && audioLevels.length > 0) {
        const avg = audioLevels.reduce((a, b) => a + b, 0) / audioLevels.length;
        voiceEnergy = Math.min(1.0, Math.max(0.0, (avg - 10) / 40));
      }

      // Calculate Agent Energy (synthesis & response)
      const agentEnergy = isProcessing
        ? Math.sin(time * 8.0) * 0.15 + 0.2
        : 0;

      const totalEnergy = Math.max(voiceEnergy, agentEnergy);

      // Target Scale Composition
      const hoverBoost = isHovered ? 0.18 : 0.0;
      const energyScaleBoost = totalEnergy * 0.25;
      targetScale = 1.0 + hoverBoost + energyScaleBoost;

      // Smooth GPU matrix lerp
      currentScale = THREE.MathUtils.lerp(currentScale, targetScale, 0.2);
      group.scale.setScalar(currentScale);

      // 1. Update NCS Perimeter Waveform Points
      const wavePosAttr = waveGeometry.attributes.position as THREE.BufferAttribute;
      const waveArray = wavePosAttr.array as Float32Array;

      for (let i = 0; i <= WAVE_SEGMENTS; i++) {
        const idx = i % WAVE_SEGMENTS;
        const theta = (idx / WAVE_SEGMENTS) * Math.PI * 2;

        // Base idle harmonic ripple
        const idleWave =
          Math.sin(theta * 5 + time * 3.0) * 0.02 +
          Math.cos(theta * 9 - time * 2.2) * 0.012;

        // Active voice / NCS spikes
        const ncsSpike =
          totalEnergy *
          (0.06 + 0.12 * Math.abs(Math.sin(theta * 8 + time * 4.0)));

        const r = baseRadius + idleWave + ncsSpike;
        const x = Math.cos(theta) * r;
        const y = Math.sin(theta) * r;

        waveArray[i * 3] = x;
        waveArray[i * 3 + 1] = y;
        waveArray[i * 3 + 2] = 0;
      }
      wavePosAttr.needsUpdate = true;

      // 2. Update NCS Radial Frequency Spectrum Bars
      const barPosAttr = barGeometry.attributes.position as THREE.BufferAttribute;
      const barArray = barPosAttr.array as Float32Array;

      for (let k = 0; k < BAR_COUNT; k++) {
        const theta = (k / BAR_COUNT) * Math.PI * 2;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        // Inner anchor point on ring
        barArray[k * 6] = cosT * innerBaseRadius;
        barArray[k * 6 + 1] = sinT * innerBaseRadius;
        barArray[k * 6 + 2] = 0;

        // Dynamic spike height
        const idleBar = (Math.sin(k * 0.6 + time * 4.0) * 0.5 + 0.5) * 0.035;
        const reactiveBar = totalEnergy * (0.08 + 0.18 * Math.abs(Math.sin(k * 1.2 + time * 6.0)));
        const barLength = innerBaseRadius + idleBar + reactiveBar + (isHovered ? 0.04 : 0);

        // Outer bar tip
        barArray[k * 6 + 3] = cosT * barLength;
        barArray[k * 6 + 4] = sinT * barLength;
        barArray[k * 6 + 5] = 0;
      }
      barPosAttr.needsUpdate = true;

      // Color and Opacity Modulation
      if (isProcessing) {
        waveMaterial.color.setHex(0xC084FC);
        barMaterial.color.setHex(0xA855F7);
        discMat.opacity = 0.65;
      } else if (isListening) {
        waveMaterial.color.setHex(0xA855F7);
        barMaterial.color.setHex(0x8B5CF6);
        discMat.opacity = 0.55 + voiceEnergy * 0.3;
      } else if (isHovered) {
        waveMaterial.color.setHex(0xC084FC);
        barMaterial.color.setHex(0xA855F7);
        discMat.opacity = 0.55;
      } else {
        waveMaterial.color.setHex(primaryColor);
        barMaterial.color.setHex(accentGlow);
        discMat.opacity = isLight ? 0.35 : 0.45;
      }
    },
    dispose: () => {
      discGeo.dispose();
      discMat.dispose();
      innerRingGeo.dispose();
      innerRingMat.dispose();
      waveGeometry.dispose();
      waveMaterial.dispose();
      barGeometry.dispose();
      barMaterial.dispose();
    },
  };
}
