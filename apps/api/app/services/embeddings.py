from typing import List
from app.config import settings

_model = None


def get_embedding_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        # Use Qdrant/all-MiniLM-L6-v2 ONNX model (384-dim normalized vectors)
        _model = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2")
    return _model


def embed_texts(texts: List[str]) -> List[List[float]]:
    if not texts:
        return []
    model = get_embedding_model()
    embeddings = list(model.embed(texts))
    return [e.tolist() for e in embeddings]


def embed_query(query: str) -> List[float]:
    model = get_embedding_model()
    embeddings = list(model.embed([query]))
    return embeddings[0].tolist()
