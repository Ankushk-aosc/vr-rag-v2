"""
I-09 regression: PRIVACY_MODE=local (the default) keeps documents, vectors, prompts and audio inside
the deployment. Pinecone, Groq (LLM + Whisper), edge-tts, Textract and S3 are never used, and the full
upload -> list -> query -> delete flow works with outbound network access blocked.
"""
import io
import re
import socket
import uuid
import zlib

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, is_private_endpoint, settings
from app.db import session as db_session
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.providers import factory
from app.providers.llm.fake import FakeLLM
from app.scripts.build_local_vectors import build_local_vectors
from app.services import embeddings, local_vector_index, pinecone_service, rag_engine, voice
from app.services.ocr.router import get_ocr_engine
from app.services.ocr.tesseract_engine import TesseractEngine
from app.services.storage import StorageService, storage_service

DIM = settings.EMBEDDING_DIMENSION


def _bag_of_words(text):
    vec = np.zeros(DIM, dtype=np.float32)
    for tok in re.findall(r"[a-z0-9]+", text.lower()):
        vec[zlib.crc32(tok.encode()) % DIM] += 1.0
    return vec.tolist()


@pytest.fixture
def offline(tmp_path, monkeypatch, local_mode):
    """Local mode, temp DB, deterministic local embeddings and no outbound sockets."""
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "local_mode.db"))
    # The SQLAlchemy session factory (usage recorder) caches the engine of an earlier test's DB
    monkeypatch.setattr(db_session, "_engine", None)
    monkeypatch.setattr(db_session, "_sessionmaker", None)
    monkeypatch.setattr(settings, "PINECONE_API_KEY", "pc-should-never-be-used")
    monkeypatch.setattr(settings, "GROQ_API_KEY", "gsk-should-never-be-used")
    monkeypatch.setattr(settings, "LLM_PROVIDER", "fake")
    monkeypatch.setattr(pinecone_service, "_pinecone_client", None)
    monkeypatch.setattr(pinecone_service, "_index", None)
    monkeypatch.setattr(storage_service, "local_dir", tmp_path / "uploads")
    (tmp_path / "uploads").mkdir()
    monkeypatch.setattr(embeddings, "embed_texts", lambda texts, **_: [_bag_of_words(t) for t in texts])
    monkeypatch.setattr(embeddings, "embed_query", lambda q, **_: _bag_of_words(q))
    local_vector_index._cache.clear()

    real_connect = socket.socket.connect

    def guarded_connect(sock, address):
        host = address[0] if isinstance(address, tuple) else address
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise AssertionError(f"outbound network call to {address} in PRIVACY_MODE=local")
        return real_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    sqlite.init_db()
    limiter.reset()
    return TestClient(app)


# ----------------------------------------------------------------- configuration

@pytest.mark.parametrize("url,expected", [
    ("http://127.0.0.1:11434/v1", True), ("http://localhost:8080/v1", True), ("http://ollama:11434/v1", True),
    ("http://10.0.0.5/v1", True), ("http://192.168.1.20:1234/v1", True), ("http://llm.internal/v1", True),
    ("https://api.groq.com/openai/v1", False), ("https://api.openai.com/v1", False),
    ("http://localhost.evil.com/v1", False), ("http://8.8.8.8/v1", False), ("", False),
])
def test_private_endpoint_detection(url, expected):
    assert is_private_endpoint(url) is expected


def test_local_mode_rejects_public_llm_url():
    with pytest.raises(ValueError, match="LOCAL_LLM_BASE_URL"):
        Settings(PRIVACY_MODE="local", LOCAL_LLM_BASE_URL="https://api.groq.com/openai/v1")
    with pytest.raises(ValueError, match="PRIVACY_MODE"):
        Settings(PRIVACY_MODE="hybrid")
    assert Settings(PRIVACY_MODE="cloud", LOCAL_LLM_BASE_URL="https://api.groq.com/openai/v1").is_local_mode is False


def test_default_mode_is_local():
    assert Settings.model_fields["PRIVACY_MODE"].default == "local"
    assert Settings(PRIVACY_MODE=" LOCAL ").PRIVACY_MODE == "local"


def test_cloud_llm_provider_is_replaced_by_local_server():
    llm = factory.get_llm(Settings(PRIVACY_MODE="local", LLM_PROVIDER="groq", GROQ_API_KEY="gsk-x"))
    assert llm.info.name == "local"
    assert llm.base_url.startswith("http://127.0.0.1")
    public = Settings(PRIVACY_MODE="local", LLM_PROVIDER="openai_compatible",
                      LLM_BASE_URL="https://api.openai.com/v1", LLM_API_KEY="sk-x")
    assert factory.get_llm(public).info.name == "local"
    # Offline and private providers are kept
    assert isinstance(factory.get_llm(Settings(PRIVACY_MODE="local", LLM_PROVIDER="fake")), FakeLLM)
    private = Settings(PRIVACY_MODE="local", LLM_PROVIDER="openai_compatible",
                       LLM_BASE_URL="http://10.1.2.3:8000/v1", LLM_API_KEY="k")
    assert factory.get_llm(private).info.name == "openai_compatible"


def test_cloud_clients_and_services_are_never_used(offline, tmp_path):
    assert pinecone_service.get_pinecone_client() is None
    assert rag_engine.get_groq_client() is None
    assert voice.transcribe_with_groq(b"RIFF....", ".wav") is None
    assert voice.stt_status()["groq_whisper"] != "available"
    assert isinstance(get_ocr_engine("textract"), TesseractEngine)
    assert StorageService(bucket_name="family-office-bucket", local_dir=str(tmp_path / "s3"))._use_s3() is False


@pytest.mark.asyncio
async def test_tts_uses_only_the_on_device_engine(offline, monkeypatch):
    async def edge_called(*a, **k):
        raise AssertionError("edge-tts sends answer text to Microsoft")
    monkeypatch.setattr(voice, "synthesize_speech_edge", edge_called)
    monkeypatch.setattr(voice, "synthesize_speech_pyttsx3", lambda text: b"local-wav")
    assert await voice.synthesize_speech("Your franking credits were $4,210.") == b"local-wav"


# ----------------------------------------------------------------- end-to-end flow

def _admin(client):
    body = client.post("/api/auth/register", json={
        "email": f"admin_{uuid.uuid4().hex[:6]}@local.com", "password": "StrongPassword123!",
        "full_name": "Local Admin", "family_entity_name": "Local Trust",
    }).json()
    return {"Authorization": f"Bearer {body['access_token']}"}, body["user"]["memberships"][0]["family_entity_id"]


def _upload(client, headers, entity_id, name, text, acl="family_member"):
    res = client.post(
        "/api/documents/upload",
        files={"file": (name, io.BytesIO(text.encode()), "text/plain")},
        data={"family_entity_id": entity_id, "allowed_role": acl},
        headers=headers,
    )
    assert res.status_code == 201, res.text
    return res.json()["document"]["id"]


def test_upload_list_query_delete_stays_local(offline):
    client = offline
    headers, entity_id = _admin(client)
    doc_id = _upload(client, headers, entity_id, "dividends.txt",
                     "Franking credits of 4210 dollars were received from the share portfolio in March.")
    secret_id = _upload(client, headers, entity_id, "trust_deed.txt",
                        "The trust deed names the appointor and the franking credits policy.", acl="family_admin")

    # Vectors and display metadata are in the local database; chunk text is not duplicated there
    vectors = sqlite.get_chunk_vectors(entity_id)
    assert {v["document_id"] for v in vectors} == {doc_id, secret_id}
    assert all(set(v) == {"chunk_id", "document_id", "allowed_roles", "embedding"} for v in vectors)
    assert sqlite.get_document_meta(doc_id)["preview_text"].startswith("Franking credits")

    listing = client.get(f"/api/documents?family_entity_id={entity_id}", headers=headers).json()
    assert {d["id"] for d in listing} == {doc_id, secret_id}
    assert client.get(f"/api/documents/{doc_id}", headers=headers).status_code == 200

    # Retrieval: tenant + role filtered before scoring, text hydrated from SQL
    member_hits = local_vector_index.query_similar_chunks(
        _bag_of_words("franking credits received"), 5, entity_id, ["family_member"])
    assert [h["metadata"]["document_id"] for h in member_hits] == [doc_id]
    assert "4210" in member_hits[0]["text"]
    admin_hits = local_vector_index.query_similar_chunks(
        _bag_of_words("franking credits"), 5, entity_id, ["family_admin"])
    assert {h["metadata"]["document_id"] for h in admin_hits} == {doc_id, secret_id}
    assert local_vector_index.query_similar_chunks(_bag_of_words("franking"), 5, "other_family", ["family_admin"]) == []
    assert local_vector_index.query_similar_chunks(_bag_of_words("franking"), 5, entity_id, []) == []

    # Full question through the API with the offline LLM
    res = client.post("/api/query", json={"question": "What franking credits were received?",
                                          "family_entity_id": entity_id}, headers=headers)
    assert res.status_code == 200, res.text
    assert any(c["document_id"] == doc_id for c in res.json()["citations"])

    # Erasure removes vectors and metadata too
    assert client.delete(f"/api/documents/{doc_id}", headers=headers).status_code == 200
    assert doc_id not in {v["document_id"] for v in sqlite.get_chunk_vectors(entity_id)}
    assert sqlite.get_document_meta(doc_id) is None
    assert all(h["metadata"]["document_id"] != doc_id for h in local_vector_index.query_similar_chunks(
        _bag_of_words("franking credits received"), 5, entity_id, ["family_admin"]))


def test_health_reports_truthful_local_flow(offline):
    body = offline.get("/api/health").json()
    assert body["privacy_mode"] == "local"
    assert body["data_leaves_deployment"] is False
    assert "pinecone_index" not in body


# ----------------------------------------------------------------- backfill

def test_backfill_embeds_chunks_ingested_in_cloud_mode(offline):
    headers, entity_id = _admin(offline)
    for doc_id, acl in (("cloud_doc", "family_member"), ("cloud_secret", "family_admin")):
        sqlite.insert_document({
            "id": doc_id, "filename": f"{doc_id}.txt", "original_name": f"{doc_id}.txt", "mime_type": "text/plain",
            "file_size": 1, "file_hash": uuid.uuid4().hex, "total_pages": 1,
            "family_entity_id": entity_id, "status": "indexed",
        })
        sqlite.insert_document_acl(doc_id, entity_id, acl)
        sqlite.insert_chunks([{"id": f"{doc_id}_p1_c0", "document_id": doc_id, "chunk_index": 0,
                               "page_number": 1, "content": f"Quarterly distribution statement {doc_id}"}])

    assert build_local_vectors(dry_run=True)["chunks_missing"] == 2
    assert build_local_vectors()["vectors_written"] == 2
    assert build_local_vectors()["vectors_written"] == 0  # idempotent
    roles = {v["document_id"]: v["allowed_roles"] for v in sqlite.get_chunk_vectors(entity_id)}
    assert roles == {"cloud_doc": ["family_admin", "family_member"], "cloud_secret": ["family_admin"]}
