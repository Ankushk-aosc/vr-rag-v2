import logging
import threading
import uuid
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.db import sqlite
from app.routers import auth, dashboards, documents, providers, query, voice
from app.providers import factory
from app.services import datasets, embeddings
from app.services import voice as voice_service
from app.services.lexical_index import lexical_index

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("main")


def _warm_search_and_datasets() -> None:
    lexical_index.build_from_pinecone()
    # parse the indexed tables once so the first "create dashboard" is instant
    datasets.get_datasets("default_family", ["family_admin", "family_member"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize SQLite System of Record (users, memberships, documents, chunks)
    sqlite.init_db()

    # Phase 4a Multi-Provider & Embedder Consistency Guard
    embedder = factory.get_embedder(settings)
    vector_store = factory.get_vector_store(settings)
    app.state.embedder = embedder
    app.state.vector_store = vector_store

    index_meta = await vector_store.get_index_meta()
    embedder_model = getattr(embedder, "model", getattr(embedder, "model_name", None))
    embedder_dim = getattr(embedder, "dim", None)
    stored_model = index_meta.get("embedder_model")
    stored_dim = index_meta.get("embedder_dim")
    count = int(index_meta.get("count") or 0)

    if index_meta.get("untagged"):
        logger.warning("Vector index is untagged (legacy Pinecone). Proceeding.")
    elif (
        (stored_dim is not None and embedder_dim is not None and stored_dim != embedder_dim)
        or (stored_model and embedder_model and stored_model != embedder_model)
    ):
        if count > 0:
            logger.error(
                "Embedder mismatch: index has %s vectors with model=%s dim=%s, configured is model=%s dim=%s",
                count, stored_model, stored_dim, embedder_model, embedder_dim
            )
            raise RuntimeError(
                f"Configured embedder (model={embedder_model}, dim={embedder_dim}) does not match "
                f"vector store index (model={stored_model}, dim={stored_dim}, count={count})."
            )
        else:
            logger.warning(
                "Empty vector index has mismatch (index=%s/%s, configured=%s/%s). Proceeding.",
                stored_model, stored_dim, embedder_model, embedder_dim
            )

    # Load models off the request path (in parallel) so the first question / voice turn is fast
    for name, job in (
        ("warm-embeddings", embeddings.warm_up),
        ("warm-keyword-index", _warm_search_and_datasets),
        ("warm-stt", voice_service.warm_up_stt),
    ):
        threading.Thread(target=job, name=name, daemon=True).start()
    yield


app = FastAPI(
    title="Aether Sovereign Financial RAG API (Australia)",
    description=(
        "Privacy-preserving, voice-first financial RAG assistant for Australian family offices. "
        "Cloud-native architecture powered by Pinecone serverless vector & metadata storage and Groq cloud inference."
    ),
    version="2.0.0",
    lifespan=lifespan
)

# CORS configuration for web, LAN, and WebXR/Expo mobile clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:8081",
        "http://127.0.0.1:8081",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global structured error handler with correlation ID (Audit S14)
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    correlation_id = str(uuid.uuid4())
    logger.error(
        "Unhandled server error [%s] on %s %s: %s",
        correlation_id, request.method, request.url.path, exc, exc_info=True
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "detail": "An internal server error occurred. Please contact system administrator.",
            "correlation_id": correlation_id
        }
    )


# Include routers
app.include_router(auth.router)
app.include_router(documents.router)
app.include_router(query.router)
app.include_router(voice.router)
app.include_router(dashboards.router)
app.include_router(providers.router)


@app.get("/api/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "environment": settings.ENVIRONMENT,
        "jurisdiction": "Australia (Cth)",
        "currency": settings.DEFAULT_CURRENCY,
        "storage_provider": "Pinecone Cloud Serverless (Zero Local Storage)",
        "pinecone_index": settings.PINECONE_INDEX_NAME,
        "pinecone_configured": bool(settings.PINECONE_API_KEY and settings.PINECONE_API_KEY != "your-pinecone-api-key-here"),
        "llm_provider": "Groq Cloud API (Zero Fallback)",
        "groq_model": settings.GROQ_MODEL,
        "embedding_backend": embeddings.embedding_backend(),
        "keyword_index": {
            "ready": lexical_index.ready,
            "chunks": len(lexical_index.chunks),
            "building": lexical_index.building,
            "error": lexical_index.error,
        },
        "speech_to_text": voice_service.stt_status(),
        "tts_voice": settings.TTS_VOICE,
    }
