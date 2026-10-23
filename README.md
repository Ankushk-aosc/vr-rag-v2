# Aurora Spatial Financial RAG (Australia)

A privacy-first, voice-enabled financial document knowledge assistant designed for Australian families. Integrates high-performance cloud vector search via **Pinecone**, local zero-leakage SQLite text storage, local LLM inference via **Ollama**, and a YouTube-style interactive "View in VR" WebXR spatial experience.

## Key Highlights
- **Jurisdiction & Compliance:** Tailored for Australia (Cth). Adheres to Australian Privacy Principles (APPs under the Privacy Act 1988) and ASIC RG 244 factual disclaimers.
- **Privacy-Preserving Hybrid Architecture:** Only anonymous vector embeddings and chunk ID pointers are sent to Pinecone. Sensitive raw tax returns, bank statements, names, and account numbers remain strictly on your local machine in SQLite.
- **Always-On 3D Canvas + "View in VR":** Features an interactive 3D spatial room on desktop and mobile browsers, with a YouTube-style "View in VR" toggle that seamlessly enters WebXR 6DoF on Meta Quest 3 and Apple Vision Pro.
- **Local Speech Pipeline:** Local speech-to-text via `faster-whisper` and local text-to-speech with Australian English accent profiling.

## Directory Structure
```
d:/VR-RAG/
├── .agents/              # Agent rules and architecture constraints (git-ignored)
├── apps/
│   ├── api/              # FastAPI Python backend (Ingestion, RAG, Pinecone, Voice)
│   └── web/              # Next.js 14+ frontend with React Three Fiber WebXR HUD
├── packages/
│   └── contracts/        # Shared API data models and TypeScript schemas
├── data/
│   ├── uploads/          # Local staging for uploaded Australian financial documents
│   └── app.db            # Local SQLite database (users, ACL, raw chunks, audit)
├── .env.example          # Environment configuration template
├── .gitignore            # Git exclusions
└── README.md
```

## Quick Start
1. Copy `.env.example` to `.env` and provide your free `PINECONE_API_KEY`.
2. Follow backend setup instructions in `apps/api/README.md`.
3. Follow frontend setup instructions in `apps/web/README.md`.
