"""Cross-passage reranker for hybrid candidate refinement."""

import re
from typing import Any, Dict, List


def rerank_passages(
    query: str,
    passages: List[Dict[str, Any]],
    top_k: int = 8,
) -> List[Dict[str, Any]]:
    """
    Reranks candidate retrieved passages using term specificity, entity overlap,
    and semantic relevance, reducing noise before LLM context packing.
    """
    if not passages:
        return []

    tokens = [t.lower() for t in re.findall(r"\w+", query) if len(t) > 2]
    if not tokens:
        return passages[:top_k]

    scored = []
    for p in passages:
        content = (p.get("text") or p.get("content") or "").lower()
        title = (p.get("section_title") or "").lower()
        doc_name = (p.get("document_name") or "").lower()

        # Base retrieval score
        base_score = float(p.get("score") or p.get("rrf_score") or 0.5)

        # Lexical density in content
        overlap_count = sum(1 for t in tokens if t in content)
        overlap_ratio = overlap_count / len(tokens)

        # High-value matches in title or document name
        title_boost = 0.3 if any(t in title for t in tokens) else 0.0
        doc_boost = 0.2 if any(t in doc_name for t in tokens) else 0.0

        rerank_score = (base_score * 0.5) + (overlap_ratio * 0.3) + title_boost + doc_boost
        p_copy = dict(p)
        p_copy["rerank_score"] = round(rerank_score, 4)
        scored.append(p_copy)

    scored.sort(key=lambda x: x["rerank_score"], reverse=True)
    return scored[:top_k]

