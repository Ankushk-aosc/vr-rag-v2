# Multi-Provider Registry & Interfaces (Phase 4a)

Aether Sovereign / VR-RAG multi-provider abstraction layer for LLMs, embedders, vector databases, and speech engines.

---

## 1. How to Add a Provider in 4 Steps

Adding a new provider (e.g., an LLM, Embedder, Vector Store, STT, or TTS) requires four clean steps:

1. **Implement Interface**: Subclass the category's base class in its subpackage:
   - LLM: `app.providers.llm.base.LLMProvider`
   - Embedder: `app.providers.embed.base.Embedder`
   - Vector Store: `app.providers.vector.base.VectorStore`
   - Speech: `app.providers.speech.base.STT` or `app.providers.speech.base.TTS`
2. **Register**: Decorate your factory function with `@register_<category>("name")` in the category's `registry.py`.
3. **Configure Settings**: Add any provider-specific parameters to `app.config.Settings` (e.g. `MY_PROVIDER_API_KEY`).
4. **Select via Environment**: Set `LLM_PROVIDER=my_provider` (or `EMBEDDER_PROVIDER`, `VECTOR_STORE`, etc.) in `.env`.

---

## 2. Configuration Environment Variables

Configured via environment variables or AWS Secrets Manager:

| Variable | Category | Description | Example |
| :--- | :--- | :--- | :--- |
| `LLM_PROVIDER` | LLM | Active LLM adapter (`fake`, `openai_compatible`, `groq`) | `groq` |
| `LLM_MODEL` | LLM | Model identifier for completion requests | `qwen/qwen3.8-27b` |
| `LLM_BASE_URL` | LLM | HTTP endpoint for OpenAI-compatible wire APIs | `https://api.groq.com/openai/v1` |
| `LLM_API_KEY` | LLM | Secret credential (injected from Secrets Manager) | `gsk_...` |
| `EMBEDDER_PROVIDER` | Embed | Active embedder adapter (`fake`, `local_st`, `openai_compatible`) | `local_st` |
| `EMBEDDER_MODEL` | Embed | Embedding model identifier | `all-MiniLM-L6-v2` |
| `EMBEDDER_DIM` | Embed | Coordinate dimension | `384` |
| `VECTOR_STORE` | Vector | Active vector store (`memory`, `pinecone`) | `memory` |
| `STT_PROVIDER` | STT | Speech-to-text adapter (`fake`, `browser`) | `fake` |
| `TTS_PROVIDER` | TTS | Text-to-speech adapter (`fake`, `browser`) | `fake` |
| `PROVIDERS_STRICT` | Core | Fail fast at startup if required credentials are empty | `false` |

---

## 3. Provider Wire Coverage: OpenAI-Compatible vs. Native SDK

The included `OpenAICompatibleLLM` adapter unlocks ~30 providers conforming to the OpenAI `/v1/chat/completions` specification via configuration presets without custom code:
- **Cloud Providers**: OpenAI, Azure OpenAI (with query params), Groq, OpenRouter, Together AI, Fireworks AI, Perplexity, DeepSeek, Mistral, xAI, Z.AI, Novita, Moonshot, SambaNova, Cerebras, NVIDIA NIM.
- **Self-Hosted & Local**: Ollama (`/v1`), vLLM, LM Studio, LocalAI, KoboldCPP, Text Generation Web UI, oMLX, Lemonade, Microsoft Foundry Local.

**Native SDK Required**:
- Anthropic Claude (Bedrock / Anthropic wire format requires native message block schema)
- Google Vertex AI / Gemini Live API (bidi WebSockets / Google GenAI SDK)
- AWS Bedrock Converse API

---

## 4. The Unconfigured-Store Contract (Commit `034baf4`)

To guarantee strict multi-tenant isolation, test reliability, and prevent test suite crashes when cloud keys are unset:
- `query()` **MUST return `[]`** (never raise) when `is_configured()` is False or the store is empty.
- `delete_by_document()` / `delete_by_family()` **MUST return False** (never raise) when unconfigured, and True on success or no-op.
- `upsert()` raises `ProviderNotConfigured` only if an unconfigured store is actively called to write.
- **Zero Network Calls**: No network sockets may be opened when `is_configured()` is False.

This contract preserves the fix landed in commit `034baf4`, allowing offline suites to execute without live Pinecone or AWS accounts.

---

## 5. Embedder Consistency Guard & The Re-Embed CLI

Vector representations are mathematically tied to the specific model and dimension they were generated with. Mixing embedding models in the same namespace poisons similarity rankings.

- **Startup Guard**: On application lifespan boot, `vector_store.get_index_meta()` is compared against the active `Embedder`. If dimension or model differ and vectors exist (`count > 0`), the application logs an error and refuses to start.
- **Manual Re-Embed CLI**:
  ```bash
  python -m app.providers.reembed --confirm
  ```
  Re-embedding is deliberately manual and never automatic, preventing accidental re-encoding of production vector namespaces during routine deployments.

---

## 6. The Phase 4a vs. Phase 4b Architecture Split

- **Phase 4a (Implemented)**: Provider interfaces, registries, fake adapters, `OpenAICompatibleLLM`, `PineconeVectorStore` wrapper, embedder guard, `/api/providers` metadata endpoint, and offline test suite. Operates seamlessly on the SQLite system of record without schema changes.
- **Phase 4b (Pending Phase 1)**: `llm_usage` tracking table with PostgreSQL Row-Level Security (RLS), tenant-level daily token budgets, per-model USD cost tables, and evals integration. **Blocked on PostgreSQL + RLS (Phase 1.4) and must not be implemented on SQLite.**
