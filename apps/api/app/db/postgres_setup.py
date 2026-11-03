"""
PostgreSQL schema setup and row-level-security verification (Audit I-16).

`init_db` used to call `Base.metadata.create_all`, which creates tables with **no** RLS policies. In
Postgres mode the schema now comes only from the Alembic migrations, and startup fails closed unless
every tenant table has RLS enabled and forced and the app's database role cannot bypass it.
"""
import logging
from pathlib import Path
from typing import Iterable, List

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from app.config import is_dev_environment, settings

logger = logging.getLogger(__name__)

API_ROOT = Path(__file__).resolve().parents[2]
TENANT_TABLES = (
    "documents", "document_acl", "document_chunks", "audit_events", "llm_usage", "chunk_vectors", "document_meta",
)

LEGACY_SCHEMA_MESSAGE = (
    "This PostgreSQL database has the app's tables but no Alembic history, so it was created with "
    "create_all and has no row-level security. Refusing to start (Audit I-16). Back up the data, then "
    "either restore it into a fresh database created by `alembic upgrade head` (run in apps/api), or, if "
    "the schema matches revision 002, run `alembic stamp 002_llm_usage_and_rls` followed by "
    "`alembic upgrade head`, which (re)creates the policies."
)


def schema_state(table_names: Iterable[str]) -> str:
    """'managed' (Alembic history), 'empty' (fresh database) or 'legacy' (create_all, no history)."""
    names = set(table_names)
    if "alembic_version" in names:
        return "managed"
    return "legacy" if names & set(TENANT_TABLES) else "empty"


def missing_rls(rows: Iterable[tuple]) -> List[str]:
    """rows: (table, relrowsecurity, relforcerowsecurity). Returns tenant tables not fully protected."""
    protected = {name for name, enabled, forced in rows if enabled and forced}
    return [t for t in TENANT_TABLES if t not in protected]


def check_role(is_superuser: bool, bypasses_rls: bool, environment: str) -> None:
    """Superusers and BYPASSRLS roles ignore every policy, even FORCE ROW LEVEL SECURITY."""
    if not (is_superuser or bypasses_rls):
        return
    message = (
        "The database role used by the API is a superuser or has BYPASSRLS, so PostgreSQL ignores the "
        "tenant-isolation policies. Connect with a dedicated non-superuser role (Audit I-16)."
    )
    if is_dev_environment(environment):
        logger.critical("%s Allowed only because ENVIRONMENT=%s.", message, environment)
        return
    raise RuntimeError(message)


def _alembic_config():
    from alembic.config import Config

    # No ini file: alembic's fileConfig() would otherwise replace the app's logging configuration
    cfg = Config()
    # version_locations is left at its default (<script_location>/versions): alembic splits that option
    # on spaces, which breaks paths such as "C:\Users\Guest User\..." and silently finds no migrations
    cfg.set_main_option("script_location", str(API_ROOT / "alembic"))
    return cfg


def upgrade_to_head() -> None:
    from alembic import command

    command.upgrade(_alembic_config(), "head")


def verify_rls(engine: Engine) -> None:
    with engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE relname = ANY(:tables) AND relkind = 'r' AND pg_table_is_visible(oid)"
        ), {"tables": list(TENANT_TABLES)}).all()
        role = conn.execute(text(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        )).one()
    missing = missing_rls(rows)
    if missing:
        raise RuntimeError(
            f"Row-level security is not enabled and forced on: {', '.join(missing)}. "
            "Run `alembic upgrade head` in apps/api (Audit I-16)."
        )
    check_role(bool(role[0]), bool(role[1]), settings.ENVIRONMENT)


def prepare_database(engine: Engine) -> None:
    """Brings a PostgreSQL database to the latest migration and proves RLS is in force."""
    state = schema_state(inspect(engine).get_table_names())
    if state == "legacy":
        raise RuntimeError(LEGACY_SCHEMA_MESSAGE)
    upgrade_to_head()
    verify_rls(engine)
    logger.info("PostgreSQL schema at head; RLS enforced on %d tenant tables.", len(TENANT_TABLES))
