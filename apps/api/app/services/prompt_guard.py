"""
Prompt Guard: Injection Defense & XML Sanitization for RAG Pipeline.
Resolves Audit ID: R3.
"""
import html
import re
from typing import Any, Dict, List, Optional

# XML tags used internally in prompt structuring
INTERNAL_TAGS_RE = re.compile(r"</?(?:evidence|instruction|system|context|prompt)[^>]*>", re.IGNORECASE)

MAX_HISTORY_TURNS = 6
MAX_HISTORY_TURN_CHARS = 700


def escape_xml_attribute(val: str) -> str:
    """Escapes strings for safe inclusion in XML tag attributes."""
    if not val:
        return ""
    # Strip quotes, angle brackets, and escape HTML entities
    cleaned = val.replace('"', '&quot;').replace("'", "&apos;").replace("<", "&lt;").replace(">", "&gt;")
    return cleaned.strip()


def escape_evidence_text(text: str) -> str:
    """
    Sanitizes raw document text before embedding into <evidence>...</evidence> prompt tags.
    Neutralizes attempts to close the <evidence> tag or inject fake system/instruction blocks.
    """
    if not text:
        return ""
    # Replace dangerous closing/opening tags with neutralized textual representations
    neutralized = INTERNAL_TAGS_RE.sub(lambda m: html.escape(m.group(0)), text)
    # Neutralize markdown-based system role impersonation attempts
    neutralized = re.sub(r"(?i)\n(?:system|assistant|instruction):\s*", "\n[doc-text]: ", neutralized)
    return neutralized


def sanitize_conversation_history(history: Optional[List[Dict[str, Any]]]) -> List[Dict[str, str]]:
    """
    Validates and sanitizes client-supplied multi-turn conversation history.
    1. Rejects forged 'system' turns.
    2. Only permits 'user' and 'assistant' roles.
    3. Caps turn count and per-turn character length.
    4. Strips XML prompt injection payloads from past turns.
    """
    if not history:
        return []

    sanitized: List[Dict[str, str]] = []
    # Only keep the most recent turns up to MAX_HISTORY_TURNS
    recent_turns = history[-MAX_HISTORY_TURNS:]

    for turn in recent_turns:
        role = str(turn.get("role", "")).strip().lower()
        content = str(turn.get("content", "")).strip()

        # Reject or skip forged system turns
        if role not in ("user", "assistant"):
            continue

        if not content:
            continue

        # Truncate turn length
        if len(content) > MAX_HISTORY_TURN_CHARS:
            content = content[:MAX_HISTORY_TURN_CHARS] + "..."

        # Neutralize XML breakout tags in past turns
        clean_content = escape_evidence_text(content)

        sanitized.append({
            "role": role,
            "content": clean_content
        })

    return sanitized

