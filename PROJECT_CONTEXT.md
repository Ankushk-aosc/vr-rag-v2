# PROJECT_CONTEXT.md — VR-RAG / Aether Sovereign

> Architecture reference, written from a full read of the repo at commit `6c44519` (2026-11-02).
> It describes what the code **actually does**, which sometimes differs from what README/docs say.
> Those gaps are listed in §11. Open issues and the decision log are in [AGENT_MEMORY.md](AGENT_MEMORY.md).

---

## 1. What the product is

A voice-first, 3D/WebXR "spatial" financial RAG assistant for **Australian family offices**.
Users upload financial documents (PDF, DOCX, XLSX, CSV, TXT, MD, images) into a per-family "vault".
They then ask questions by text or voice and get answers grounded in those documents, with
numbered citations, auto-generated dashboards/charts, and a Three.js room viewable in VR
(Quest, Vision Pro, Cardboard).

Domain rules ([.agents/australian_financial_rules.md](.agents/australian_financial_rules.md)):
- AUD, FY 1 Jul–30 Jun, ATO/super/franking terminology.
- ASIC RG 244: answers are factual info, **not** financial advice. The disclaimer is always attached.
- **Read-only**: no write-capable tools or banking APIs.
- Unanswerable questions must abstain rather than guess.
- APP 8 cross-border disclosure for any cloud processing.

## 2. Monorepo layout

```
VR-RAG/
├── .agents/                 # Standing rules for AI agents (base, AU financial, HUD design)
├── .github/workflows/evals.yml   # CI: fast eval suite on PR/push, nightly real-LLM suite
├── apps/
│   ├── api/                 # FastAPI backend (Python; CI uses 3.11, local host has 3.14)
│   │   ├── app/
│   │   │   ├── main.py      # App factory, lifespan, CORS, global error handler, /api/health
│   │   │   ├── config.py    # pydantic-settings Settings (all env vars)
│   │   │   ├── routers/     # auth, documents, query, voice, dashboards, providers
│   │   │   ├── services/    # rag_engine, pinecone_service, lexical_index, embeddings, grounding,
│   │   │   │                #   prompt_guard, extractor, chunker, ocr/, datasets, dashboards,
│   │   │   │                #   voice, upload_security, storage, table_reader, usage, auth
│   │   │   ├── providers/   # Phase 4a multi-provider registry (llm/embed/vector/speech) + costs
│   │   │   ├── middleware/  # rate_limiter (dependency), token_budget
│   │   │   ├── db/          # sqlite.py shim → repositories (SQLite or SQLAlchemy/Postgres),
│   │   │   │                #   models.py, session.py, reconcile.py, migrate_sqlite_to_postgres.py
│   │   │   ├── schemas/     # Pydantic request/response models (document, query)
│   │   │   └── scripts/     # ingest_aapl.py, migrate_sqlite_to_pinecone.py (legacy utilities)
│   │   ├── alembic/         # 001 schema + RLS, 002 llm_usage + RLS (Postgres only)
│   │   ├── evals/           # Golden-set RAG evaluation harness (corpus, golden.jsonl, metrics)
│   │   ├── tests/           # pytest suite (146 tests collected)
│   │   └── requirements.txt # INCOMPLETE (see §11)
│   ├── web/                 # Next.js 14.2 (App Router, single page) + Three.js/R3F + WebXR
│   └── mobile/              # Expo SDK 58 / React Native 0.88 client
├── docs/                    # POC.md, runbook.md (partly stale), AUDIT_REMEDIATION_FEATURES.md
├── docker-compose.yml       # postgres + api + web (I-17); docker/postgres/init-app-role.sh; .env.example
├── VR-RAG_AI_Agent_Remediation_Master_Plan.md   # 58-item remediation contract (authoritative)
├── PROJECT_CONTEXT.md       # this file
└── AGENT_MEMORY.md          # running memory: decisions, issues, tasks
```

`packages/contracts/` is listed in README but **does not exist**. Neither does `.env.example`
(deleted in `7f5b71e`).

## 3. Runtime topology

```
Web (Next.js :3000)  ─┐
Mobile (Expo :8081)  ─┼─► FastAPI (:8000)
                      │     ├─ Auth: PBKDF2-600k + HS256 JWT (24h, jti revocation)
                      │     ├─ SQL system of record: SQLite (default) | Postgres (DATABASE_URL)
                      │     ├─ Lexical BM25 index: in-memory, per-tenant, cached in data/lexical/*.json
                      │     ├─ Original files: data/uploads/ (local) | S3 (S3_BUCKET_NAME, cloud mode only)
                      │     ├─ PRIVACY_MODE=local (DEFAULT, I-09): nothing leaves the backend
                      │     │    vectors → SQL `chunk_vectors` (numpy cosine, tenant+role filter before scoring)
                      │     │    display meta → SQL `document_meta`; text hydrated from `document_chunks`
                      │     │    LLM → LOCAL_LLM_BASE_URL (must be loopback/private; default Ollama :11434)
                      │     │    STT faster-whisper, TTS pyttsx3, OCR Tesseract
                      │     └─ PRIVACY_MODE=cloud (opt-in) outbound:
                      │          Pinecone (vectors + FULL chunk text + doc registry), us-east-1
                      │          Groq / OpenAI-compatible LLM (prompt + evidence)
                      │          Groq Whisper STT (fallback to local faster-whisper)
                      │          Microsoft edge-tts (fallback pyttsx3), Textract/S3 if configured
                      │     (both modes: one-time model-weight downloads, no user data)
```

**Privacy-mode switch points** (all read `settings.is_local_mode` at call time):
- `services/vector_index.py`: facade picking `local_vector_index` or `pinecone_service` for upsert, query,
  delete, and the document registry (save/list/get). Routers, `rag_engine`, `reconcile` and `ingest_aapl` call it.
- `pinecone_service.get_pinecone_client()` returns None in local mode (chokepoint: every Pinecone path no-ops,
  so lexical build and table reads fall back to SQL).
- `providers/llm/registry.get_llm_provider`: in local mode, `fake`, `local` and private-URL `openai_compatible`
  are kept; anything else (e.g. `groq`) is replaced by the `local` provider with a warning.
- `rag_engine.get_groq_client()` → None (dashboard planning uses its deterministic plan). `voice.transcribe_with_groq`
  → None. `voice.synthesize_speech` → pyttsx3 only. `ocr.router.get_ocr_engine` swaps textract → Tesseract.
  `StorageService._use_s3()` → False.
- Backfill for cloud-era documents: `python -m app.scripts.build_local_vectors [--dry-run]`.
  `migrate_sqlite_to_pinecone` refuses to run in local mode.
- Web client (I-26): `useVoiceEngineSetup` calls `fetchPrivacyMode()` (`/api/health`) and stores `voiceStore.privacyMode`
  (`"unknown"` until answered, so it fails closed). `cloudSpeechAllowed()` gates `getRecognitionCtor()` (the single
  chokepoint for browser `SpeechRecognition`: live words, wake word, standby), `startStandby`, the return-to-standby in
  `endConversation`, and restricts `speakWithBrowser` to `localService` voices. `VoiceSettings` disables the "Browser"
  STT option in local mode. Fonts are self-hosted via `next/font/google` in `app/layout.tsx` (`--font-inter-self`,
  `--font-mono-self`). Static checks: `apps/api/tests/test_web_client_privacy.py`.

Paths such as `data/app.db` and `data/uploads` are **relative to the process CWD**. Running
uvicorn from `apps/api` uses `apps/api/data/`, not the repo-root `data/`. Both directories exist locally.

## 4. Backend: request flows

### 4.1 Startup (`main.py` lifespan)
1. `sqlite.init_db()` creates the tables. In SQLite mode this is raw DDL. In Postgres mode (I-16) it is
   `postgres_setup.prepare_database`: refuse a legacy create_all schema, `alembic upgrade head` (001-006), then verify
   RLS enabled+forced on the 7 tenant tables and that the role is not superuser/BYPASSRLS (fatal outside dev).
   Then it seeds the demo admin (dev/test only).
   RLS model: `get_db_session(family_ids=[...])` → `set_config('app.current_family_ids', ..., true)`;
   `get_db_session(system=True)` → `app.rls_bypass='on'`, only for id lookups authorized in code (policy in migration 005).
   Live check: run a non-superuser owner role against Postgres and set `TEST_DATABASE_URL` for `tests/db` + token-budget tests.
2. Builds the provider-registry embedder + vector store into `app.state`, then runs the **embedder
   consistency guard**: it refuses to start if the index has vectors whose model/dim differ from the configured embedder.
3. Spawns daemon threads to warm the fastembed model, build the lexical index (from disk cache,
   then Pinecone, or SQLite if Pinecone is unconfigured), pre-parse datasets for `default_family`,
   and warm faster-whisper.

### 4.2 Auth (`routers/auth.py`, `services/auth.py`)
- `POST /api/auth/register`: creates a user. With a valid `invite_token` the user joins that family with
  the invite's role. A bare `invite_entity_id` without a token → 403. With no invite, it creates a new
  `fam_<12hex>` entity and makes the user `family_admin`.
- `POST /api/auth/invites` (family_admin of the entity): issues a signed single-use invite JWT
  (`typ=family_invite`, role `family_member`|`read_only_adviser`, 1–168h). It is redeemed by marking its jti in `revoked_tokens`.
- Demo admin is seeded only when `SEED_DEMO_ADMIN` and `ENVIRONMENT` ∈ development/test.
- `POST /api/auth/login`: constant-time dummy hash on unknown email, masked-email audit log,
  403 if the user has no memberships.
- `get_current_user` dependency: decode JWT → check `jti` not revoked → load user → attach
  `memberships` from DB. **Tenancy is always derived from DB memberships, never from the token.**
- Also: `/me`, `/audit` (admin = entity-wide, else own events), `/logout` (revoke jti),
  `/password-reset`, `DELETE /account`.
- Roles: `family_admin`, `family_member`, `read_only_adviser` (Postgres CHECK constraint).
- Rate limits: register/login 20/min.

Session versioning (I-15): access tokens carry `ver` = `users.token_version` (issue them with `auth.issue_access_token`). A password change bumps the version, so every older token gets 401; the reset response includes a fresh `access_token` for the caller.

### 4.3 Document ingestion (`POST /api/documents/upload`, `/upload-batch`)
`_validate_uploader` checks membership in the target `family_entity_id` (form field) and rejects
read-only advisers. Then `_process_single_upload`:
1. `sanitize_filename`, extension allow-list, reject `.doc/.xls`.
2. Stream to a temp file in 64 KB chunks with SHA-256 and a size cap (`MAX_FILE_SIZE_MB`=100).
3. Magic-byte check, zip-bomb check (OOXML, 50:1, 150 MB).
4. Per-tenant duplicate hash → 409.
5. `storage_service.persist_original`.
6. `extractor.extract_document` runs in a thread (PyMuPDF, python-docx, openpyxl read-only, csv).
   It routes OCR per page (`services/ocr/router.py`: tesseract | textract | noop) for scanned pages.
   Limits: 200 PDF pages, 50k CSV rows.
7. `chunker.chunk_document`: tables become atomic chunks with id `{doc}_p{page}_t{i}`, and text is split
   into ~600-char chunks with 100 overlap. Page provenance and OCR confidence are kept.
8. SQL: insert document as `pending`, plus ACL row and chunks.
9. Embed with **legacy `services/embeddings.embed_texts`** (fastembed MiniLM-384, fail-closed), then
   `pinecone_service.upsert_vectors`. Status becomes `indexed`, or `unindexed` if Pinecone is unconfigured and 0 vectors were written.
   On failure it deletes vectors and the stored file and marks the document `failed`.
10. Saves the doc registry record into the Pinecone `documents_registry` namespace (a unit vector carries the metadata),
    writes the `DOCUMENT_UPLOADED` audit event, and adds the chunks to the lexical index.

Pinecone chunk metadata: `family_entity_id`, `allowed_roles` (list), `document_id`, page, `is_table`,
OCR info, embedder model/dim, and **`text` (full chunk text)** plus `original_name`.
`allowed_role=family_admin` → `["family_admin"]`; anything else → `["family_admin","family_member"]`.
Uploader `allowed_role` must be `family_member` or `family_admin` (422 otherwise). At query time
`resolve_roles` maps `read_only_adviser` → `family_member`, so advisers retrieve family-wide chunks but never admin-only ones (I-07).
The Postgres tsvector lexical path applies the same ACL rule via `document_acl`.

Duplicates (I-24): the UNIQUE(family_entity_id, file_hash) constraint is authoritative; `insert_document` raises `DuplicateDocumentError` and the upload answers 409 after deleting its stored original. A re-upload of a file whose earlier ingestion failed replaces the failed row.

### 4.4 Document read/delete
- `GET /api/documents`: Pinecone registry query filtered to the family inside Pinecone (top_k 1000), ACL-filtered for
  non-admins, merged with every SQL `get_documents_by_entity` doc (ACL-filtered, excludes failed) the registry didn't return.
- `GET /api/documents/suggestions`: heuristic suggestion chips from columns and file names (same listing helper).
- `GET /api/documents/{id}` and `/{id}/table`: `_load_authorized_document`. The SQL row decides tenancy and ACL,
  and the Pinecone registry adds display metadata. Registry-only docs are admin-only. Table pages read the
  `{doc}_p{page}_t0` chunk from Pinecone, falling back to SQL `document_chunks`. Works with Pinecone off.
- Listing via the Pinecone registry is filtered to SQL-ACL-visible docs for non-admins.
- `DELETE /api/documents/{id}` (family_admin of the SQL row's entity): Pinecone (registry + vectors by ID, with filter fallback)
  → stored original (local/S3) → lexical → SQL row (cascade) → `DOCUMENT_DELETED` audit. If Pinecone or storage can't
  confirm → 502 + `DOCUMENT_DELETE_INCOMPLETE` audit, and the SQL row is kept for retry.

### 4.5 Query / RAG (`routers/query.py` → `services/rag_engine.py`)
`POST /api/query` (JSON) and `POST /api/query/stream` (SSE). Both are rate-limited 45/min, run `resolve_roles`
(membership in the requested `family_entity_id`), and check the token budget.
`stream_rag_events` is the single pipeline; `execute_rag_query` drains it.
1. **understand**: `extract_dates`. Short follow-ups (<9 words) get the previous user turn prepended.
2. **search**: runs these concurrently:
   - semantic: `services.embeddings.embed_query` (fastembed MiniLM-384, the same embedder as ingestion), with a dims check
     against `EMBEDDING_DIMENSION`. Then `pinecone_service.query_similar_chunks` with a
     metadata filter `{family_entity_id: $eq, allowed_roles: $in user_roles}`.
   - lexical: `lexical_index.search` (per-tenant BM25 partition; optional Postgres `ts_rank`).
3. **rank** (`_fuse`): RRF (k=60), drop semantic score <0.15, +0.05 exact-date boost, ×0.3 for
   tiny passages, max 3 per doc, snippet dedup. Then evidence packing (5200-char budget).
4. Token-budget check, then `guard_query_context`.
5. Build messages: system prompt + sanitized history (`prompt_guard`) + `<evidence id source page>`
   blocks (escaped) + question + TEXT_FORMAT/VOICE_FORMAT.
6. `llm.chat(temperature=0.2, max_tokens=3072)`. This is **not token-streamed**: the whole answer arrives,
   then it is emitted as one `answer` delta. `<think>` blocks are split out into a `reasoning` event, which **is
   sent to the client** (it appears in the "thinking panel").
7. Usage is recorded to `llm_usage`. `verify_grounding` checks that citations `[n]` map to evidence and that
   numeric tokens appear in the evidence. A `done` event carries the answer, structured_data (parsed from the Markdown),
   citations, grounded flag, unverified claims, accuracy and disclaimer.

SSE event types: `stage | sources | reasoning | answer | done | error`.

Model reasoning (I-10): `rag_engine.strip_model_reasoning` removes `<think>` output (complete, template-opened or unterminated) before anything is streamed, returned or spoken. The SSE stream has no `reasoning` event and `QueryResponse.reasoning` is always empty.

### 4.6 Voice (`routers/voice.py`, `services/voice.py`)
`/api/voice/transcribe` (Groq Whisper, then local faster-whisper, with hallucination filter),
`/synthesize` (edge-tts `en-AU-NatashaNeural`, then pyttsx3), `/ask` (transcribe → RAG voice mode → TTS),
`/status`, `/client-log` (authenticated, newline-stripped). All require auth and are rate-limited.

### 4.7 Dashboards (`routers/dashboards.py`, `services/datasets.py`, `services/dashboards.py`)
Parses Markdown tables from the tenant's lexical chunks into typed `Dataset`s (date/amount/category
columns). `build_dashboard` picks the best dataset, plans it with `default_plan` or `llm_plan` (Groq via
legacy `get_groq_client`), and resolves KPIs and series. The web app renders these in Recharts (2D) or Three.js (3D).

### 4.8 Providers (`app/providers/`, Phase 4a)
Registries keyed by env:
`LLM_PROVIDER` (fake | openai_compatible | groq), `EMBEDDER_PROVIDER` (fake | local_st | openai_compatible),
`VECTOR_STORE` (memory | pinecone | pgvector), `STT_PROVIDER`/`TTS_PROVIDER` (fake).
`GET /api/providers` shows the active config.
**Only the registry LLM is actually used by the request path.** Ingestion, query embedding, document registry
and retrieval all go through the legacy `services/pinecone_service.py` and `services/embeddings.py`. The
registry `VectorStore` (`app.state.vector_store`) is used only by the startup guard and `reembed.py`.
Unconfigured-store contract: `query()` → `[]`, delete → False, no network calls.

### 4.9 Persistence
- `app/db/sqlite.py` is a **compatibility shim**. Every router calls `sqlite.<fn>()`, which dispatches to
  `repositories/sqlite_repo.py` or `repositories/sqlalchemy_repo.py` depending on `is_postgres()`
  (`DATABASE_URL` set and not `sqlite*`).
- Tables: `users, family_entities, memberships, documents (UNIQUE family+hash), document_acl,
  document_chunks, audit_events, revoked_tokens, llm_usage`.
- Postgres RLS (alembic only) uses the session var `app.current_family_ids` set by
  `session.set_tenant_context` (`SET LOCAL`). Many SQLAlchemy repo methods open sessions without
  `family_ids`, so under FORCE RLS they will see 0 rows for tenant tables (needs verification against real PG).
- Tools: `python -m app.db.reconcile [--dry-run]` resolves stuck `pending` docs and purges orphan registry entries.
  `app/db/migrate_sqlite_to_postgres.py`. `python -m app.providers.reembed --confirm`.

### 4.10 Errors and limits
- Client-facing errors never carry exception text (I-11): use `safe_errors.log_with_reference(context, exc)` and return `safe_message(summary, ref)`; the global 500 handler does the same with `correlation_id`. Raise `extractor.ExtractionRejected` for messages meant for the uploader.
- The global handler returns a generic 500 with a `correlation_id`. However, `query.py` returns
  `f"Query execution error: {e}"` (it leaks exception text), and the SSE path does the same.
- Rate limiter: in-memory sliding window per path. `per="user"` keys on the verified JWT `sub` (falls back to IP);
  `per="ip"` is used on login/register.
- Token budget: disabled by default (`TOKEN_BUDGET_ENABLED=False`).

## 5. API endpoint inventory

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /api/health | none | liveness + public `privacy_mode`, `data_leaves_deployment` only (I-23) |
| GET | /api/health/details | JWT, family_admin | env, providers, embedding backend, keyword index state, STT state; no raw errors |
| POST | /api/auth/register | none | 20/min |
| POST | /api/auth/login | none | 20/min per IP |
| POST | /api/auth/invites | JWT admin | 20/min per user |
| GET | /api/auth/me | JWT | |
| GET | /api/auth/audit | JWT | admin→entity, else self |
| POST | /api/auth/logout | JWT | revokes jti |
| POST | /api/auth/password-reset | JWT | does not revoke other sessions |
| DELETE | /api/auth/account | JWT | |
| POST | /api/documents/upload | JWT | form: file, family_entity_id, allowed_role (`family_member`\|`family_admin`) |
| POST | /api/documents/upload-batch | JWT | |
| GET | /api/documents | JWT | ?family_entity_id |
| GET | /api/documents/suggestions | JWT | |
| GET | /api/documents/{id} | JWT | SQL ACL-checked |
| GET | /api/documents/{id}/table | JWT | page, page_size, search |
| DELETE | /api/documents/{id} | JWT admin | |
| POST | /api/query | JWT | 45/min |
| POST | /api/query/stream | JWT | SSE, 45/min |
| POST | /api/voice/transcribe | JWT | |
| POST | /api/voice/synthesize | JWT | |
| POST | /api/voice/ask | JWT | form family_entity_id |
| GET | /api/voice/status | JWT | |
| POST | /api/voice/client-log | JWT | |
| POST | /api/dashboards | JWT | |
| GET | /api/providers | JWT | |

There is no API versioning or pagination on list endpoints (master plan items 42/43).

## 6. Configuration (env vars, `app/config.py`)

`.env` is loaded from several locations (repo root, `apps/`, `apps/api/`, CWD). **Later files in the list
override earlier ones**, so `apps/api/.env` wins over the root `.env`. Both exist locally.

| Group | Vars (default) |
|---|---|
| Core | `ENVIRONMENT`(development), `APP_SECRET_KEY` (validated ≥32 chars outside dev/test), `API_HOST`, `API_PORT` |
| DB | `SQLITE_DB_PATH`(data/app.db), `DATABASE_URL`, `USE_POSTGRES_LEXICAL`, `UPLOADS_DIR`, `MAX_FILE_SIZE_MB`(100) |
| Privacy (I-09) | `PRIVACY_MODE`(local \| cloud), `LOCAL_LLM_BASE_URL`(http://127.0.0.1:11434/v1), `LOCAL_LLM_MODEL`(qwen3:8b), `LOCAL_LLM_API_KEY` |
| Pinecone (cloud mode) | `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`(australian-financial-rag), `PINECONE_CLOUD`, `PINECONE_REGION`(us-east-1) |
| Legacy embed | `EMBEDDING_MODEL`(all-MiniLM-L6-v2), `EMBEDDING_DIMENSION`(384), env `DISABLE_EMBEDDING_MODEL` |
| Groq (cloud mode) | `GROQ_API_KEY`, `GROQ_MODEL`(qwen/qwen3.8-27b), `GROQ_REASONING_EFFORT`, `GROQ_STT_MODEL` |
| Voice | `WHISPER_MODEL_SIZE`, `WHISPER_DEVICE`, `WHISPER_CPU_THREADS`, `TTS_ENGINE`, `TTS_VOICE` |
| Providers | `LLM_PROVIDER`(fake), `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, `EMBEDDER_PROVIDER`(fake), `EMBEDDER_MODEL`, `EMBEDDER_DIM`(8), `EMBEDDER_BASE_URL/API_KEY`, `VECTOR_STORE`(memory), `STT_PROVIDER`, `TTS_PROVIDER`, `PROVIDERS_STRICT` |
| Budget | `TOKEN_BUDGET_ENABLED`, `TENANT_DAILY_TOKEN_CAP`, `USER_DAILY_TOKEN_CAP` |
| OCR | `OCR_ENGINE`(tesseract), `OCR_LANG`, `OCR_MIN_CONFIDENCE`(0.6), `OCR_PREPROCESS_ENABLED`, `OCR_PDF_TEXT_THRESHOLD`, `S3_BUCKET_NAME`, `AWS_REGION` |
| Frontend | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_DEFAULT_CURRENCY`; mobile `EXPO_PUBLIC_API_URL` |

The local `.env` files set `LLM_PROVIDER=groq` but **not** `EMBEDDER_PROVIDER`/`EMBEDDER_DIM`. This no longer affects
retrieval (I-02 fix). Retrieval follows `EMBEDDING_MODEL`/`EMBEDDING_DIMENSION` via `services/embeddings.py`.

## 7. Web frontend (`apps/web`)

- Next 14.2.15, React 18.3, three 0.169, R3F 8, drei 9, @react-three/xr 5, Recharts 3.2, react-markdown 9
  plus remark-gfm, Tailwind 3, motion, lucide/hugeicons. No test runner, no ESLint config.
- Single route [src/app/page.tsx](apps/web/src/app/page.tsx) (`SovereignPavilionApp`, ~575 lines). It holds the
  auth bootstrap, selected entity (initialised to the first membership), chat state, SSE streaming, voice engine,
  dashboards and spatial state.
- `lib/auth.ts`: JWT and user in **localStorage** (`aether_auth_token`, `aether_auth_user`), with `getAuthHeaders()`.
- `lib/api.ts`: typed fetch wrappers for every endpoint, plus the `streamQuery` SSE reader.
- Voice: `lib/voice/VoiceEngine.ts` (~1135 lines, hands-free turn-taking; browser speech gated by privacy mode), `vad.ts`, `wakeWord.ts`,
  `speechText.ts` (sentence-split TTS), `voiceStore.ts`, `voiceLog.ts` (posted to `/api/voice/client-log`).
- Spatial: `lib/spatial/SpatialWorld.ts`, `CanvasPanel.ts`, `Dashboard3D.ts` (951 lines), `SpatialInteraction.ts`,
  `VoiceOrb3D.ts`, `spatialPanels.ts`, `spatialLayout.ts`. `lib/webxr.ts` handles WebXR plus the polyfill.
  `StereoViewer` is the Cardboard view and `VrLaunchModal` the QR/headset launcher.
- UI components: Header, RegulatoryBanner, AuthGateway (+ SwarmCursor WebGL2), AetherCommandBar,
  ChatHUD, ThinkingPanel/ThinkingTrace/ThoughtLine, LedgerView, DocumentDrawer, CitationInspector,
  DashboardPanel/DashboardView, TableViewerModal, Markdown (https-only links), FloatingPanel, VoiceSettings.
- Design tokens are in [.agents/aurora_spatial_hud_rules.md](.agents/aurora_spatial_hud_rules.md) (void black #05050A,
  cyan #00F0FF, violet #7928CA, Space Grotesk/Inter/JetBrains Mono).

## 8. Mobile (`apps/mobile`)

Expo ~58, RN 0.88, expo-av/gl/sensors/document-picker. Single [App.tsx](apps/mobile/App.tsx) with components
(AetherVoiceBar, ChatHUD, CitationBottomSheet, DocumentVaultModal, Header, SpatialGyroView).
`LoginScreen` gates the app (I-12). `src/services/api.ts`: `loginUser` → typed `AuthSession`, token in memory only
(never persisted; reopening the app signs out), `ensureOk` for every authenticated call (401 → `setUnauthorizedHandler`
callback → back to sign-in with chat/docs cleared), `logoutUser` revokes server-side. Entities come from
`user.memberships` (Header picker); no hard-coded entity ids. Typecheck: `npm ci && npx tsc --noEmit` in `apps/mobile`. Read [apps/mobile/AGENTS.md](apps/mobile/AGENTS.md) before touching Expo
APIs: always use `npx expo install` and check the versioned docs. It recommends Expo Router, but the app does not use it.

## 9. Tests and evals

- `apps/api/tests/`: 146 tests. Phase 1–7 security suites (tenant isolation, lifecycle, leaks, grounding and
  injection, upload and rate limit, frontend hardening via static checks, an E2E matrix), plus providers, db (PG tests skip
  without a database), OCR, dashboards, voice, token budget and evals-harness tests. Tests monkeypatch
  `settings.SQLITE_DB_PATH` to tmp paths. `tests/conftest.py` provides `cloud_mode` / `local_mode` fixtures:
  tests run in local mode by default, and Pinecone-path tests opt in with `usefixtures("cloud_mode")`.
  The suite is offline by construction (I-25): conftest blanks cloud keys for every test, blocks non-loopback sockets (blocked hosts are listed in the summary) and sets `HF_HUB_OFFLINE=1`. `cloud_mode` tests must inject fakes.
- Run: `cd apps/api && python -m pytest -q`. Baseline result is recorded in AGENT_MEMORY.md.
- `apps/api/evals/`: `generate_corpus.py`, `generate_golden.py` → `golden.jsonl`, `run.py --suite fast|all
  [--real-llm] [--self-test]`, gated by `baseline.json` (canary/injection/ACL leak = 0, numeric ≥0.95,
  citation precision ≥0.90, recall@8 ≥0.85, abstention ≥0.90).
- CI (I-18): [.github/workflows/ci.yml](.github/workflows/ci.yml) runs the full offline pytest suite on Python 3.11,
  a Postgres 16 job (non-superuser role; migrations + RLS startup check + TEST_DATABASE_URL tests), web `tsc` + `next build`
  and mobile `tsc`. [.github/workflows/evals.yml](.github/workflows/evals.yml) keeps the eval gate; its nightly real-LLM run
  opts in to `PRIVACY_MODE=cloud`. CI uses Python 3.11 while local dev may be 3.14: 3.14 defers annotations, so an
  un-imported typing name only fails on 3.11 (`tests/test_ci_guards.py` catches it).

## 10. Conventions to follow

- Files ≤ 500–600 lines (base rules). Violators already exist: VoiceEngine.ts 1112, Dashboard3D.ts 951,
  generate_golden.py 1080, dashboards.py 690, documents.py 601.
- No mock data in production paths; fakes live only in `tests/` and `providers/*/fake.py`.
- Secrets only from env. Server-side validation of everything. Tenant filter **before** retrieval.
- Routers import `from app.db import sqlite` and call shim functions. Keep that indirection when adding DB ops
  (add to `base.py` ABC, `sqlite_repo.py`, `sqlalchemy_repo.py`, and `sqlite.py`).
- Audit IDs (S*, R*, F*, U*, D*, O*) in comments refer to the original audit (see docs/AUDIT_REMEDIATION_FEATURES.md).
- Commits use conventional style `type(scope): summary`. **Never `git push` without explicit permission.**
- Architectural explanations should include both a simple explanation and a technical one (base rules §5).
- Fix order is set by the master plan: auth → tenancy → RBAC → privacy → RAG correctness → upload/API →
  reliability → DB → tests → observability → deploy → frontend → code quality.

## 11. Doc vs code discrepancies (do not trust docs blindly)

| Claim (where) | Reality |
|---|---|
| Pinecone stores only anonymised vectors + IDs (.agents AU rules) | Resolved by I-09: local mode (default) uses no Pinecone. In opt-in cloud mode full chunk text + filename still go to Pinecone metadata (README discloses this) |
| "85/85 tests passing" (AUDIT doc) | 146 tests now; see the AGENT_MEMORY baseline |
| `packages/contracts`, `.env.example` (README) | `.env.example` added (I-17); `packages/contracts` still missing |
| Runbook: Ollama local LLM, `d:\VR-RAG` paths | Local mode now uses the `local` LLM provider (Ollama by default). `d:\VR-RAG` paths are still wrong |
| Health: "Pinecone Cloud Serverless (Zero Local Storage)" | Fixed (I-09): `/api/health` reports `privacy_mode` and `data_leaves_deployment` truthfully |
| Docker compose builds api/web | Fixed (I-17): Dockerfiles exist, secrets come from `.env`, the API uses a non-superuser role so RLS applies |
| Phase 1 docs say "client-supplied tenancy rejected" | Client supplies `family_entity_id`; the server validates membership (acceptable) |
| requirements.txt complete | Fixed (I-18): all module-level third-party imports are declared; `sentence-transformers` (optional `local_st` embedder) and `pgvector` stay undeclared on purpose |
