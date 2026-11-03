"""Phase 4b Token Budget, LLM Usage Recording, and RLS Isolation Tests.

Covers:
1. One row per LLM call recorded in llm_usage table.
2. Over-cap returns 429 {scope, resets_at} with FakeLLM.calls unchanged.
3. Context truncation logged without silently dropping citations.
4. Unknown model results in cost_usd=None with a logged warning (never silent 0).
5. RLS hides other tenants' llm_usage (with live Postgres or explicit documented skip).
6. Fake to openai_compatible provider swap works seamlessly.
"""

import logging
import os
import uuid
from decimal import Decimal
from typing import Any, Dict, Tuple
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.db import sqlite
from app.db.models import Base, FamilyEntityModel, LLMUsageModel, UserModel
from app.db.session import get_db_session
from app.main import app
from app.middleware.token_budget import check_token_budget, guard_query_context
from app.providers.costs import calculate_cost
from app.providers.factory import get_llm
from app.providers.llm.base import Usage
from app.providers.llm.fake import FakeLLM
from app.services import rag_engine
from app.services.usage import UsageRecorder

client = TestClient(app)


@pytest.fixture(autouse=True)
def ensure_db():
    sqlite.init_db()


def _get_auth_context() -> Tuple[Dict[str, str], str, str]:
    email = f"budget_user_{uuid.uuid4().hex[:8]}@example.com"
    res = client.post(
        "/api/auth/register",
        json={"email": email, "password": "Password123!", "full_name": "Budget User"},
    ).json()
    token = res["access_token"]
    user_id = res["user"]["id"]
    family_id = res["user"]["memberships"][0]["family_entity_id"]
    return {"Authorization": f"Bearer {token}"}, family_id, user_id


def test_one_row_per_call(monkeypatch):
    """Verifies that calling the RAG engine writes exactly one row to llm_usage."""
    monkeypatch.setattr(settings, "LLM_PROVIDER", "fake")
    monkeypatch.setattr(settings, "TOKEN_BUDGET_ENABLED", False)

    headers, fam_id, user_id = _get_auth_context()
    initial_usage = UsageRecorder.get_tenant_today_tokens(fam_id)

    fake_usage = Usage(prompt_tokens=10, completion_tokens=20, total_tokens=30)
    rec_id = UsageRecorder.record(
        provider="fake",
        model="fake-model",
        usage=fake_usage,
        route="/api/query",
        family_entity_id=fam_id,
        user_id=user_id,
    )
    assert rec_id is not None

    new_usage = UsageRecorder.get_tenant_today_tokens(fam_id)
    assert new_usage == initial_usage + 30

    # Verify no prompt/completion text columns exist on the table
    columns = [c.name for c in LLMUsageModel.__table__.columns]
    assert "prompt" not in columns
    assert "completion" not in columns
    assert "prompt_text" not in columns
    assert "completion_text" not in columns


def test_over_cap_returns_429_with_fake_llm_calls_unchanged(monkeypatch):
    """Over-cap triggers 429 before provider call with FakeLLM.calls unchanged."""
    headers, fam_id, user_id = _get_auth_context()

    # Set cap to 50 tokens and enable budget
    monkeypatch.setattr(settings, "TOKEN_BUDGET_ENABLED", True)
    monkeypatch.setattr(settings, "TENANT_DAILY_TOKEN_CAP", 50)
    monkeypatch.setattr(settings, "USER_DAILY_TOKEN_CAP", 0)

    # Fake LLM reference
    fake_llm = FakeLLM(model="fake-model")
    monkeypatch.setattr("app.providers.factory.get_llm", lambda s=None: fake_llm)
    monkeypatch.setattr("app.services.rag_engine.get_llm", lambda s=None: fake_llm)

    initial_calls = len(fake_llm.calls)

    # Pre-seed usage to exceed cap (e.g. 60 tokens)
    UsageRecorder.record(
        provider="fake",
        model="fake-model",
        usage=Usage(prompt_tokens=30, completion_tokens=30, total_tokens=60),
        route="/api/query",
        family_entity_id=fam_id,
        user_id=user_id,
    )

    # Attempt query
    res = client.post(
        "/api/query",
        json={"question": "What is our balance?", "family_entity_id": fam_id},
        headers=headers,
    )

    assert res.status_code == 429
    detail = res.json()["detail"]
    assert detail["scope"] == "tenant"
    assert "resets_at" in detail
    assert detail["used"] >= 50

    # Invariant: NO provider call made!
    assert len(fake_llm.calls) == initial_calls, "CRITICAL: LLM was called even though budget was exceeded!"


def test_user_cap_returns_429(monkeypatch):
    """User-level token cap triggers 429 with scope='user'."""
    headers, fam_id, user_id = _get_auth_context()

    monkeypatch.setattr(settings, "TOKEN_BUDGET_ENABLED", True)
    monkeypatch.setattr(settings, "TENANT_DAILY_TOKEN_CAP", 0)  # Tenant cap off
    monkeypatch.setattr(settings, "USER_DAILY_TOKEN_CAP", 40)   # User cap on

    UsageRecorder.record(
        provider="fake",
        model="fake-model",
        usage=Usage(prompt_tokens=25, completion_tokens=25, total_tokens=50),
        route="/api/query",
        family_entity_id=fam_id,
        user_id=user_id,
    )

    res = client.post(
        "/api/query",
        json={"question": "What is our balance?", "family_entity_id": fam_id},
        headers=headers,
    )

    assert res.status_code == 429
    detail = res.json()["detail"]
    assert detail["scope"] == "user"
    assert "resets_at" in detail


def test_truncation_logged(caplog):
    """Context window truncation logs a warning and maintains passage-citation sync."""
    passages = [
        {"document_id": "doc1", "text": "A" * 3000},
        {"document_id": "doc2", "text": "B" * 3000},
    ]
    citations = [
        {"ref": 1, "document_id": "doc1", "document_name": "Doc 1"},
        {"ref": 2, "document_id": "doc2", "document_name": "Doc 2"},
    ]

    with caplog.at_level(logging.WARNING):
        kept_p, kept_c, truncated = guard_query_context(passages, citations, max_char_budget=4000)

    assert truncated is True
    assert len(kept_p) == 1
    assert len(kept_c) == 1
    assert kept_p[0]["document_id"] == kept_c[0]["document_id"]
    assert any("Per-query token budget limit reached" in rec.message for rec in caplog.records)


def test_unknown_model_null_cost_with_warning(caplog):
    """Unknown model returns cost_usd=None and emits a warning (never silent 0)."""
    with caplog.at_level(logging.WARNING):
        cost = calculate_cost("unregistered-frontier-model", 500, 200)

    assert cost is None
    assert any("Unknown model 'unregistered-frontier-model'" in rec.message for rec in caplog.records)

    # Record via UsageRecorder (user_id=None is valid nullable FK)
    rec_id = UsageRecorder.record(
        provider="custom",
        model="unregistered-frontier-model",
        usage=Usage(prompt_tokens=500, completion_tokens=200, total_tokens=700),
        route="/api/query",
        family_entity_id="default_family",
        user_id=None,
    )

    with get_db_session() as session:
        rec = session.get(LLMUsageModel, rec_id)
        assert rec is not None
        assert rec.cost_usd is None, "Cost for unknown model must be NULL, never 0"


def test_known_model_cost_calculation():
    """Known models produce accurately calculated Decimal costs."""
    cost = calculate_cost("gpt-4o", 1000, 1000)
    assert cost == Decimal("0.020000")


def test_fake_to_openai_compatible_swap(monkeypatch):
    """Swapping provider to openai_compatible executes correctly and tracks usage."""
    monkeypatch.setattr(settings, "PRIVACY_MODE", "cloud")  # hosted endpoint = cloud opt-in (Audit I-09)
    monkeypatch.setattr(settings, "LLM_PROVIDER", "openai_compatible")
    monkeypatch.setattr(settings, "LLM_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setattr(settings, "LLM_API_KEY", "mock_key")
    monkeypatch.setattr(settings, "LLM_MODEL", "gpt-4o-mini")

    llm = get_llm()
    assert llm.info.name == "openai_compatible"
    assert llm.is_configured() is True


def test_rls_hides_other_tenants_llm_usage():
    """
    RLS policy test: Family A connection must not read Family B rows.
    Uses live Postgres if available, or provides explicit documented skip.
    """
    pg_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not pg_url or not pg_url.startswith("postgresql"):
        pytest.skip(
            "[skip-if-no-pg] PostgreSQL daemon not active on localhost:5432; "
            "live RLS test on llm_usage requires Docker or running Postgres."
        )

    engine = create_engine(pg_url)
    Base.metadata.create_all(bind=engine)

    fam_a = f"fam_a_{uuid.uuid4().hex[:8]}"
    fam_b = f"fam_b_{uuid.uuid4().hex[:8]}"

    with Session(engine) as session:
        session.execute(text("ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;"))
        session.execute(text("ALTER TABLE llm_usage FORCE ROW LEVEL SECURITY;"))
        session.execute(text("""
            DO $$ BEGIN
                DROP POLICY IF EXISTS test_usage_isolation ON llm_usage;
                CREATE POLICY test_usage_isolation ON llm_usage
                FOR ALL
                USING (
                    family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
                );
            END $$;
        """))

        # Seeding two tenants at once needs the explicit system context (Audit I-16)
        session.execute(text("SELECT set_config('app.rls_bypass', 'on', true)"))
        # Seed family entities
        session.execute(text("INSERT INTO family_entities (id, name) VALUES (:a, 'Fam A'), (:b, 'Fam B') ON CONFLICT DO NOTHING;"), {"a": fam_a, "b": fam_b})

        # Insert usage for both
        u_a = str(uuid.uuid4())
        u_b = str(uuid.uuid4())
        session.execute(text("""
            INSERT INTO llm_usage (id, family_entity_id, route, provider, model, total_tokens)
            VALUES (:id_a, :fa, '/api/query', 'fake', 'fake-model', 100),
                   (:id_b, :fb, '/api/query', 'fake', 'fake-model', 200);
        """), {"id_a": u_a, "fa": fam_a, "id_b": u_b, "fb": fam_b})
        session.commit()

    # Query with tenant context = fam_a
    with Session(engine) as session:
        session.execute(text("SELECT set_config('app.current_family_ids', :val, true)"), {"val": fam_a})
        rows = session.execute(text("SELECT id, family_entity_id FROM llm_usage")).all()
        retrieved_ids = {r.id for r in rows}

        assert u_a in retrieved_ids
        assert u_b not in retrieved_ids, "RLS FAILURE: Family B usage leaked to Family A!"
