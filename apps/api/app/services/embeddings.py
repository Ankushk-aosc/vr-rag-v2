import hashlib
import logging
import os
import threading
import numpy as np
from typing import List
from app.config import settings

logger = logging.getLogger(__name__)

# The Pinecone index was built with sentence-transformers/all-MiniLM-L6-v2 (via fastembed ONNX).
# Queries MUST be embedded with the same model, otherwise similarity search returns noise.
FASTEMBED_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

_model = None
_model_failed = False
_model_lock = threading.Lock()

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def _deterministic_vector(text: str, dim: int = 384) -> List[float]:
    """
    Last-resort, deterministic 384-dim vector (sha256 seeded). Only used when the real
    embedding model cannot be loaded; semantic retrieval quality is degraded in that case.
    """
    cleaned = text.strip().lower()
    seed_hash = hashlib.sha256(cleaned.encode("utf-8")).digest()
    rng = np.random.default_rng(seed=int.from_bytes(seed_hash[:8], byteorder="big"))
    base_vec = rng.standard_normal(dim).astype(np.float32)
    for i, ch in enumerate(cleaned[:128]):
        base_vec[i % dim] += (ord(ch) % 31) * 0.1
    norm = np.linalg.norm(base_vec)
    if norm > 0:
        base_vec = base_vec / norm
    return base_vec.tolist()


def get_embedding_model():
    """Load the fastembed MiniLM model once (thread-safe). Returns None if unavailable."""
    global _model, _model_failed
    if os.environ.get("DISABLE_EMBEDDING_MODEL") == "true" or _model_failed:
        return None
    if _model is not None:
        return _model
    with _model_lock:
        if _model is None and not _model_failed:
            try:
                from fastembed import TextEmbedding
                _model = TextEmbedding(model_name=FASTEMBED_MODEL_NAME)
                logger.info("Loaded embedding model %s", FASTEMBED_MODEL_NAME)
            except Exception as e:
                logger.error(
                    "Embedding model %s unavailable (%s). Falling back to hash vectors; "
                    "retrieval accuracy will be severely degraded.", FASTEMBED_MODEL_NAME, e
                )
                _model_failed = True
                _model = None
    return _model


def embedding_backend() -> str:
    if _model is not None:
        return f"fastembed:{FASTEMBED_MODEL_NAME}"
    if _model_failed:
        return "hash-fallback (degraded)"
    return "not-loaded"


def warm_up() -> None:
    model = get_embedding_model()
    if model:
        try:
            list(model.embed(["warm up"]))
        except Exception as e:
            logger.warning("Embedding warm-up failed: %s", e)


def _to_floats(vec) -> List[float]:
    return [float(x) for x in vec]


def embed_texts(texts: List[str], allow_fallback: bool = False) -> List[List[float]]:
    if not texts:
        return []
    model = get_embedding_model()
    if model:
        try:
            return [_to_floats(e) for e in model.embed(texts)]
        except Exception as e:
            logger.error("Embedding batch failed: %s", e)
            if not allow_fallback:
                raise RuntimeError(f"Embedding generation failed: {e}")
    if not allow_fallback:
        raise RuntimeError(
            "Embedding model is unavailable. Ingestion cannot proceed with ungrounded fallback vectors."
        )
    return [_deterministic_vector(t, settings.EMBEDDING_DIMENSION) for t in texts]


def embed_query(query: str, allow_fallback: bool = False) -> List[float]:
    model = get_embedding_model()
    if model:
        try:
            return _to_floats(next(iter(model.embed([query]))))
        except Exception as e:
            logger.error("Query embedding failed: %s", e)
            if not allow_fallback:
                raise RuntimeError(f"Query embedding generation failed: {e}")
    if not allow_fallback:
        raise RuntimeError(
            "Embedding model is unavailable. Semantic search aborted to prevent noisy retrieval."
        )
    return _deterministic_vector(query, settings.EMBEDDING_DIMENSION)
