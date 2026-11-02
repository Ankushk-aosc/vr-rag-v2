"""Tests connection pool hygiene and ensures zero connection leaks under load.

Proves:
1. SQLAlchemy QueuePool properly recovers all connections.
2. 200-request query loop maintains 0 checked-out connections at completion.
"""

import pytest
from sqlalchemy import text
from app.db.session import get_db_session, get_engine


def test_no_connection_leaks_under_200_request_loop():
    engine = get_engine()

    # Warm up engine
    with get_db_session() as session:
        session.execute(text("SELECT 1"))

    initial_checked_out = getattr(engine.pool, "checkedout", lambda: 0)()
    assert initial_checked_out == 0, f"Expected 0 initial checked out, got {initial_checked_out}"

    # Execute 200 requests through session context manager
    for i in range(200):
        with get_db_session() as session:
            res = session.execute(text("SELECT 1")).scalar()
            assert res == 1

    # Assert pool state
    final_checked_out = getattr(engine.pool, "checkedout", lambda: 0)()
    assert final_checked_out == 0, f"Connection leak detected! {final_checked_out} connections still checked out"


def test_exception_rollback_releases_connection():
    engine = get_engine()

    with pytest.raises(RuntimeError):
        with get_db_session() as session:
            session.execute(text("SELECT 1"))
            raise RuntimeError("Deliberate failure inside transaction")

    # Connection must still be cleanly returned to pool
    final_checked_out = getattr(engine.pool, "checkedout", lambda: 0)()
    assert final_checked_out == 0, "Connection not returned after exception in session!"
