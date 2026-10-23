# Aurora Spatial HUD Frontend Design Specification

## 1. Approved Visual Concept
- **Concept:** Cyber-tactile glass cockpit and spatial computing workspace for family wealth & tax governance.
- **Audience:** Family members, trustees, and advisers interacting via desktop, mobile, or WebXR headsets (Meta Quest 3, Apple Vision Pro).

## 2. Color Tokens
- Canvas Void Black: `#05050A` (Deepest backdrop)
- Neon Electric Cyan: `#00F0FF` (Primary telemetry, focus states, verified badges)
- Hyper Violet: `#7928CA` (Secondary accents, category tags)
- Smoke Glass Surface: `rgba(20, 20, 35, 0.65)` with backdrop-filter blur (16px) and 1px border `rgba(0, 240, 255, 0.2)`
- High-Contrast White: `#FFFFFF` (Primary text and numbers)
- Muted Slate: `#8E9AA8` (Captions, timestamps, secondary labels)
- Warning/Disclaimer Amber: `#FFB800` (Regulatory notices)

## 3. Typography
- Display / Telemetry / Numbers: `Space Grotesk` (weights: 500, 700)
- Conversational / Document Text: `Inter` (weights: 400, 500, 600)
- Monospace / Hashes / BSB: `JetBrains Mono`

## 4. YouTube-Style "View in VR" Architectural State Machine
- Default View: Full-screen interactive 3D Three.js canvas with OrbitControls (drag to rotate, scroll to zoom) on desktop and touch on mobile.
- Persistent HUD Control: "VIEW IN VR" button with live capability badge:
  1. `WebXR Available`: Triggers `navigator.xr.requestSession('immersive-vr')`.
  2. `Mobile Fallback`: Cardboard / DeviceOrientation stereoscopic view.
  3. `Desktop No Headset`: Launches pairing modal with dynamic QR code for instant Quest / Vision Pro browser session handoff.

## 5. Voice Interaction Design
- Glowing 3D Neon Audio Orb in spatial canvas reacting dynamically to microphone input amplitude.
- Real-time transcription streaming with interactive citation chips linking to original document page offsets.
