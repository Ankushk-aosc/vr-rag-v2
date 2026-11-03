import logging
from contextlib import contextmanager
from typing import Generator, List, Optional
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool, QueuePool, StaticPool
from app.config import settings

logger = logging.getLogger(__name__)

_engine: Optional[Engine] = None
_sessionmaker: Optional[sessionmaker] = None


def get_engine(database_url: Optional[str] = None) -> Engine:
    global _engine, _sessionmaker
    url = database_url or settings.DATABASE_URL
    if not url:
        url = f"sqlite:///{settings.SQLITE_DB_PATH}"

    if _engine is not None and str(_engine.url) == url:
        return _engine

    if url.startswith("sqlite"):
        is_memory = ":memory:" in url or "mode=memory" in url
        connect_args = {"check_same_thread": False}
        if is_memory:
            poolclass = StaticPool
        else:
            poolclass = QueuePool

        engine = create_engine(
            url,
            connect_args=connect_args,
            poolclass=poolclass,
            echo=False,
        )

        @event.listens_for(engine, "connect")
        def set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA foreign_keys=ON;")
            cursor.close()

    else:
        # PostgreSQL / Psycopg3 (Pgbouncer-ready connection pool)
        engine = create_engine(
            url,
            poolclass=QueuePool,
            pool_size=10,
            max_overflow=20,
            pool_recycle=1800,
            pool_pre_ping=True,
            echo=False,
        )

    _engine = engine
    _sessionmaker = sessionmaker(bind=_engine, expire_on_commit=False, autoflush=False)
    return _engine


def set_tenant_context(session: Session, family_ids: List[str]) -> None:
    """Sets PostgreSQL RLS session variable or stores context on SQLite session info."""
    clean_ids = [str(fid).strip() for fid in family_ids if fid]
    session.info["current_family_ids"] = clean_ids

    engine = session.get_bind()
    if engine and engine.dialect.name == "postgresql":
        joined = ",".join(clean_ids)
        # SET cannot take bind parameters in PostgreSQL; set_config(..., is_local => true) is the
        # parameter-safe equivalent of SET LOCAL (Audit I-16: the old form raised a syntax error)
        session.execute(
            text("SELECT set_config('app.current_family_ids', :val, true)"),
            {"val": joined}
        )


def set_system_context(session: Session) -> None:
    """
    Marks a transaction as a system lookup that RLS lets through (migration 005, Audit I-16).
    Only for queries by a globally unique id (document, chunk, user) whose result the caller then
    authorizes in application code, exactly as in SQLite mode. Everything else must use family_ids.
    """
    session.info["rls_bypass"] = True
    engine = session.get_bind()
    if engine and engine.dialect.name == "postgresql":
        session.execute(text("SET LOCAL app.rls_bypass = 'on'"))


@contextmanager
def get_db_session(family_ids: Optional[List[str]] = None, system: bool = False) -> Generator[Session, None, None]:
    """Guaranteed auto-closing database session to ensure zero connection leaks.

    family_ids scopes the transaction to those tenants under Postgres RLS. system=True is the explicit,
    narrow escape hatch for id lookups (see set_system_context); never combine it with user input
    that selects across tenants."""
    global _sessionmaker
    if _sessionmaker is None:
        get_engine()

    session: Session = _sessionmaker()
    try:
        if family_ids:
            set_tenant_context(session, family_ids)
        if system:
            set_system_context(session)
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
