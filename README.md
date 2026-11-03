# Aether Sovereign | VR-RAG

A voice-first spatial financial intelligence pavilion for Australian family offices. Hybrid (semantic + keyword) retrieval over your own documents, LLM answers grounded in cited evidence, and an interactive "View in VR" WebXR spatial computing experience with Apple visionOS styling. By default (`PRIVACY_MODE=local`) the backend keeps documents, vectors, prompts and audio inside your own deployment; see [Privacy modes](#privacy-modes).

## Key Highlights
- **Jurisdiction & Compliance:** Tailored for Australia (Cth). Adheres to Australian Privacy Principles (APPs under the Privacy Act 1988) and ASIC RG 244 factual disclaimers.
- **Privacy architecture:** two explicit modes, described in full under [Privacy modes](#privacy-modes). `local` (default) sends nothing to third parties from the backend; `cloud` is an opt-in that uses Pinecone, Groq and Microsoft edge-tts and requires an APP 8 cross-border disclosure.
- **3D Spatial Evidence Room + "View in VR":** Features an interactive 3D spatial room on desktop and mobile browsers, with a "View in VR" toggle that seamlessly enters WebXR 6DoF on Meta Quest 3 and Apple Vision Pro, plus split-screen Cardboard stereoscopic mode with gyroscope tracking.
- **Voice-Reactive Particle Orb:** Features a central concentric gyroscopic ring with an embedded 3D particle soundwave mesh that transforms dynamically during speech.
- **Cross-Platform Suite:**
  - **Web Application:** Next.js 14+ with Three.js WebXR HUD (`apps/web`).
  - **API Backend:** FastAPI Python with a local vector index (or Pinecone in cloud mode), SQLite/PostgreSQL, Whisper STT & TTS (`apps/api`).
  - **Mobile Application:** Expo React Native with gyroscope 3D tracking & Aether Voice Bar (`apps/mobile`).

## Directory Structure
```
VR-RAG/
├── apps/
│   ├── api/              # FastAPI Python backend (Ingestion, RAG, vector index, Voice)
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

## Privacy modes

Set `PRIVACY_MODE` in `.env`. The backend validates it at startup and `/api/health` reports the mode and
whether any data leaves the deployment (`data_leaves_deployment`).

### `PRIVACY_MODE=local` (default)

| Data | Where it is stored / processed |
| --- | --- |
| Original files | Local disk (`data/uploads`). `S3_BUCKET_NAME` is ignored. |
| Users, ACLs, audit log, chunk text | App database (`data/app.db`, or your PostgreSQL via `DATABASE_URL`) |
| Embeddings | Computed on this machine (fastembed `all-MiniLM-L6-v2`), stored in `chunk_vectors` |
| Document display metadata (columns, sample rows, preview) | App database (`document_meta`) |
| Keyword index | Local disk (`data/lexical`) |
| Questions + retrieved evidence | Your local OpenAI-compatible LLM server (`LOCAL_LLM_BASE_URL`, default Ollama at `http://127.0.0.1:11434/v1`, model `LOCAL_LLM_MODEL`) |
| Voice audio (server side) | On-device faster-whisper; answers spoken with the on-device TTS engine |
| Scanned documents | Tesseract on this machine. `OCR_ENGINE=textract` is ignored. |

`LOCAL_LLM_BASE_URL` must resolve to this machine or a private network (loopback, RFC 1918, link-local,
a bare service name such as `ollama`, or `*.local` / `*.internal`); startup fails otherwise. Pinecone,
Groq, edge-tts, Textract and S3 settings are ignored, so leaving their keys in `.env` sends nothing.

Setup: install a local LLM server (for example `ollama pull qwen3:8b`), then start the API. Model
weights (fastembed, Whisper, the LLM) are downloaded once when first used; no user data is sent.

**Moving from cloud mode:** chunk text is already in the app database. Run
`python -m app.scripts.build_local_vectors` in `apps/api` to embed it into the local index on this
machine (add `--dry-run` to only count). Until then those documents are keyword-searchable only; the
API logs a warning at startup. Data previously written to Pinecone stays there until you delete the
index in the Pinecone console.

**Web client in local mode:** the web app asks `/api/health` for the mode and keeps browser speech
services off unless the answer is `cloud` (an unreachable API counts as local):
- Browser `SpeechRecognition` (Chrome sends that audio to Google) is never started, so there are no
  live captions while you talk and no "Hey Aether" wake word. Tap the mic or orb to talk; each
  question is transcribed by the backend's own Whisper.
- The browser read-aloud fallback uses only on-device voices (`localService`); if there are none, the
  answer is shown but not spoken.
- Fonts are self-hosted by `next/font` (downloaded once at build time), so visitors never contact Google.

### `PRIVACY_MODE=cloud` (opt-in, APP 8 cross-border disclosure required)

Embeddings, **full chunk text, filenames and table previews** are stored in Pinecone Serverless
(`PINECONE_CLOUD`/`PINECONE_REGION`, default AWS `us-east-1`, United States). Questions and retrieved
evidence are sent to the configured LLM (Groq by default, United States). Voice audio is transcribed
by Groq Whisper and answers are synthesised by Microsoft edge-tts, with local fallbacks. Original
files go to S3 when `S3_BUCKET_NAME` is set, and scanned pages to AWS Textract when
`OCR_ENGINE=textract`. Retention follows each provider's terms; data is not deleted from Pinecone
until the document is deleted in the app. Operators must hold client consent and Data Processing
Agreements with each provider in accordance with APP 8.

## Quick Start
1. Copy `.env.example` to `.env`. For the default local mode, start a local LLM server (see [Privacy modes](#privacy-modes)); for cloud mode set `PRIVACY_MODE=cloud` and your API keys (`PINECONE_API_KEY`, `GROQ_API_KEY`).
2. Run backend: `python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` in `apps/api`.
3. Run web frontend: `npm run dev` in `apps/web`.
4. Run mobile app: `npx expo start` in `apps/mobile`.

### Docker
`docker compose up --build` starts PostgreSQL, the API (port 8000) and the web app (port 3000).
Fill in `APP_SECRET_KEY`, `POSTGRES_ADMIN_PASSWORD` and `APP_DB_PASSWORD` in `.env` first; compose
refuses to start without them. On first start, `docker/postgres/init-app-role.sh` creates a
non-superuser application role, so row-level security applies to every API query, and the API runs
the migrations itself. In local mode the API reaches an LLM server on the host at
`http://host.docker.internal:11434/v1` (override with `DOCKER_LOCAL_LLM_BASE_URL`). The embedding model
is baked into the API image; Whisper downloads its model into the `api_models` volume on first use.
`NEXT_PUBLIC_API_URL` is compiled into the web bundle, so rebuild the web image after changing it.
