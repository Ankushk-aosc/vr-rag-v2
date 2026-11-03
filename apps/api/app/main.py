import logging
import threading
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.db import sqlite
from app.routers import auth, dashboards, documents, providers, query, voice
from app.providers import factory
from app.services import auth as auth_service, datasets, embeddings
from app.services import voice as voice_service
from app.services.lexical_index import lexical_index

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("main")


def _warm_search_and_datasets() -> None:
    lexical_index.build_from_pinecone()
    # parse the indexed tables once so the first "create dashboard" is instant
    datasets.get_datasets("default_family", ["family_admin", "family_member"])


def _report_unindexed_chunks() -> None:
    """Documents ingested in cloud mode have no local vectors until the backfill script is run."""
    try:
        families = {d["family_entity_id"] for d in sqlite.get_all_documents()}
        missing = sum(len(sqlite.get_chunks_without_vectors(f)) for f in families)
        if missing:
            logger.warning(
                "%d chunks have no local vector and are only keyword-searchable. "
                "Run `python -m app.scripts.build_local_vectors` to embed them locally.", missing,
            )
    except Exception as e:
        logger.debug("Local vector coverage check skipped: %s", e)


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

    if settings.is_local_mode:
        logger.info(
            "PRIVACY_MODE=local: Pinecone, Groq, edge-tts, Textract and S3 settings are ignored; "
            "LLM at %s (%s).", settings.LOCAL_LLM_BASE_URL, settings.LOCAL_LLM_MODEL,
        )
        threading.Thread(target=_report_unindexed_chunks, name="local-index-check", daemon=True).start()

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
        "Voice-first financial RAG assistant for Australian family offices. With PRIVACY_MODE=local (default) "
        "documents, vectors, prompts and audio stay within this deployment; PRIVACY_MODE=cloud opts in to "
        "Pinecone vector storage and Groq inference (see README privacy section)."
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


def _privacy_summary() -> dict:
    """What actually leaves the deployment, reported truthfully (Audit I-09)."""
    if settings.is_local_mode:
        return {
            "privacy_mode": "local",
            "data_leaves_deployment": False,
            "storage_provider": "Local database (vectors, chunks, metadata) + local disk (originals)",
            "llm_provider": f"Local OpenAI-compatible server ({settings.LOCAL_LLM_MODEL})",
            "speech_providers": "On-device Whisper STT and on-device TTS",
        }
    return {
        "privacy_mode": "cloud",
        "data_leaves_deployment": True,
        "storage_provider": f"Pinecone ({settings.PINECONE_CLOUD} {settings.PINECONE_REGION}): vectors, chunk text, filenames",
        "pinecone_index": settings.PINECONE_INDEX_NAME,
        "pinecone_configured": bool(settings.PINECONE_API_KEY and settings.PINECONE_API_KEY != "your-pinecone-api-key-here"),
        "llm_provider": f"{settings.LLM_PROVIDER} ({settings.GROQ_MODEL if settings.LLM_PROVIDER == 'groq' else settings.LLM_MODEL})",
        "speech_providers": "Groq Whisper STT and Microsoft edge-tts when configured, local fallbacks otherwise",
    }


@app.get("/api/health", tags=["Health"])
async def health_check():
    """
    Public liveness probe (Audit I-23): nothing about the environment, models, indexes or errors.
    The privacy mode is public on purpose: clients read it before sign-in to decide whether browser
    speech services may be used (I-26), and it is the deployment's privacy statement.
    """
    privacy = _privacy_summary()
    return {
        "status": "healthy",
        "privacy_mode": privacy["privacy_mode"],
        "data_leaves_deployment": privacy["data_leaves_deployment"],
    }


def _keyword_index_state() -> str:
    if lexical_index.error:
        return "failed"  # details in the server log
    if lexical_index.building:
        return "building"
    return "ready" if lexical_index.ready else "not ready"


@app.get("/api/health/details", tags=["Health"])
async def health_details(current_user: Dict[str, Any] = Depends(auth_service.get_current_user)):
    """Operational detail for family administrators only (Audit I-23). Never includes raw error text."""
    if not any(m.get("role") == "family_admin" for m in current_user.get("memberships") or []):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Only family_admin can view service details.",
        )
    return {
        "status": "healthy",
        "environment": settings.ENVIRONMENT,
        "jurisdiction": "Australia (Cth)",
        "currency": settings.DEFAULT_CURRENCY,
        **_privacy_summary(),
        "embedding_backend": embeddings.embedding_backend(),
        "keyword_index": {"state": _keyword_index_state(), "chunks": len(lexical_index.chunks)},
        "speech_to_text": voice_service.stt_status(),
        "tts_voice": settings.TTS_VOICE,
    }
