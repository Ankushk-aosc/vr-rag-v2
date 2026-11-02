"""Token budget middleware and query guard.

Enforces:
1. Tenant-level daily token caps (429 when over cap).
2. User-level daily token caps (429 when over cap).
3. Per-query context window truncation with logged warnings without silently dropping citations.
"""

import logging
from datetime import datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status

from app.config import settings
from app.services.usage import UsageRecorder

logger = logging.getLogger(__name__)


def get_next_midnight_utc() -> str:
    """Returns the ISO 8601 string of the next midnight in UTC."""
    now = datetime.now(timezone.utc)
    tomorrow = now.date() + timedelta(days=1)
    reset_dt = datetime.combine(tomorrow, time.min, tzinfo=timezone.utc)
    return reset_dt.isoformat()


def check_token_budget(
    family_entity_id: str,
    user_id: Optional[str] = None,
) -> None:
    """Checks whether tenant or user has exceeded their daily token cap.

    MUST be called BEFORE invoking the LLM provider.
    Raises HTTPException(429) if over cap.
    """
    if not settings.TOKEN_BUDGET_ENABLED:
        return

    resets_at = get_next_midnight_utc()

    # 1. Tenant daily cap check
    if settings.TENANT_DAILY_TOKEN_CAP > 0:
        tenant_tokens = UsageRecorder.get_tenant_today_tokens(family_entity_id)
        if tenant_tokens >= settings.TENANT_DAILY_TOKEN_CAP:
            logger.warning(
                "Tenant token budget exceeded for '%s': used %d, cap %d",
                family_entity_id,
                tenant_tokens,
                settings.TENANT_DAILY_TOKEN_CAP,
            )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "error": "Daily tenant token budget exceeded",
                    "scope": "tenant",
                    "resets_at": resets_at,
                    "used": tenant_tokens,
                    "cap": settings.TENANT_DAILY_TOKEN_CAP,
                },
            )

    # 2. User daily cap check
    if user_id and settings.USER_DAILY_TOKEN_CAP > 0:
        user_tokens = UsageRecorder.get_user_today_tokens(user_id)
        if user_tokens >= settings.USER_DAILY_TOKEN_CAP:
            logger.warning(
                "User token budget exceeded for '%s': used %d, cap %d",
                user_id,
                user_tokens,
                settings.USER_DAILY_TOKEN_CAP,
            )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "error": "Daily user token budget exceeded",
                    "scope": "user",
                    "resets_at": resets_at,
                    "used": user_tokens,
                    "cap": settings.USER_DAILY_TOKEN_CAP,
                },
            )


def guard_query_context(
    passages: List[Dict[str, Any]],
    citations: List[Dict[str, Any]],
    max_char_budget: int = 5200,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], bool]:
    """Truncates context if passages exceed max budget, logging a warning.

    Maintains 1:1 synchronization between passages and citations so citations
    are never silently dropped. If no passages survive within budget, returns empty
    to trigger abstention.
    """
    total_chars = sum(len(p.get("text", "")) for p in passages)
    if total_chars <= max_char_budget:
        return passages, citations, False

    logger.warning(
        "Per-query token budget limit reached (chars=%d > max=%d). Truncating context.",
        total_chars,
        max_char_budget,
    )

    kept_passages: List[Dict[str, Any]] = []
    kept_citations: List[Dict[str, Any]] = []
    current_chars = 0

    for p, c in zip(passages, citations):
        p_len = len(p.get("text", ""))
        if current_chars + p_len <= max_char_budget or not kept_passages:
            kept_passages.append(p)
            kept_citations.append(c)
            current_chars += p_len
        else:
            break

    return kept_passages, kept_citations, True

