import pytest
from app.db import sqlite
from app.services import auth
from app.routers.documents import validate_file_magic_bytes
from app.schemas.query import QueryResponse, StructuredAnswer, FinancialMetricItem, ThinkingStageItem


def test_fail_closed_unknown_user_rejected(tmp_path, monkeypatch):
    test_db = tmp_path / "test_sec.db"
    monkeypatch.setattr("app.config.settings.SQLITE_DB_PATH", str(test_db))
    sqlite.init_db()

    # Generate token for an unknown subject ID
    fake_token = auth.create_access_token({"sub": "unknown_intruder_999", "email": "intruder@evil.com"})

    from fastapi.security import HTTPAuthorizationCredentials
    from fastapi import HTTPException
    
    cred = HTTPAuthorizationCredentials(scheme="Bearer", credentials=fake_token)

    # Calling get_current_user_optional should reject unknown subject with 401
    with pytest.raises(HTTPException) as exc_info:
        import asyncio
        asyncio.run(auth.get_current_user_optional(cred))
    
    assert exc_info.value.status_code == 401
    assert "User account not found or deactivated" in exc_info.value.detail


def test_magic_bytes_security_validation():
    # Valid PDF magic bytes
    assert validate_file_magic_bytes(b"%PDF-1.7\r\n...", ".pdf") is True
    # Fake PDF (e.g. Windows executable renamed to .pdf)
    assert validate_file_magic_bytes(b"MZ\x90\x00\x03...", ".pdf") is False
    # Valid DOCX / XLSX magic bytes (ZIP header)
    assert validate_file_magic_bytes(b"PK\x03\x04\x14...", ".docx") is True
    assert validate_file_magic_bytes(b"PK\x03\x04\x14...", ".xlsx") is True
    # Executable disguised as plain text
    assert validate_file_magic_bytes(b"MZ\x90\x00...", ".txt") is False


def test_structured_query_response_schema():
    metric = FinancialMetricItem(
        label="Closing Price",
        value="$240.91",
        currency="USD",
        period="2020-04-01",
        change="+1.8%"
    )
    stage = ThinkingStageItem(
        title="Vector Search",
        duration_ms=120,
        status="done",
        details="Searched 4 chunks"
    )
    structured = StructuredAnswer(
        summary="Apple closed at $240.91.",
        key_findings=["Volume was 45.2M shares"],
        metrics=[metric],
        risk_factors=["Historical volatility"],
        disclaimer="General Information Only under ASIC RG 244."
    )
    res = QueryResponse(
        answer="Apple closed at $240.91.",
        structured_data=structured,
        thinking_trace=[stage],
        citations=[],
        grounded=True,
        currency="AUD",
        total_latency_ms=250
    )
    assert res.structured_data.summary == "Apple closed at $240.91."
    assert res.structured_data.metrics[0].value == "$240.91"
    assert res.thinking_trace[0].duration_ms == 120
    assert len(res.thinking_trace) == 1
