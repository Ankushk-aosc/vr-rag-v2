# Aether Sovereign | VR-RAG

A sovereign, voice-first spatial financial intelligence pavilion for Australian family offices. Integrates high-performance vector search via **Pinecone**, local zero-leakage SQLite text storage, multi-model LLM inference, and an interactive "View in VR" WebXR spatial computing experience with Apple visionOS styling.

## Key Highlights
- **Jurisdiction & Compliance:** Tailored for Australia (Cth). Adheres to Australian Privacy Principles (APPs under the Privacy Act 1988) and ASIC RG 244 factual disclaimers.
- **Privacy-Preserving Hybrid Architecture:** Only anonymous vector embeddings and chunk ID pointers are sent to Pinecone. Sensitive raw tax returns, bank statements, names, and account numbers remain strictly on your local machine in SQLite.
- **3D Spatial Evidence Room + "View in VR":** Features an interactive 3D spatial room on desktop and mobile browsers, with a "View in VR" toggle that seamlessly enters WebXR 6DoF on Meta Quest 3 and Apple Vision Pro, plus split-screen Cardboard stereoscopic mode with gyroscope tracking.
- **Voice-Reactive Particle Orb:** Features a central concentric gyroscopic ring with an embedded 3D particle soundwave mesh that transforms dynamically during speech.
- **Cross-Platform Suite:**
  - **Web Application:** Next.js 14+ with Three.js WebXR HUD (`apps/web`).
  - **API Backend:** FastAPI Python with Pinecone, SQLite, Whisper STT & neural TTS (`apps/api`).
  - **Mobile Application:** Expo React Native with gyroscope 3D tracking & Aether Voice Bar (`apps/mobile`).

## Directory Structure
```
VR-RAG/
├── apps/
│   ├── api/              # FastAPI Python backend (Ingestion, RAG, Pinecone, Voice)
│   ├── web/              # Next.js 14+ frontend with Three.js Spatial Pavilion
│   └── mobile/           # Expo React Native mobile app with spatial gyroscope
├── packages/
│   └── contracts/        # Shared API data models and TypeScript schemas
├── data/
│   ├── uploads/          # Local staging for uploaded Australian financial documents
│   └── app.db            # Local SQLite database (users, ACL, raw chunks, audit)
├── .env.example          # Environment configuration template
├── .gitignore            # Git exclusions (credentials, .env, DB, node_modules)
└── README.md
```

## Quick Start
1. Copy `.env.example` to `.env` and configure your API keys (`PINECONE_API_KEY`, etc.).
2. Run backend: `python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` in `apps/api`.
3. Run web frontend: `npm run dev` in `apps/web`.
4. Run mobile app: `npx expo start` in `apps/mobile`.
