"""
In-memory BM25 keyword index over every chunk stored in Pinecone metadata.

Dense MiniLM embeddings are poor at exact tokens (dates, tickers, row numbers, amounts),
which dominate tabular financial records. This index supplies the lexical half of a hybrid
retriever; results are fused with Pinecone similarity results in rag_engine.

The corpus is pulled from Pinecone once in a background thread and cached to
data/lexical_index.json, keyed by the vector count so a restart does not refetch it.
"""
import json
import logging
import math
import re
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)

CACHE_PATH = Path(settings.SQLITE_DB_PATH).parent / "lexical_index.json"

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from",
    "had", "has", "have", "how", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or",
    "our", "show", "tell", "that", "the", "their", "there", "this", "to", "was", "were", "what",
    "when", "where", "which", "who", "why", "will", "with", "you", "your", "about", "please",
    "give", "find", "much", "many", "between", "across", "all", "any",
}

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9,
    "sept": 9, "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}
_MONTH_RE = "|".join(sorted(MONTHS, key=len, reverse=True))

TOKEN_RE = re.compile(r"\d{4}-\d{2}-\d{2}|[a-z0-9]+(?:[.,][0-9]+)*", re.IGNORECASE)
ISO_DATE_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")


def _iso(y: int, m: int, d: int) -> Optional[str]:
    if 1 <= m <= 12 and 1 <= d <= 31 and 1900 <= y <= 2100:
        return f"{y:04d}-{m:02d}-{d:02d}"
    return None


def extract_dates(text: str) -> List[str]:
    """Normalise the date expressions people type or say into ISO yyyy-mm-dd tokens."""
    found: List[str] = []
    t = text.lower()
    for y, m, d in re.findall(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b", t):
        found.append(_iso(int(y), int(m), int(d)))
    # dd/mm/yyyy (Australian day-first convention)
    for d, m, y in re.findall(r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b", t):
        found.append(_iso(int(y), int(m), int(d)))
    # 1 April 2020 / 1st of April, 2020
    for d, mon, y in re.findall(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({_MONTH_RE})\.?,?\s+(\d{{4}})\b", t):
        found.append(_iso(int(y), MONTHS[mon], int(d)))
    # April 1, 2020 / April 1st 2020
    for mon, d, y in re.findall(rf"\b({_MONTH_RE})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})\b", t):
        found.append(_iso(int(y), MONTHS[mon], int(d)))
    out: List[str] = []
    for f in found:
        if f and f not in out:
            out.append(f)
    return out


def tokenize(text: str) -> List[str]:
    tokens = []
    for tok in TOKEN_RE.findall(text.lower()):
        if not ISO_DATE_RE.fullmatch(tok):
            tok = tok.replace(",", "")
        if len(tok) < 2 or tok in STOPWORDS:
            continue
        tokens.append(tok)
    return tokens


class LexicalIndex:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.chunks: List[Dict[str, Any]] = []
        self.postings: Dict[str, List[tuple]] = defaultdict(list)
        self.doc_len: List[int] = []
        self.avg_len = 1.0
        self.ready = False
        self.building = False
        self.error: Optional[str] = None
        # bumped whenever the corpus changes, so derived caches (datasets) know to rebuild
        self.version = 0

    # ---------- construction ----------
    def _rebuild_postings(self) -> None:
        postings: Dict[str, List[tuple]] = defaultdict(list)
        doc_len: List[int] = []
        for i, c in enumerate(self.chunks):
            counts = Counter(tokenize(c.get("text", "")))
            doc_len.append(sum(counts.values()))
            for tok, tf in counts.items():
                postings[tok].append((i, tf))
        self.postings = postings
        self.doc_len = doc_len
        self.avg_len = (sum(doc_len) / len(doc_len)) if doc_len else 1.0

    def load_chunks(self, chunks: List[Dict[str, Any]]) -> None:
        with self._lock:
            self.chunks = chunks
            self._rebuild_postings()
            self.ready = True
            self.version += 1

    def add_chunks(self, chunks: List[Dict[str, Any]]) -> None:
        with self._lock:
            existing = {c["chunk_id"] for c in self.chunks}
            self.chunks.extend(c for c in chunks if c["chunk_id"] not in existing)
            self._rebuild_postings()
            self.ready = True
            self.version += 1
        self._save_cache(vector_count=None)

    def snapshot(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self.chunks)

    # ---------- search ----------
    def search(
        self,
        query: str,
        family_entity_id: str,
        user_roles: List[str],
        top_k: int = 20,
        required_tokens: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        if not self.ready:
            return []
        q_tokens = list(dict.fromkeys(tokenize(query) + (required_tokens or [])))
        if not q_tokens:
            return []
        n_docs = len(self.chunks)
        k1, b = 1.4, 0.75
        scores: Dict[int, float] = defaultdict(float)
        with self._lock:
            for tok in q_tokens:
                plist = self.postings.get(tok)
                if not plist:
                    continue
                idf = math.log(1 + (n_docs - len(plist) + 0.5) / (len(plist) + 0.5))
                # exact dates are by far the most discriminative signal in ledger data
                weight = 3.0 if ISO_DATE_RE.fullmatch(tok) else 1.0
                for i, tf in plist:
                    norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * self.doc_len[i] / self.avg_len))
                    scores[i] += weight * idf * norm
            role_set = set(user_roles)
            results = []
            for i, s in sorted(scores.items(), key=lambda kv: kv[1], reverse=True):
                c = self.chunks[i]
                if c.get("family_entity_id") != family_entity_id:
                    continue
                if role_set and not role_set.intersection(c.get("allowed_roles") or []):
                    continue
                if required_tokens and not all(t in c.get("text", "") for t in required_tokens):
                    continue
                results.append({**c, "lexical_score": s})
                if len(results) >= top_k:
                    break
        return results

    # ---------- persistence ----------
    def _save_cache(self, vector_count: Optional[int]) -> None:
        try:
            CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            with self._lock:
                payload = {"vector_count": vector_count, "saved_at": time.time(), "chunks": self.chunks}
            tmp = CACHE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(CACHE_PATH)
        except Exception as e:
            logger.warning("Could not persist lexical index cache: %s", e)

    def _load_cache(self) -> Optional[int]:
        if not CACHE_PATH.exists():
            return None
        try:
            payload = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            self.load_chunks(payload.get("chunks", []))
            logger.info("Lexical index loaded %d chunks from cache", len(self.chunks))
            return payload.get("vector_count")
        except Exception as e:
            logger.warning("Lexical index cache unreadable: %s", e)
            return None

    def build_from_pinecone(self) -> None:
        """Pull every default-namespace chunk from Pinecone. Safe to call from a thread."""
        from app.services import pinecone_service

        self.building = True
        try:
            cached_count = self._load_cache()
            index = pinecone_service.get_index()
            stats = index.describe_index_stats()
            ns = getattr(stats, "namespaces", None) or {}
            default_ns = ns.get("__default__") or ns.get("")
            live_count = getattr(default_ns, "vector_count", None) if default_ns else None
            if self.ready and cached_count is not None and cached_count == live_count:
                return

            ids: List[str] = []
            for page in index.list(limit=100):
                vectors = getattr(page, "vectors", None) or []
                ids.extend(getattr(v, "id", None) or v["id"] for v in vectors)

            chunks: List[Dict[str, Any]] = []
            for i in range(0, len(ids), 200):
                fetched = index.fetch(ids=ids[i:i + 200])
                for vid, vec in (getattr(fetched, "vectors", None) or {}).items():
                    meta = dict(getattr(vec, "metadata", None) or {})
                    text = meta.get("text") or ""
                    if not text.strip():
                        continue
                    chunks.append({
                        "chunk_id": vid,
                        "document_id": meta.get("document_id", ""),
                        "page_number": int(meta.get("page_number", 1) or 1),
                        "is_table": bool(meta.get("is_table", False)),
                        "family_entity_id": meta.get("family_entity_id", "default_family"),
                        "allowed_roles": list(meta.get("allowed_roles") or []),
                        "original_name": meta.get("original_name") or "",
                        "text": text,
                    })
            self.load_chunks(chunks)
            self._save_cache(vector_count=live_count)
            logger.info("Lexical index built with %d chunks from Pinecone", len(chunks))
        except Exception as e:
            self.error = str(e)
            logger.error("Lexical index build failed: %s", e)
        finally:
            self.building = False

    def start_background_build(self) -> None:
        if self.building:
            return
        threading.Thread(target=self.build_from_pinecone, name="lexical-index", daemon=True).start()


lexical_index = LexicalIndex()
