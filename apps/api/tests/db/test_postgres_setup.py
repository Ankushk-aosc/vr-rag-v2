"""
I-16 regression (runs without PostgreSQL): Postgres mode builds its schema from the Alembic migrations
(never create_all), refuses legacy create_all databases, refuses to start unless RLS is enabled and
forced on every tenant table and the role cannot bypass it, and id lookups use the explicit system
context that migration 005's policies allow.
"""
import importlib.util
import inspect
import logging
from pathlib import Path

import pytest

from app.db import postgres_setup, session as db_session
from app.db import sqlite as sqlite_shim
from app.db.models import Base
from app.db.repositories import sqlalchemy_local_index, sqlalchemy_repo
from app.db.postgres_setup import TENANT_TABLES, check_role, missing_rls, schema_state
from app.services import usage

ALEMBIC = Path(__file__).resolve().parents[2] / "alembic" / "versions"


def _migration(name):
    spec = importlib.util.spec_from_file_location(name, ALEMBIC / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_tenant_tables_cover_every_tenant_scoped_model():
    scoped = {t.name for t in Base.metadata.sorted_tables if "family_entity_id" in t.columns}
    # memberships are read before any tenant is known (that is how the tenant is resolved)
    assert scoped - {"memberships"} | {"document_chunks"} == set(TENANT_TABLES)


def test_migration_005_recreates_bypass_aware_policies_for_all_tenant_tables():
    m005 = _migration("005_rls_system_lookups")
    assert set(m005.TENANT_POLICIES) == set(TENANT_TABLES)
    for table, condition in m005.TENANT_POLICIES.items():
        sql = m005.policy_sql(table, condition)
        assert f"USING ({m005.BYPASS} OR ({condition}))" in sql
        assert f"WITH CHECK ({m005.BYPASS} OR ({condition}))" in sql
    assert m005.down_revision == "004_user_token_version"


@pytest.mark.parametrize("tables,state", [
    ([], "empty"),
    (["alembic_version", "documents", "users"], "managed"),
    (["users", "documents", "document_chunks"], "legacy"),
    (["unrelated"], "empty"),
])
def test_schema_state(tables, state):
    assert schema_state(tables) == state


def test_missing_rls_requires_enabled_and_forced():
    rows = [(t, True, True) for t in TENANT_TABLES if t != "llm_usage"] + [("llm_usage", True, False)]
    assert missing_rls(rows) == ["llm_usage"]
    assert missing_rls([(t, True, True) for t in TENANT_TABLES]) == []
    assert set(missing_rls([])) == set(TENANT_TABLES)


def test_role_that_bypasses_rls_is_refused_outside_dev(caplog):
    check_role(False, False, "production")
    for su, bypass in ((True, False), (False, True)):
        with pytest.raises(RuntimeError, match="BYPASSRLS"):
            check_role(su, bypass, "production")
    with caplog.at_level(logging.CRITICAL):
        check_role(True, False, "development")
    assert any("superuser" in r.getMessage() for r in caplog.records)


def test_init_db_uses_migrations_not_create_all(monkeypatch):
    calls = []
    monkeypatch.setattr(sqlite_shim, "is_postgres", lambda: True)
    monkeypatch.setattr(db_session, "get_engine", lambda: "engine")
    monkeypatch.setattr(postgres_setup, "prepare_database", lambda engine: calls.append(engine))
    monkeypatch.setattr(sqlite_shim, "seed_default_demo_admin", lambda: calls.append("seed"))
    monkeypatch.setattr(Base.metadata, "create_all", lambda *a, **k: pytest.fail("create_all has no RLS"))
    sqlite_shim.init_db()
    assert calls == ["engine", "seed"]


def test_prepare_database_refuses_legacy_schema(monkeypatch):
    class Insp:
        def get_table_names(self):
            return ["users", "documents", "document_acl"]

    monkeypatch.setattr(postgres_setup, "inspect", lambda engine: Insp())
    monkeypatch.setattr(postgres_setup, "upgrade_to_head", lambda: pytest.fail("must not migrate a legacy schema"))
    with pytest.raises(RuntimeError, match="no row-level security"):
        postgres_setup.prepare_database(object())


def test_prepare_database_migrates_then_verifies(monkeypatch):
    order = []

    class Insp:
        def get_table_names(self):
            return ["alembic_version", "documents"]

    monkeypatch.setattr(postgres_setup, "inspect", lambda engine: Insp())
    monkeypatch.setattr(postgres_setup, "upgrade_to_head", lambda: order.append("upgrade"))
    monkeypatch.setattr(postgres_setup, "verify_rls", lambda engine: order.append("verify"))
    postgres_setup.prepare_database(object())
    assert order == ["upgrade", "verify"]


@pytest.mark.parametrize("cls,method", [
    (sqlalchemy_repo.SqlAlchemyDocumentRepository, name) for name in (
        "update_document_status", "delete_document", "insert_chunks", "get_chunks_by_ids",
        "get_all_documents", "get_document_by_id",
    )
] + [
    (sqlalchemy_repo.SqlAlchemyAuditRepository, "get_audit_events_for_user"),
    (sqlalchemy_local_index.SqlAlchemyLocalIndexRepository, "get_document_meta"),
    (usage.UsageRecorder, "get_user_today_tokens"),
])
def test_id_lookups_use_the_system_context(cls, method):
    assert "get_db_session(system=True)" in inspect.getsource(getattr(cls, method))


def test_system_context_sets_the_postgres_flag():
    executed = []

    class FakeSession:
        info = {}

        def get_bind(self):
            return type("E", (), {"dialect": type("D", (), {"name": "postgresql"})()})()

        def execute(self, stmt, *a):
            executed.append(str(stmt))

    s = FakeSession()
    db_session.set_system_context(s)
    assert s.info["rls_bypass"] is True
    assert executed == ["SET LOCAL app.rls_bypass = 'on'"]
