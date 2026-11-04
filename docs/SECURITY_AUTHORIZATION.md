# Authorization before retrieval (RBAC + ABAC, PostgreSQL + pgvector)

The language model is never the security boundary. Every request that reads family data is
authorized, and its access scope computed, **before** any search runs; retrieval then only ever
touches documents inside that scope.

```
JWT ─► current user ─► resolve_subject (tenant from server-side memberships)
    ─► authorize(subject, action, resource)      RBAC AND ABAC, fail closed, 403 + ACCESS_DENIED audit
    ─► build_access_scope(subject)               authorized document ids, computed in SQL
    ─► pgvector / local / Pinecone search  ┐     the scope's tenant, role tags and document ids
    ─► BM25 / tsvector search              ┘     are part of each search itself
    ─► defence-in-depth scope check ─► LLM (authorized chunks only)
    ─► validate_citations(scope) ─► response
```

Code: `apps/api/app/services/authorization.py` (single source of truth). `security_context.py` is a
thin FastAPI adapter over it.

## Roles and permissions (RBAC)

| Permission        | family_admin | family_member | read_only_adviser |
|-------------------|:---:|:---:|:---:|
| document.read     | ✓ | ✓ | ✓ |
| document.upload   | ✓ | ✓ |   |
| document.delete   | ✓ |   |   |
| query.execute     | ✓ | ✓ | ✓ |
| audit.read        | ✓ |   |   |
| users.manage      | ✓ |   |   |
| invites.manage    | ✓ |   |   |

Unknown or missing roles have no permissions.

## Attribute policies (ABAC)

* **Tenant:** the resource's `family_entity_id` must equal the subject's. The subject's family comes
  from the user's memberships in the database. A client may name one of *its own* families (users can
  belong to several); naming any other family is a 403 that reveals nothing about it.
* **Classification** (`documents.classification`): `internal` / `confidential` / `restricted`.
  Admins may read and create all three; members and advisers `internal` and `confidential`.
  `restricted` is the same rule as the existing admin-only ACL, and the two are kept in sync.
  A record with no classification is treated as `restricted`.
* **Ownership** (`documents.owner_user_id`, set server-side on upload): enforced for any action in
  `OWNER_ONLY_ACTIONS`. No current endpoint needs it (delete is admin-only by RBAC), so the set is empty.

RBAC and ABAC must both allow. Anything undeterminable is denied.

## Where authorization happens

| Endpoint | Action | Scope enforced in |
|---|---|---|
| `POST /api/query`, `/api/query/stream` | query.execute | `routers/query.py` → `rag_orchestrator` (scope built before the stream opens) |
| `POST /api/voice/ask` | query.execute | `routers/voice.py` → `rag_engine.execute_rag_query(scope=…)` |
| `POST /api/dashboards` | query.execute | `routers/dashboards.py` → `datasets.get_datasets(…, allowed_document_ids)` |
| `GET /api/documents`, `/suggestions` | document.read | `_read_scope` → SQL `get_authorized_document_ids` |
| `GET /api/documents/{id}`, `/{id}/table` | document.read | `authorize_document` (table search limited to that one document) |
| `POST /api/documents/upload`, `/upload-batch` | document.upload | `_upload_subject`; family and owner set server-side |
| `DELETE /api/documents/{id}` | document.delete | `_authorized_document` |
| `GET /api/auth/audit?family_entity_id=` | audit.read | `routers/auth.py` |
| `POST /api/auth/invites` | invites.manage | `routers/auth.py` |

Retrieval backends accept `allowed_document_ids` and filter **before** scoring:
`local_vector_index` (pgvector SQL `WHERE family_entity_id = :fam AND document_id = ANY(:docs)`, or
the in-process matrix on SQLite), `pinecone_service` (`document_id $in` in the server-side filter),
`lexical_index` (BM25 postings skip ineligible chunks; tsvector SQL `AND d.id = ANY(:doc_ids)`).
An empty scope returns nothing without querying.

## Storage

PostgreSQL is the primary store whenever `DATABASE_URL` points at it (in either privacy mode).
Migration `008_doc_abac_pgvector` adds:

* `documents.owner_user_id`, `documents.classification` (+ check constraint, backfilled from the ACL)
* `chunk_vectors.embedding_vec vector(EMBEDDING_DIMENSION)` — 384 for `all-MiniLM-L6-v2`
* `idx_chunk_vectors_embedding_hnsw` (HNSW, `vector_cosine_ops`, matching the cosine scoring used by
  the index) and `idx_chunk_vectors_family_doc`

Row-level security (migrations 001–007) remains on every tenant table as a second layer.
Without `DATABASE_URL`, local mode keeps SQLite + in-process scoring and cloud mode keeps Pinecone;
both receive the same scope filters.

## Audit

`LOGIN_SUCCESS`, `LOGIN_FAILED`, `DOCUMENT_UPLOADED`, `DOCUMENT_READ`, `DOCUMENT_DELETED`, `QUERY`,
`ACCESS_DENIED` (action, resource type, decision, reason), `INVITE_CREATED`, `PASSWORD_RESET`.
Queries are logged as metadata only (question length, passage and document counts, latency,
grounded); question and answer text are not logged.

## Commands

```bash
# 1. Dependencies (apps/api)
pip install -r requirements.txt

# 2. PostgreSQL with pgvector (docker-compose uses pgvector/pgvector:pg16 and creates the extension)
docker compose up -d postgres
#    or, on an existing server, as a superuser:
psql -U postgres -d vrrag -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. Point the API at it and migrate (runs Alembic to head as the non-superuser app role)
export DATABASE_URL=postgresql+psycopg://vrrag_app:<password>@localhost:5432/vrrag
python -c "from app.db import sqlite; sqlite.init_db()"

# 4. Move existing data and build/validate the pgvector index
python -m app.db.migrate_sqlite_to_postgres --sqlite-path data/app.db --postgres-url "$DATABASE_URL"
python -m app.scripts.validate_pgvector_migration --samples 3      # exit 1 on any failure

# 5. Run
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000          # apps/api
npm --prefix apps/web run dev                                       # repo root

# 6. Tests
python -m pytest -q                                                 # apps/api, SQLite
TEST_DATABASE_URL="$DATABASE_URL" python -m pytest -q tests/db      # live PostgreSQL + pgvector
```
