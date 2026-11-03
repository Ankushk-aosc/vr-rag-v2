"""UsageRecorder service layer for LLM token usage and cost accounting.

Persists metrics to `llm_usage` table with strict tenant isolation.
Never stores prompt or completion text.
"""

import logging
import uuid
from datetime import datetime, time, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select

from app.db.models import LLMUsageModel
from app.db.session import get_db_session
from app.providers.costs import calculate_cost
from app.providers.llm.base import Usage

logger = logging.getLogger(__name__)


def _start_of_today_utc() -> datetime:
    """Returns datetime representing 00:00:00 UTC today."""
    now = datetime.now(timezone.utc)
    return datetime.combine(now.date(), time.min, tzinfo=timezone.utc)


class UsageRecorder:
    @staticmethod
    def record(
        provider: str,
        model: str,
        usage: Usage,
        route: str,
        family_entity_id: str,
        user_id: Optional[str] = None,
        run_id: Optional[str] = None,
    ) -> str:
        """Records an LLM execution to the database.

        Invariant: Never stores prompt or completion text.
        """
        usage_id = str(uuid.uuid4())
        prompt_tokens = usage.prompt_tokens or 0
        completion_tokens = usage.completion_tokens or 0
        total_tokens = usage.total_tokens or (prompt_tokens + completion_tokens)

        # Determine cost
        cost_usd = usage.cost_usd
        if cost_usd is None or cost_usd == Decimal("0"):
            cost_usd = calculate_cost(model, prompt_tokens, completion_tokens)

        with get_db_session(family_ids=[family_entity_id]) as session:
            record_obj = LLMUsageModel(
                id=usage_id,
                family_entity_id=family_entity_id,
                user_id=user_id,
                route=route,
                provider=provider,
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                cost_usd=cost_usd,
                run_id=run_id,
            )
            session.add(record_obj)

        logger.info(
            "Recorded LLM usage: id=%s route=%s provider=%s model=%s tokens=%d cost=%s",
            usage_id,
            route,
            provider,
            model,
            total_tokens,
            f"${cost_usd}" if cost_usd is not None else "NULL",
        )
        return usage_id

    @staticmethod
    def get_tenant_today_tokens(family_entity_id: str) -> int:
        """Sums today's total tokens for a specific family entity tenant."""
        today_start = _start_of_today_utc()
        with get_db_session(family_ids=[family_entity_id]) as session:
            stmt = select(func.coalesce(func.sum(LLMUsageModel.total_tokens), 0)).where(
                LLMUsageModel.family_entity_id == family_entity_id,
                LLMUsageModel.created_at >= today_start,
            )
            val = session.execute(stmt).scalar()
            return int(val or 0)

    @staticmethod
    def get_user_today_tokens(user_id: str) -> int:
        """Sums today's total tokens for a specific user across all tenants."""
        if not user_id:
            return 0
        today_start = _start_of_today_utc()
        # Spans tenants by design (per-user cap); without the system context RLS would return 0 (Audit I-16)
        with get_db_session(system=True) as session:
            stmt = select(func.coalesce(func.sum(LLMUsageModel.total_tokens), 0)).where(
                LLMUsageModel.user_id == user_id,
                LLMUsageModel.created_at >= today_start,
            )
            val = session.execute(stmt).scalar()
            return int(val or 0)

    @staticmethod
    def get_tenant_usage(
        family_entity_id: str,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Retrieves recent usage records for a tenant."""
        with get_db_session(family_ids=[family_entity_id]) as session:
            stmt = (
                select(LLMUsageModel)
                .where(LLMUsageModel.family_entity_id == family_entity_id)
                .order_by(LLMUsageModel.created_at.desc())
                .limit(limit)
            )
            rows = session.scalars(stmt).all()
            return [
                {
                    "id": r.id,
                    "family_entity_id": r.family_entity_id,
                    "user_id": r.user_id,
                    "route": r.route,
                    "provider": r.provider,
                    "model": r.model,
                    "prompt_tokens": r.prompt_tokens,
                    "completion_tokens": r.completion_tokens,
                    "total_tokens": r.total_tokens,
                    "cost_usd": float(r.cost_usd) if r.cost_usd is not None else None,
                    "run_id": r.run_id,
                    "created_at": r.created_at.isoformat() if isinstance(r.created_at, datetime) else str(r.created_at),
                }
                for r in rows
            ]

