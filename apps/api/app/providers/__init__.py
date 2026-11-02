"""
Multi-Provider Abstraction Layer (Phase 4a).
Provides interfaces, fakes, adapters, and registries for:
- LLM Providers (Fake, OpenAI-compatible, Groq)
- Embedder Providers (Fake, Local SentenceTransformers, OpenAI-compatible)
- Vector Stores (In-Memory, Pinecone wrapper)
- Speech STT / TTS (Fake, Browser, OpenAI)
"""
