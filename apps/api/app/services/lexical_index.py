"""
Tenant-Partitioned In-Memory BM25 Keyword Index.
Resolves Audit ID: R10.

Supplies the lexical half of hybrid retrieval partitioned strictly by family_entity_id.
Avoids multi-tenant plaintext pooling and preserves tenant data boundaries both in memory and on disk.
"""
import json
import logging
import math
import re
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from app.config import settings

logger = logging.getLogger(__name__)

LEXICAL_DIR = Path(settings.SQLITE_DB_PATH).parent / "lexical"

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


class TenantPartition:
    """Isolated BM25 index corpus for a single family entity."""

    def __init__(self, family_entity_id: str) -> None:
        self.family_entity_id = family_entity_id
        self.chunks: List[Dict[str, Any]] = []
        self.postings: Dict[str, List[tuple]] = defaultdict(list)
        self.doc_len: List[int] = []
        self.avg_len: float = 1.0

    def rebuild_postings(self) -> None:
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

    def search(
        self,
        q_tokens: List[str],
        user_roles: List[str],
        top_k: int = 20,
        required_tokens: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        if not self.chunks:
            return []
        n_docs = len(self.chunks)
        k1, b = 1.4, 0.75
        scores: Dict[int, float] = defaultdict(float)
        for tok in q_tokens:
            plist = self.postings.get(tok)
            if not plist:
                continue
            idf = math.log(1 + (n_docs - len(plist) + 0.5) / (len(plist) + 0.5))
            weight = 3.0 if ISO_DATE_RE.fullmatch(tok) else 1.0
            for i, tf in plist:
                norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * self.doc_len[i] / self.avg_len))
                scores[i] += weight * idf * norm

        role_set = set(user_roles)
        results = []
        for i, s in sorted(scores.items(), key=lambda kv: kv[1], reverse=True):
            c = self.chunks[i]
            if role_set and not role_set.intersection(c.get("allowed_roles") or []):
                continue
            if required_tokens and not all(t in c.get("text", "") for t in required_tokens):
                continue
            results.append({**c, "lexical_score": s})
            if len(results) >= top_k:
                break
        return results


class LexicalIndex:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._partitions: Dict[str, TenantPartition] = {}
        self.ready = False
        self.building = False
        self.error: Optional[str] = None
        self.version = 0

    @property
    def chunks(self) -> List[Dict[str, Any]]:
        """Compatibility property returning all partitioned chunks."""
        with self._lock:
            all_c = []
            for p in self._partitions.values():
                all_c.extend(p.chunks)
            return all_c

    def _save_tenant_cache(self, family_entity_id: str, vector_count: Optional[int] = None) -> None:
        try:
            LEXICAL_DIR.mkdir(parents=True, exist_ok=True)
            partition = self._partitions.get(family_entity_id)
            if not partition:
                return
            cache_file = LEXICAL_DIR / f"lexical_{family_entity_id}.json"
            payload = {
                "family_entity_id": family_entity_id,
                "vector_count": vector_count,
                "saved_at": time.time(),
                "chunks": partition.chunks
            }
            tmp = cache_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(cache_file)
        except Exception as e:
            logger.warning(f"Could not persist lexical cache for tenant {family_entity_id}: {e}")

    def load_chunks(self, chunks: List[Dict[str, Any]]) -> None:
        with self._lock:
            self._partitions.clear()
            for c in chunks:
                tenant_id = c.get("family_entity_id") or "default_family"
                partition = self._partitions.setdefault(tenant_id, TenantPartition(tenant_id))
                partition.chunks.append(c)
            for partition in self._partitions.values():
                partition.rebuild_postings()
            self.ready = True
            self.version += 1

    def add_chunks(self, chunks: List[Dict[str, Any]]) -> None:
        with self._lock:
            affected_tenants: Set[str] = set()
            for c in chunks:
                tenant_id = c.get("family_entity_id") or "default_family"
                partition = self._partitions.setdefault(tenant_id, TenantPartition(tenant_id))
                existing = {x["chunk_id"] for x in partition.chunks}
                if c["chunk_id"] not in existing:
                    partition.chunks.append(c)
                    affected_tenants.add(tenant_id)

            for tenant_id in affected_tenants:
                self._partitions[tenant_id].rebuild_postings()
                self._save_tenant_cache(tenant_id)

            self.ready = True
            self.version += 1

    def delete_document_chunks(self, document_id: str) -> None:
        with self._lock:
            affected_tenants: Set[str] = set()
            for tenant_id, partition in self._partitions.items():
                orig_len = len(partition.chunks)
                partition.chunks = [c for c in partition.chunks if c.get("document_id") != document_id]
                if len(partition.chunks) != orig_len:
                    partition.rebuild_postings()
                    affected_tenants.add(tenant_id)

            for tenant_id in affected_tenants:
                self._save_tenant_cache(tenant_id)

            self.version += 1

    def snapshot(self, family_entity_id: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._lock:
            if family_entity_id:
                partition = self._partitions.get(family_entity_id)
                return list(partition.chunks) if partition else []
            all_chunks = []
            for p in self._partitions.values():
                all_chunks.extend(p.chunks)
            return all_chunks

    def search_postgres(
        self,
        query: str,
        family_entity_id: str,
        user_roles: List[str],
        top_k: int = 20,
    ) -> List[Dict[str, Any]]:
        from app.db.session import get_db_session
        from sqlalchemy import text
        # Same ACL rule as the BM25 partitions (Audit I-07): admin-only documents need the admin role,
        # everything else needs admin or member. Fail closed for any other role set.
        roles = set(user_roles or [])
        if "family_admin" in roles:
            acl_clause = ""
        elif "family_member" in roles:
            acl_clause = "AND COALESCE(a.allowed_role, 'family_member') <> 'family_admin'"
        else:
            return []
        try:
            with get_db_session(family_ids=[family_entity_id]) as session:
                engine = session.get_bind()
                if not engine or engine.dialect.name != "postgresql":
                    return []
                stmt = text(f"""
                    SELECT c.id as chunk_id, c.document_id, c.page_number, c.is_table,
                           d.family_entity_id, d.original_name, c.content as text,
                           ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', :query)) as rank
                    FROM document_chunks c
                    JOIN documents d ON c.document_id = d.id
                    LEFT JOIN document_acl a ON a.document_id = d.id AND a.family_entity_id = d.family_entity_id
                    WHERE d.family_entity_id = :family_id
                      AND to_tsvector('english', c.content) @@ plainto_tsquery('english', :query)
                      {acl_clause}
                    ORDER BY rank DESC
                    LIMIT :top_k
                """)
                res = session.execute(stmt, {"query": query, "family_id": family_entity_id, "top_k": top_k}).all()
                results = []
                for r in res:
                    results.append({
                        "chunk_id": r.chunk_id,
                        "document_id": r.document_id,
                        "page_number": r.page_number,
                        "is_table": r.is_table,
                        "family_entity_id": r.family_entity_id,
                        "allowed_roles": user_roles,
                        "original_name": r.original_name,
                        "text": r.text,
                        "score": float(r.rank),
                    })
                return results
        except Exception as e:
            logger.warning("Postgres tsvector search error, falling back to BM25: %s", e)
            return []

    def search(
        self,
        query: str,
        family_entity_id: str,
        user_roles: List[str],
        top_k: int = 20,
        required_tokens: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        if getattr(settings, "USE_POSTGRES_LEXICAL", False):
            pg_res = self.search_postgres(query, family_entity_id, user_roles, top_k)
            if pg_res:
                return pg_res
        if not self.ready:
            return []
        q_tokens = list(dict.fromkeys(tokenize(query) + (required_tokens or [])))
        if not q_tokens:
            return []
        with self._lock:
            partition = self._partitions.get(family_entity_id)
            if not partition:
                return []
            return partition.search(q_tokens, user_roles, top_k, required_tokens)

    def _load_all_caches(self) -> int:
        if not LEXICAL_DIR.exists():
            return 0
        total_loaded = 0
        for cache_file in LEXICAL_DIR.glob("lexical_*.json"):
            try:
                data = json.loads(cache_file.read_text(encoding="utf-8"))
                tenant_id = data.get("family_entity_id") or cache_file.stem.replace("lexical_", "")
                chunks = data.get("chunks", [])
                partition = self._partitions.setdefault(tenant_id, TenantPartition(tenant_id))
                partition.chunks = chunks
                partition.rebuild_postings()
                total_loaded += len(chunks)
            except Exception as e:
                logger.warning(f"Failed to load lexical cache {cache_file}: {e}")
            return total_loaded

    def _load_from_sqlite(self) -> None:
        try:
            from app.db import sqlite
            with sqlite.get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT c.id, c.document_id, c.page_number, c.is_table, c.content, d.family_entity_id, d.original_name, a.allowed_role
                    FROM document_chunks c
                    JOIN documents d ON c.document_id = d.id
                    LEFT JOIN document_acl a ON c.document_id = a.document_id AND d.family_entity_id = a.family_entity_id
                """)
                rows = cursor.fetchall()
                chunks = []
                for r in rows:
                    role = r["allowed_role"] or "family_member"
                    allowed = ["family_admin"] if role == "family_admin" else ["family_admin", "family_member"]
                    chunks.append({
                        "chunk_id": r["id"],
                        "document_id": r["document_id"],
                        "page_number": int(r["page_number"] or 1),
                        "is_table": bool(r["is_table"]),
                        "family_entity_id": r["family_entity_id"],
                        "allowed_roles": allowed,
                        "original_name": r["original_name"] or "",
                        "text": r["content"] or "",
                    })
                if chunks:
                    self.load_chunks(chunks)
                    for tenant_id in self._partitions:
                        self._save_tenant_cache(tenant_id)
                    logger.info("Partitioned lexical index built from SQLite with %d chunks across %d tenants", len(chunks), len(self._partitions))
                self.ready = True
        except Exception as e:
            logger.warning("Could not build lexical index from SQLite: %s", e)
            self.ready = True

    def build_from_pinecone(self) -> None:
        """Pull every default-namespace chunk from Pinecone into tenant partitions."""
        from app.services import pinecone_service

        self.building = True
        try:
            cached_chunks = self._load_all_caches()
            if cached_chunks > 0:
                self.ready = True
                logger.info("Loaded %d partitioned lexical chunks from disk caches.", cached_chunks)

            # If Pinecone is not configured, load from SQLite system of record directly
            if not pinecone_service.get_pinecone_client():
                self._load_from_sqlite()
                return

            try:
                index = pinecone_service.get_index()
            except Exception as e:
                logger.info("Pinecone index unavailable (%s); falling back to SQLite for lexical index.", e)
                self._load_from_sqlite()
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
            if chunks:
                self.load_chunks(chunks)
                for tenant_id in self._partitions:
                    self._save_tenant_cache(tenant_id)
                logger.info("Partitioned lexical index built with %d chunks across %d tenants", len(chunks), len(self._partitions))
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
