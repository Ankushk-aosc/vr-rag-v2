"""Enterprise Query Analysis, Prompt Injection Defense, and Query Rewriter."""

import re
from typing import Any, Dict, List, Optional

PROMPT_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions", re.IGNORECASE),
    re.compile(r"disregard\s+(all\s+)?(previous|prior)\s+instructions", re.IGNORECASE),
    re.compile(r"system\s+prompt", re.IGNORECASE),
    re.compile(r"reveal\s+(internal|secret|hidden|password)", re.IGNORECASE),
    re.compile(r"exfiltrate", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+in\s+DAN\s+mode", re.IGNORECASE),
    re.compile(r"bypass\s+(safety|security|authorization)", re.IGNORECASE),
    re.compile(r"cross[- ]tenant", re.IGNORECASE),
]

YEAR_PATTERN = re.compile(r"\b(20[12]\d|FY[12]\d)\b", re.IGNORECASE)


def inspect_prompt_safety(text: str) -> Optional[str]:
    """Inspects user input for prompt injection or exfiltration attempts. Returns warning if detected."""
    for pattern in PROMPT_INJECTION_PATTERNS:
        if pattern.search(text):
            return "Prompt injection or policy violation pattern detected."
    return None


def analyze_query(question: str) -> Dict[str, Any]:
    """Extracts intent, entities, temporal filters, and metric categories from query."""
    safety_violation = inspect_prompt_safety(question)

    # Detect temporal references
    years = YEAR_PATTERN.findall(question)

    # Classify intent
    q_lower = question.lower()
    if any(k in q_lower for k in ["compare", "versus", "vs", "difference"]):
        intent = "comparison"
    elif any(k in q_lower for k in ["summarise", "summarize", "overview", "breakdown"]):
        intent = "summarization"
    elif any(k in q_lower for k in ["tax", "franking", "ato", "distribution"]):
        intent = "tax_distribution"
    elif any(k in q_lower for k in ["how much", "total", "balance", "capital", "valuation"]):
        intent = "financial_lookup"
    else:
        intent = "general_inquiry"

    return {
        "intent": intent,
        "years": years,
        "has_injection_risk": bool(safety_violation),
        "safety_violation": safety_violation,
    }


def rewrite_conversational_query(question: str, history: Optional[List[Dict[str, str]]]) -> str:
    """
    Rewrites anaphoric or follow-up questions using prior conversation context.
    Example:
      User: "What was the capital call for Fund X in 2025?"
      Follow-up: "What about 2024?"
      Rewritten: "What was the capital call for Fund X in 2024?"
    """
    if not history:
        return question.strip()

    q_lower = question.lower().strip()
    pronouns = {"it", "its", "this", "that", "they", "their"}
    is_follow_up = (
        q_lower.startswith(("what about", "and for", "how about", "in ", "for "))
        or len(question.split()) <= 4
        or bool(set(q_lower.split()) & pronouns)
    )

    if not is_follow_up:
        return question.strip()

    # Find last user question
    last_user_turn = None
    for turn in reversed(history):
        if turn.get("role") == "user" and turn.get("content"):
            last_user_turn = turn["content"]
            break

    if not last_user_turn:
        return question.strip()

    # If the follow-up mentions a new year, replace the old year in the previous question
    new_years = YEAR_PATTERN.findall(question)
    old_years = YEAR_PATTERN.findall(last_user_turn)
    if new_years and old_years:
        rewritten = last_user_turn
        for old, new in zip(old_years, new_years):
            rewritten = re.sub(r"\b" + re.escape(old) + r"\b", new, rewritten, flags=re.IGNORECASE)
        return rewritten

    return f"{last_user_turn} ({question})"

