"""
Client-safe error reporting (Audit I-11).

Exception text can contain file paths, SQL, provider responses or keys, so it is logged server-side
under a short reference id and never returned to clients. The id lets a user report the problem and an
operator find the full traceback in the logs. Mirrors the correlation_id of the global 500 handler.
"""
import logging
import uuid

logger = logging.getLogger("app.errors")


def log_with_reference(context: str, exc: BaseException) -> str:
    """Logs exc with its traceback and returns the reference id to show the client."""
    ref = uuid.uuid4().hex[:12]
    logger.error("%s [ref %s]: %s", context, ref, exc, exc_info=(type(exc), exc, exc.__traceback__))
    return ref


def safe_message(summary: str, ref: str) -> str:
    return f"{summary} (reference {ref})"
