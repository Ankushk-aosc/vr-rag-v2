"""Versioned LLM Cost Table and Calculator.

Calculates cost_usd based on token counts and model pricing:
- Returns Decimal(cost_usd) rounded to 6 decimal places for known models.
- Returns None and logs a WARNING for unknown models (never silent 0).
"""

import logging
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# Versioned cost table: model -> (in_per_1k_usd, out_per_1k_usd)
COST_TABLE: Dict[str, Tuple[Decimal, Decimal]] = {
    # OpenAI
    "gpt-4o": (Decimal("0.005000"), Decimal("0.015000")),
    "gpt-4o-mini": (Decimal("0.000150"), Decimal("0.000600")),
    "gpt-4-turbo": (Decimal("0.010000"), Decimal("0.030000")),
    "gpt-3.5-turbo": (Decimal("0.000500"), Decimal("0.001500")),
    # Groq / Open Source
    "qwen/qwen3.8-27b": (Decimal("0.000200"), Decimal("0.000200")),
    "llama-3.3-70b-versatile": (Decimal("0.000590"), Decimal("0.000790")),
    "llama-3.1-70b-versatile": (Decimal("0.000590"), Decimal("0.000790")),
    "llama-3.1-8b-instant": (Decimal("0.000050"), Decimal("0.000080")),
    "mixtral-8x7b-32768": (Decimal("0.000240"), Decimal("0.000240")),
    # Test fake model
    "fake-model": (Decimal("0.000100"), Decimal("0.000200")),
}


def calculate_cost(
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
) -> Optional[Decimal]:
    """Calculates cost in USD for model usage.

    Returns None with a WARNING if the model is not registered in COST_TABLE.
    Never returns silent 0 for unknown models.
    """
    normalized_name = (model or "").strip().lower()
    pricing = COST_TABLE.get(normalized_name)

    if pricing is None:
        logger.warning(
            "Unknown model '%s' for cost calculation; cost_usd will be recorded as NULL (None)",
            model,
        )
        return None

    in_rate, out_rate = pricing
    prompt_cost = (Decimal(prompt_tokens) / Decimal(1000)) * in_rate
    completion_cost = (Decimal(completion_tokens) / Decimal(1000)) * out_rate
    total_cost = prompt_cost + completion_cost
    return total_cost.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)

