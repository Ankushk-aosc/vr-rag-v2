"""One-off SQLite to PostgreSQL Migration Script.

Transfers all tables from SQLite to PostgreSQL with --dry-run and row-count verification.

Usage:
    python -m app.db.migrate_sqlite_to_postgres --postgres-url postgresql://... [--dry-run]
"""

import argparse
import logging
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import (
    AuditEventModel,
    Base,
    DocumentAclModel,
    DocumentChunkModel,
    DocumentModel,
    FamilyEntityModel,
    MembershipModel,
    RevokedTokenModel,
    UserModel,
)

logger = logging.getLogger(__name__)

TABLE_ORDER = [
    ("users", UserModel),
    ("family_entities", FamilyEntityModel),
    ("memberships", MembershipModel),
    ("documents", DocumentModel),
    ("document_acl", DocumentAclModel),
    ("document_chunks", DocumentChunkModel),
    ("audit_events", AuditEventModel),
    ("revoked_tokens", RevokedTokenModel),
]

DT_COLS = {"created_at", "uploaded_at", "timestamp", "revoked_at", "expires_at"}


def _parse_dt(val: Any) -> Any:
    if val is None or isinstance(val, datetime):
        return val
    if isinstance(val, str):
        try:
            return datetime.fromisoformat(val.replace("Z", "+00:00"))
        except Exception:
            try:
                return datetime.strptime(val, "%Y-%m-%d %H:%M:%S")
            except Exception:
                return val
    return val


def count_sqlite_rows(sqlite_path: str, table_name: str) -> int:
    conn = sqlite3.connect(sqlite_path)
    cursor = conn.cursor()
    try:
        cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        return cursor.fetchone()[0]
    except sqlite3.OperationalError:
        return 0
    finally:
        conn.close()


def fetch_sqlite_rows(sqlite_path: str, table_name: str) -> List[Dict[str, Any]]:
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    try:
        cursor.execute(f"SELECT * FROM {table_name}")
        return [dict(r) for r in cursor.fetchall()]
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


def _system_context(session: Session) -> None:
    """FORCE RLS applies to every role; a cross-tenant copy must run as an explicit system transaction."""
    if session.get_bind().dialect.name == "postgresql":
        session.execute(text("SELECT set_config('app.rls_bypass', 'on', true)"))


def _reconcile_classification(engine) -> None:
    """Sources older than migration 008 have no classification column, so copied rows get the default.
    Admin-only ACLs must become "restricted", or members could read them (ABAC uses classification)."""
    with Session(engine) as session:
        _system_context(session)
        res = session.execute(text(
            "UPDATE documents SET classification = 'restricted' "
            "WHERE classification <> 'restricted' AND id IN "
            "(SELECT document_id FROM document_acl WHERE allowed_role = 'family_admin')"
        ))
        session.commit()
        logger.info("Classification reconciled from ACL for %d document(s).", res.rowcount or 0)


def migrate(
    sqlite_path: str,
    postgres_url: str,
    dry_run: bool = False,
) -> Dict[str, Tuple[int, int]]:
    """
    Migrates tables from SQLite to PostgreSQL.
    Returns dict of {table_name: (sqlite_count, postgres_count)}.
    """
    if not Path(sqlite_path).exists():
        raise FileNotFoundError(f"Source SQLite database not found at '{sqlite_path}'")

    engine = create_engine(postgres_url)

    # Ensure schema exists on target if not dry run
    if not dry_run:
        Base.metadata.create_all(bind=engine)

    report: Dict[str, Tuple[int, int]] = {}

    for table_name, model_class in TABLE_ORDER:
        sqlite_count = count_sqlite_rows(sqlite_path, table_name)
        rows = fetch_sqlite_rows(sqlite_path, table_name)

        if dry_run:
            logger.info(f"[DRY-RUN] Would migrate {len(rows)} rows for table '{table_name}'")
            report[table_name] = (sqlite_count, 0)
            continue

        # Perform actual migration
        with Session(engine) as session:
            _system_context(session)
            for row in rows:
                col_keys = {c.name for c in model_class.__table__.columns}
                filtered_row = {k: v for k, v in row.items() if k in col_keys}

                # Convert boolean
                if "is_table" in filtered_row:
                    filtered_row["is_table"] = bool(filtered_row["is_table"])

                # Convert datetimes
                for dt_col in DT_COLS:
                    if dt_col in filtered_row and filtered_row[dt_col] is not None:
                        filtered_row[dt_col] = _parse_dt(filtered_row[dt_col])

                obj = model_class(**filtered_row)
                session.merge(obj)
            session.commit()

        # Verify target count
        with Session(engine) as session:
            _system_context(session)
            pg_count = session.execute(select(text("count(*)")).select_from(model_class)).scalar() or 0

        report[table_name] = (sqlite_count, pg_count)
        if pg_count != sqlite_count:
            logger.warning(
                f"Count mismatch for '{table_name}': SQLite={sqlite_count}, Postgres={pg_count}"
            )
        else:
            logger.info(f"Verified '{table_name}': {pg_count} rows migrated successfully.")

    if not dry_run:
        _reconcile_classification(engine)
    return report


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    parser = argparse.ArgumentParser(description="Migrate VR-RAG SQLite database to PostgreSQL.")
    parser.add_argument("--sqlite-path", default=settings.SQLITE_DB_PATH, help="Path to source SQLite db")
    parser.add_argument("--postgres-url", default=settings.DATABASE_URL, help="Target PostgreSQL connection URL")
    parser.add_argument("--dry-run", action="store_true", help="Simulate migration without modifying PostgreSQL")
    args = parser.parse_args()

    if not args.postgres_url:
        print("Error: Target --postgres-url or DATABASE_URL env var required.")
        sys.exit(1)

    print(f"Starting migration from '{args.sqlite_path}' to PostgreSQL (dry_run={args.dry_run})...")
    try:
        report = migrate(args.sqlite_path, args.postgres_url, dry_run=args.dry_run)
        print("\nMigration Summary:")
        print("--------------------------------------------------")
        print(f"{'Table':<20} {'SQLite Count':<15} {'Postgres Count':<15}")
        print("--------------------------------------------------")
        all_matched = True
        for tbl, (sq_cnt, pg_cnt) in report.items():
            status_flag = "✓" if (sq_cnt == pg_cnt or args.dry_run) else "MISMATCH"
            print(f"{tbl:<20} {sq_cnt:<15} {pg_cnt:<15} {status_flag}")
            if not args.dry_run and sq_cnt != pg_cnt:
                all_matched = False
        print("--------------------------------------------------")
        if not args.dry_run and not all_matched:
            print("ERROR: Row count mismatch detected during verification!")
            sys.exit(2)
        print("Migration and row-count verification completed successfully!")
    except Exception as e:
        logger.error(f"Migration failed: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
