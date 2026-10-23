from typing import List
from app.config import settings

_model = None


def get_embedding_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(settings.EMBEDDING_MODEL)
    return _model


def embed_texts(texts: List[str]) -> List[List[float]]:
    if not texts:
        return []
    model = get_embedding_model()
    embeddings = model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)
    return embeddings.tolist()


def embed_query(query: str) -> List[float]:
    model = get_embedding_model()
    embedding = model.encode([query], convert_to_numpy=True, normalize_embeddings=True)
    return embedding[0].tolist()
