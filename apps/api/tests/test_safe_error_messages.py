"""
I-11 regression: internal exception text (paths, SQL, provider bodies, keys) is logged under a
reference id and never returned to clients, on the JSON and SSE query endpoints, the LLM error path,
the search stage detail, and single and batch uploads. User-facing rejections still come through.
"""
import io
import json
import logging
import re

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import session as db_session
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.providers.llm.fake import FakeLLM
from app.services import extractor, rag_engine
from app.services.safe_errors import log_with_reference, safe_message

LEAK = "sqlite3.OperationalError: no such table at C:\\secret\\app.db key=sk-live-123"
REF = re.compile(r"\(reference [0-9a-f]{12}\)")


@pytest.fixture
def client(tmp_path, monkeypatch, local_mode):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "safe_errors.db"))
    monkeypatch.setattr(settings, "LLM_PROVIDER", "fake")
    monkeypatch.setattr(db_session, "_engine", None)
    monkeypatch.setattr(db_session, "_sessionmaker", None)
    sqlite.init_db()
    limiter.reset()
    c = TestClient(app, raise_server_exceptions=False)
    body = c.post("/api/auth/register", json={
        "email": "admin@errors.com", "password": "StrongPassword123!", "full_name": "Err Admin",
        "family_entity_name": "Error Trust",
    }).json()
    c.headers.update({"Authorization": f"Bearer {body['access_token']}"})
    c.entity_id = body["user"]["memberships"][0]["family_entity_id"]
    return c


def test_reference_is_logged_with_the_real_error(caplog):
    with caplog.at_level(logging.ERROR, logger="app.errors"):
        ref = log_with_reference("Query failed", RuntimeError(LEAK))
    assert re.fullmatch(r"[0-9a-f]{12}", ref)
    assert any(ref in r.getMessage() and LEAK in r.getMessage() for r in caplog.records)
    assert safe_message("Failed.", ref) == f"Failed. (reference {ref})"


def test_json_query_hides_internal_error(client, monkeypatch):
    async def boom(**kwargs):
        raise RuntimeError(LEAK)

    monkeypatch.setattr(rag_engine, "execute_rag_query", boom)
    res = client.post("/api/query", json={"question": "Balance?", "family_entity_id": client.entity_id})
    assert res.status_code == 500
    assert LEAK not in res.text and "sk-live" not in res.text
    assert REF.search(res.json()["detail"])


def test_stream_query_hides_internal_error(client, monkeypatch):
    async def boom(**kwargs):
        raise RuntimeError(LEAK)
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(rag_engine, "stream_rag_events", boom)
    res = client.post("/api/query/stream", json={"question": "Balance?", "family_entity_id": client.entity_id})
    events = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]
    assert events[-1]["type"] == "error"
    assert LEAK not in res.text
    assert REF.search(events[-1]["message"])


def test_llm_provider_error_body_is_not_shown(monkeypatch):
    assert LEAK not in rag_engine._friendly_llm_error(RuntimeError(LEAK))
    assert REF.search(rag_engine._friendly_llm_error(RuntimeError(LEAK)))
    # actionable, non-sensitive cases keep their specific message
    assert "rate limit" in rag_engine._friendly_llm_error(RuntimeError("429 rate_limit_exceeded"))


@pytest.mark.asyncio
async def test_search_stage_detail_has_no_exception_text(monkeypatch):
    async def broken_semantic(*a, **k):
        raise RuntimeError(LEAK)

    monkeypatch.setattr(rag_engine, "_semantic_search", broken_semantic)
    monkeypatch.setattr(rag_engine.lexical_index, "search", lambda *a, **k: [])
    monkeypatch.setattr(rag_engine, "get_llm", lambda: FakeLLM(script=["No matching records."]))
    monkeypatch.setattr(rag_engine.UsageRecorder, "record", lambda *a, **k: None)
    events = [e async for e in rag_engine.stream_rag_events("Balance?", "fam", ["family_admin"], user_id="u")]
    assert LEAK not in json.dumps(events)
    assert any("semantic search unavailable" in (e.get("detail") or "") for e in events)


def _upload(client, name="notes.txt", content=b"Franking credits received.", path="/api/documents/upload"):
    if path.endswith("batch"):
        return client.post(path, files=[("files", (name, io.BytesIO(content), "text/plain"))],
                           data={"family_entity_id": client.entity_id})
    return client.post(path, files={"file": (name, io.BytesIO(content), "text/plain")},
                       data={"family_entity_id": client.entity_id})


def test_upload_extraction_error_is_generic(client, monkeypatch):
    def broken(*a, **k):
        raise ValueError(LEAK)  # a parsing library's ValueError, not a deliberate rejection

    monkeypatch.setattr(extractor, "extract_document", broken)
    res = _upload(client)
    assert res.status_code == 422
    assert LEAK not in res.text and REF.search(res.json()["detail"])


def test_deliberate_rejection_still_reaches_the_user(client, monkeypatch):
    def reject(*a, **k):
        raise extractor.ExtractionRejected("PDF exceeds maximum page limit of 500 pages (contains 900 pages).")

    monkeypatch.setattr(extractor, "extract_document", reject)
    res = _upload(client)
    assert res.status_code == 400
    assert "maximum page limit" in res.json()["detail"]


def test_batch_upload_hides_unexpected_errors(client, monkeypatch):
    def broken(*a, **k):
        raise KeyError(LEAK)

    monkeypatch.setattr(extractor, "extract_document", broken)
    res = _upload(client, path="/api/documents/upload-batch")
    assert res.status_code == 201
    errors = res.json()["errors"]
    assert errors and LEAK not in json.dumps(errors)
    assert REF.search(errors[0])
