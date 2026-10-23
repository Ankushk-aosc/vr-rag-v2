import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from "react-native";
import { GLView } from "expo-gl";
import * as THREE from "three";
import { DeviceMotion } from "expo-sensors";
import { Compass, Eye, Smartphone } from "lucide-react-native";
import { THEME, ThemeMode } from "../constants/theme";

interface SpatialGyroViewProps {
  theme: ThemeMode;
  onSelectDocument?: (docTitle: string) => void;
}

export function SpatialGyroView({ theme, onSelectDocument }: SpatialGyroViewProps) {
  const colors = THEME[theme];
  const isLight = theme === "light";

  const [gyroActive, setGyroActive] = useState(true);
  const [stereoMode, setStereoMode] = useState(false);

  const rotationRef = useRef({ alpha: 0, beta: 0, gamma: 0 });

  // Subscribe to DeviceMotion sensors for mobile gyroscope head-tracking
  useEffect(() => {
    let sub: any = null;
    if (gyroActive) {
      DeviceMotion.setUpdateInterval(50);
      sub = DeviceMotion.addListener((data) => {
        if (data.rotation) {
          rotationRef.current = {
            alpha: data.rotation.alpha || 0,
            beta: data.rotation.beta || 0,
            gamma: data.rotation.gamma || 0,
          };
        }
      });
    }

    return () => {
      if (sub) sub.remove();
    };
  }, [gyroActive]);

  const onContextCreate = async (gl: any) => {
    const { drawingBufferWidth: width, drawingBufferHeight: height } = gl;
    const scene = new THREE.Scene();
    const bgColor = isLight ? 0xF2F2F7 : 0x040407;
    scene.background = new THREE.Color(bgColor);
    scene.fog = new THREE.FogExp2(bgColor, 0.05);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
    camera.position.set(0, 1.8, 4.8);
    camera.lookAt(0, 1.2, 0);

    // Left and Right cameras for stereo mode
    const cameraLeft = new THREE.PerspectiveCamera(65, (width / 2) / height, 0.1, 100);
    const cameraRight = new THREE.PerspectiveCamera(65, (width / 2) / height, 0.1, 100);
    cameraLeft.position.set(-0.032, 1.8, 4.8);
    cameraRight.position.set(0.032, 1.8, 4.8);

    const renderer = new THREE.WebGLRenderer({
      canvas: {
        width,
        height,
        style: {},
        addEventListener: () => {},
        removeEventListener: () => {},
        clientHeight: height,
      } as any,
      context: gl,
      antialias: true,
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(Dimensions.get("window").scale, 2));

    // 1. Circular Gallery Podium
    const podiumGeo = new THREE.CylinderGeometry(3.2, 3.4, 0.2, 32);
    const podiumMat = new THREE.MeshStandardMaterial({
      color: isLight ? 0xE4E4EC : 0x0C0C14,
      roughness: 0.8,
      metalness: 0.2,
    });
    const podium = new THREE.Mesh(podiumGeo, podiumMat);
    podium.position.y = -0.12;
    scene.add(podium);

    // Dark Purple Concentric Hairline Rim
    const rimGeo = new THREE.RingGeometry(3.15, 3.19, 32);
    const rimMat = new THREE.MeshBasicMaterial({
      color: isLight ? 0x6D28D9 : 0x8B5CF6,
      side: THREE.DoubleSide,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.01;
    scene.add(rim);

    // 2. Floating 3D Document Slabs
    const slabGeo = new THREE.BoxGeometry(0.85, 1.25, 0.04);
    const slabEdgesGeo = new THREE.EdgesGeometry(slabGeo);
    const slabs: THREE.Mesh[] = [];

    const docConfigs = [
      { title: "ATO Notice FY24", pos: [-1.6, 1.3, -0.6], rotY: 0.35 },
      { title: "Macquarie Wrap", pos: [1.6, 1.3, -0.6], rotY: -0.35 },
      { title: "AustralianSuper", pos: [-0.8, 1.6, -1.6], rotY: 0.15 },
      { title: "Smith Trust Deed", pos: [0.8, 1.6, -1.6], rotY: -0.15 },
    ];

    docConfigs.forEach((cfg) => {
      const slabMat = new THREE.MeshStandardMaterial({
        color: isLight ? 0xF0F0F5 : 0x1E1B2E,
        roughness: 0.3,
        metalness: 0.1,
      });

      const slab = new THREE.Mesh(slabGeo, slabMat);
      slab.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      slab.rotation.y = cfg.rotY;
      slab.userData = { title: cfg.title, originalY: cfg.pos[1] };

      // Wireframe edge
      const edgeMat = new THREE.LineBasicMaterial({
        color: isLight ? 0x6D28D9 : 0xA78BFA,
      });
      const wireframe = new THREE.LineSegments(slabEdgesGeo, edgeMat);
      slab.add(wireframe);

      scene.add(slab);
      slabs.push(slab);
    });

    // 3. Central Dark Purple Rotating Core Ring
    const ringGeo = new THREE.TorusGeometry(0.6, 0.02, 16, 40);
    const ringMat = new THREE.MeshStandardMaterial({
      color: isLight ? 0x6D28D9 : 0x8B5CF6,
      roughness: 0.2,
      metalness: 0.8,
    });
    const coreRing = new THREE.Mesh(ringGeo, ringMat);
    coreRing.position.set(0, 1.3, -1.2);
    scene.add(coreRing);

    // 4. Lighting Rig
    scene.add(new THREE.AmbientLight(0xffffff, isLight ? 1.0 : 0.8));

    const frontLight = new THREE.DirectionalLight(0xffffff, 1.0);
    frontLight.position.set(0, 2.0, 5.0);
    scene.add(frontLight);

    const overheadPoint = new THREE.PointLight(isLight ? 0x6D28D9 : 0x8B5CF6, 1.5, 8);
    overheadPoint.position.set(0, 3.0, -1);
    scene.add(overheadPoint);

    // Render loop
    const clock = new THREE.Clock();
    let animFrame: number;

    const render = () => {
      animFrame = requestAnimationFrame(render);
      const time = clock.getElapsedTime();

      // Core rotation
      coreRing.rotation.y = time * 0.4;
      coreRing.rotation.x = Math.sin(time * 0.3) * 0.15;

      // Slabs gentle breathing
      slabs.forEach((slab, idx) => {
        slab.position.y = slab.userData.originalY + Math.sin(time * 0.8 + idx) * 0.03;
      });

      // Apply Gyroscope orientation if active
      if (gyroActive) {
        const { alpha, beta, gamma } = rotationRef.current;
        const euler = new THREE.Euler(beta, alpha, -gamma, "YXZ");
        camera.quaternion.setFromEuler(euler);
        cameraLeft.quaternion.setFromEuler(euler);
        cameraRight.quaternion.setFromEuler(euler);
      }

      if (stereoMode) {
        // Split screen Cardboard rendering
        renderer.setScissorTest(true);

        renderer.setScissor(0, 0, width / 2, height);
        renderer.setViewport(0, 0, width / 2, height);
        renderer.render(scene, cameraLeft);

        renderer.setScissor(width / 2, 0, width / 2, height);
        renderer.setViewport(width / 2, 0, width / 2, height);
        renderer.render(scene, cameraRight);
      } else {
        renderer.setScissorTest(false);
        renderer.render(scene, camera);
      }

      gl.endFrameEXP();
    };

    render();
  };

  return (
    <View style={styles.container}>
      <GLView style={styles.glView} onContextCreate={onContextCreate} />

      {/* Center line for Cardboard stereo mode */}
      {stereoMode && <View style={[styles.stereoDivider, { backgroundColor: colors.accent }]} />}

      {/* Floating Spatial Controls */}
      <View style={styles.controlsRow}>
        <TouchableOpacity
          onPress={() => setGyroActive(!gyroActive)}
          style={[
            styles.controlPill,
            {
              backgroundColor: gyroActive ? colors.accent : colors.surface,
              borderColor: colors.border,
            },
          ]}
          activeOpacity={0.8}
        >
          <Compass size={14} color={gyroActive ? "#FFFFFF" : colors.text} />
          <Text style={[styles.controlText, { color: gyroActive ? "#FFFFFF" : colors.text }]}>
            Gyro {gyroActive ? "Active" : "Paused"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setStereoMode(!stereoMode)}
          style={[
            styles.controlPill,
            {
              backgroundColor: stereoMode ? colors.gold : colors.surface,
              borderColor: colors.border,
            },
          ]}
          activeOpacity={0.8}
        >
          <Smartphone size={14} color={stereoMode ? "#000000" : colors.text} />
          <Text style={[styles.controlText, { color: stereoMode ? "#000000" : colors.text }]}>
            Cardboard {stereoMode ? "VR On" : "VR"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: "relative",
  },
  glView: {
    flex: 1,
  },
  stereoDivider: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: "50%",
    width: 2,
    zIndex: 10,
    opacity: 0.5,
  },
  controlsRow: {
    position: "absolute",
    top: 100,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    zIndex: 20,
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    gap: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  controlText: {
    fontSize: 11,
    fontWeight: "600",
  },
});
