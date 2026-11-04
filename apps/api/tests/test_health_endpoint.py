"""
I-23 regression: the public /api/health is a bare liveness probe (plus the public privacy mode the
clients need before sign-in). Operational detail moved to /api/health/details for family_admin only,
and no status anywhere carries raw error text.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import voice
from app.services.lexical_index import lexical_index

SECRET_ERROR = "connection to https://api.groq.com failed: key gsk-live-abc at C:\\secrets\\app.db"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "health.db"))
    sqlite.init_db()
    limiter.reset()
    return TestClient(app)


def _register(client, **extra):
    res = client.post("/api/auth/register", json={
        "email": f"u_{uuid.uuid4().hex[:6]}@health.com", "password": "StrongPassword123!",
        "full_name": "Health User", **extra,
    })
    assert res.status_code == 201, res.text
    return res.json()


def test_public_health_is_minimal(client):
    body = client.get("/api/health").json()
    assert set(body) == {"status", "privacy_mode", "data_leaves_deployment", "allow_browser_speech"}
    assert body["status"] == "healthy"


@pytest.mark.parametrize("mode,leaves", [("local", False), ("cloud", True)])
def test_public_health_reports_privacy_mode(client, monkeypatch, mode, leaves):
    monkeypatch.setattr(settings, "PRIVACY_MODE", mode)
    body = client.get("/api/health").json()
    assert body["privacy_mode"] == mode and body["data_leaves_deployment"] is leaves
    for key in ("environment", "pinecone_index", "llm_provider", "speech_to_text", "keyword_index", "tts_voice"):
        assert key not in body


def test_details_require_authentication_and_admin(client):
    assert client.get("/api/health/details").status_code == 401
    admin = _register(client, family_entity_name="Health Trust")
    entity_id = admin["user"]["memberships"][0]["family_entity_id"]
    invite = client.post("/api/auth/invites", json={"family_entity_id": entity_id, "role": "family_member"},
                         headers={"Authorization": f"Bearer {admin['access_token']}"}).json()
    member = _register(client, invite_token=invite["invite_token"])
    member_res = client.get("/api/health/details", headers={"Authorization": f"Bearer {member['access_token']}"})
    assert member_res.status_code == 403
    admin_res = client.get("/api/health/details", headers={"Authorization": f"Bearer {admin['access_token']}"})
    assert admin_res.status_code == 200
    assert {"environment", "privacy_mode", "keyword_index", "speech_to_text"} <= set(admin_res.json())


def test_details_never_contain_raw_errors(client, monkeypatch):
    monkeypatch.setattr(lexical_index, "error", SECRET_ERROR)
    monkeypatch.setattr(voice, "_whisper_model", None)
    monkeypatch.setattr(voice, "_whisper_failed", SECRET_ERROR)
    monkeypatch.setattr(voice, "_groq_stt_last_error", SECRET_ERROR)
    admin = _register(client, family_entity_name="Health Trust")
    res = client.get("/api/health/details", headers={"Authorization": f"Bearer {admin['access_token']}"})
    assert SECRET_ERROR not in res.text and "gsk-live" not in res.text
    assert res.json()["keyword_index"]["state"] == "failed"
    assert res.json()["speech_to_text"]["local_whisper"] == "failed"
    voice_status = client.get("/api/voice/status", headers={"Authorization": f"Bearer {admin['access_token']}"})
    assert voice_status.status_code == 200 and SECRET_ERROR not in voice_status.text


def test_stt_status_states(monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_MODE", "cloud")
    monkeypatch.setattr(settings, "GROQ_API_KEY", "gsk-test")
    monkeypatch.setattr(voice, "_groq_stt_blocked_until", 0.0)
    monkeypatch.setattr(voice, "_groq_stt_last_error", None)
    assert voice.stt_status()["groq_whisper"] == "available"
    monkeypatch.setattr(voice, "_groq_stt_last_error", SECRET_ERROR)
    assert voice.stt_status()["groq_whisper"] == "unavailable"
    monkeypatch.setattr(settings, "GROQ_API_KEY", "")
    assert voice.stt_status()["groq_whisper"] == "not configured"
    monkeypatch.setattr(settings, "PRIVACY_MODE", "local")
    assert voice.stt_status()["groq_whisper"] == "disabled (local privacy mode)"
