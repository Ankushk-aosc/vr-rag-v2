import io
import zipfile
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.config import settings
from app.db import sqlite
from app.middleware.rate_limiter import limiter
from app.services.upload_security import (
    sanitize_filename,
    check_zip_decompression_bomb,
    validate_audio_upload,
)
from app.services.extractor import extract_document


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_phase5.db"
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(test_db))
    sqlite.init_db()
    limiter.reset()
    return test_db


@pytest.fixture
def client():
    return TestClient(app)


def test_s8_rate_limiting_enforcement(client):
    """S8: Excess requests beyond the window threshold trigger HTTP 429 with Retry-After."""
    # Auth login limit is 20 requests per minute
    # Send 20 requests
    for _ in range(20):
        res = client.post("/api/auth/login", json={
            "email": "test_rl@example.com",
            "password": "Password123!"
        })
        assert res.status_code == 401  # Bad credentials, but not rate limited yet

    # 21st request must trigger 429 Too Many Requests
    blocked_res = client.post("/api/auth/login", json={
        "email": "test_rl@example.com",
        "password": "Password123!"
    })
    assert blocked_res.status_code == 429
    assert "Rate limit exceeded" in blocked_res.json()["detail"]
    assert "Retry-After" in blocked_res.headers


def test_f5_filename_sanitization():
    """F5: Filenames must be stripped of path traversal and control characters, and truncated."""
    # Directory traversal attack
    traversal = "../../etc/passwd.pdf"
    clean = sanitize_filename(traversal)
    assert "/" not in clean
    assert ".." not in clean
    assert clean.endswith(".pdf")

    # Excessive length
    long_name = ("a" * 200) + ".xlsx"
    clean_long = sanitize_filename(long_name, max_length=120)
    assert len(clean_long) <= 120
    assert clean_long.endswith(".xlsx")

    # Special characters
    dirty = 'my portfolio & ledger (2026) <confidential>!.csv'
    clean_dirty = sanitize_filename(dirty)
    assert '<' not in clean_dirty
    assert '>' not in clean_dirty
    assert '!' not in clean_dirty
    assert clean_dirty.endswith(".csv")


def test_f4_reject_legacy_doc_and_xls(tmp_path):
    """F4: Legacy .doc and .xls binaries must be rejected explicitly."""
    doc_file = tmp_path / "legacy.doc"
    doc_file.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")  # OLE2 header

    with pytest.raises(ValueError) as exc:
        extract_document(doc_file)
    assert "Legacy binary format '.doc' is not supported" in str(exc.value)

    xls_file = tmp_path / "legacy.xls"
    xls_file.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")

    with pytest.raises(ValueError) as exc_xls:
        extract_document(xls_file)
    assert "Legacy binary format '.xls' is not supported" in str(exc_xls.value)


def test_f3_zip_decompression_bomb_detection(tmp_path):
    """F3: Abnormal compression ratios in OOXML files are detected and rejected."""
    bomb_path = tmp_path / "bomb.docx"
    # Create a zip with 15MB of zeros compressed to a few kilobytes
    with zipfile.ZipFile(bomb_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("word/document.xml", b"\x00" * (15 * 1024 * 1024))

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        check_zip_decompression_bomb(bomb_path)
    assert exc.value.status_code == 413
    assert "Abnormal compression ratio" in exc.value.detail or "uncompressed" in exc.value.detail


def test_s8_audio_upload_size_limit():
    """S8: Audio uploads exceeding 25MB are rejected with 413."""
    from fastapi import HTTPException
    small_audio = b"\x00" * 1024
    validate_audio_upload(small_audio, max_bytes=25 * 1024 * 1024)

    huge_audio = b"\x00" * (26 * 1024 * 1024)
    with pytest.raises(HTTPException) as exc:
        validate_audio_upload(huge_audio, max_bytes=25 * 1024 * 1024)
    assert exc.value.status_code == 413
    assert "Audio file exceeds maximum allowed size" in exc.value.detail


def test_s12_voice_client_log_auth_and_sanitization(client):
    """S12: Voice client log requires auth and strips newlines to prevent log forging."""
    # 1. Unauthenticated request rejected with 401
    res_unauth = client.post("/api/voice/client-log", json={
        "events": [{"event": "speech_start", "time": 123}]
    })
    assert res_unauth.status_code == 401

    # 2. Authenticated user can log events
    reg_res = client.post("/api/auth/register", json={
        "email": "voice_tester@office.com",
        "password": "Password123!",
        "full_name": "Voice Tester"
    })
    token = reg_res.json()["access_token"]

    # 3. Log forging attempt: event name contains newline \n
    res_auth = client.post(
        "/api/voice/client-log",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "events": [{"event": "speech_start\nINJECTED_LOG_LINE", "details": "normal"}]
        }
    )
    assert res_auth.status_code == 204


def test_s14_global_error_handler_correlation_id():
    """S14: Unhandled server errors return structured responses with correlation_id."""
    # Test client without auto-raising exceptions to inspect the HTTP 500 response
    unhandled_client = TestClient(app, raise_server_exceptions=False)

    # Create test route that raises an unexpected exception
    @app.get("/api/test-crash")
    def crash_route():
        raise RuntimeError("Internal database connection failed with secret credentials leaked!")

    res = unhandled_client.get("/api/test-crash")
    assert res.status_code == 500
    body = res.json()
    assert "correlation_id" in body
    assert "secret credentials" not in body["detail"]
    assert "An internal server error occurred" in body["detail"]
