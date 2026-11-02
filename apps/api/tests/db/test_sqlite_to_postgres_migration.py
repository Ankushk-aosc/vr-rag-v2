"""Tests SQLite to PostgreSQL migration script with --dry-run and row-count verification."""

import os
import sqlite3
import tempfile
import uuid
from pathlib import Path

import pytest

from app.db.migrate_sqlite_to_postgres import fetch_sqlite_rows, migrate


@pytest.fixture
def sample_sqlite_db():
    temp_dir = tempfile.mkdtemp()
    db_path = Path(temp_dir) / "sample_source.db"
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # Create tables
    cursor.execute("""
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            hashed_password TEXT NOT NULL,
            full_name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    cursor.execute("""
        CREATE TABLE family_entities (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            entity_type TEXT NOT NULL DEFAULT 'Family Trust',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    cursor.execute("""
        CREATE TABLE memberships (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            family_entity_id TEXT NOT NULL,
            role TEXT NOT NULL
        );
    """)
    cursor.execute("""
        CREATE TABLE documents (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            original_name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_hash TEXT NOT NULL,
            total_pages INTEGER DEFAULT 1,
            family_entity_id TEXT NOT NULL,
            status TEXT DEFAULT 'indexed'
        );
    """)

    # Seed data
    u1 = str(uuid.uuid4())
    cursor.execute("INSERT INTO users VALUES (?, 'test@example.com', 'hash', 'Test User', CURRENT_TIMESTAMP)", (u1,))
    f1 = str(uuid.uuid4())
    cursor.execute("INSERT INTO family_entities VALUES (?, 'Test Family', 'Family Trust', CURRENT_TIMESTAMP)", (f1,))
    cursor.execute("INSERT INTO memberships VALUES (?, ?, ?, 'family_member')", (str(uuid.uuid4()), u1, f1))
    cursor.execute(
        "INSERT INTO documents VALUES (?, 'file.pdf', 'Original.pdf', 'application/pdf', 1024, 'hash123', 1, ?, 'indexed')",
        (str(uuid.uuid4()), f1),
    )
    conn.commit()
    conn.close()

    yield str(db_path)

    try:
        db_path.unlink()
    except Exception:
        pass


def test_migration_dry_run(sample_sqlite_db):
    target_temp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    target_url = f"sqlite:///{target_temp.name}"
    target_temp.close()

    try:
        report = migrate(sample_sqlite_db, target_url, dry_run=True)
        assert "users" in report
        assert report["users"][0] == 1  # 1 sqlite row
        assert report["users"][1] == 0  # 0 postgres row because dry_run
        assert report["family_entities"][0] == 1
        assert report["memberships"][0] == 1
        assert report["documents"][0] == 1
    finally:
        try:
            os.unlink(target_temp.name)
        except Exception:
            pass


def test_migration_execution_and_row_count_matching(sample_sqlite_db):
    target_temp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    target_url = f"sqlite:///{target_temp.name}"
    target_temp.close()

    try:
        report = migrate(sample_sqlite_db, target_url, dry_run=False)
        for tbl in ["users", "family_entities", "memberships", "documents"]:
            sq_count, tg_count = report[tbl]
            assert sq_count == 1
            assert tg_count == 1, f"Mismatch in table {tbl}: sqlite={sq_count}, target={tg_count}"
    finally:
        try:
            os.unlink(target_temp.name)
        except Exception:
            pass
