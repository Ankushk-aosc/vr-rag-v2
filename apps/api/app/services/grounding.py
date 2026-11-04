"""
Strict Grounding & Numeric Claim Verification for Financial RAG.
Resolves Audit ID: R4 & Phase 3.6 requirements.
"""
from decimal import Decimal, InvalidOperation
import logging
import re
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# Inline citation regex: [1], [2], [ref:1]
CITATION_REF_RE = re.compile(r"\[(?:ref:)?\s*(\d+)\]", re.IGNORECASE)

# Regex to detect unformatted large numbers or numbers with currency/units
NUMBER_PATTERN = re.compile(
    r"""
    (?P<currency>\$|AUD\s*|USD\s*)?
    (?P<number>\b\d{1,3}(?:,\d{3})*(?:\.\d+)?|\b\d+(?:\.\d+)?)\b
    \s*(?P<scale>million|billion|m|b|k)?
    \s*(?P<percent>%)?
    """,
    re.VERBOSE | re.IGNORECASE,
)

# Date pattern: YYYY-MM-DD or DD/MM/YYYY
DATE_PATTERN = re.compile(
    r"\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})\b"
)


def parse_financial_number(num_str: str, scale: Optional[str] = None) -> Optional[Decimal]:
    """Parses clean numeric string and applies word scaling (million, billion, etc.)."""
    cleaned = num_str.replace(",", "").replace("$", "").replace("%", "").strip()
    try:
        val = Decimal(cleaned)
        if scale:
            s = scale.lower()
            if s in ("million", "m"):
                val *= Decimal("1000000")
            elif s in ("billion", "b"):
                val *= Decimal("1000000000")
            elif s == "k":
                val *= Decimal("1000")
        return val
    except (InvalidOperation, ValueError):
        return None


def extract_numeric_tokens(text: str) -> List[str]:
    """
    Extracts financial numeric claims, percentages, and dates from text.
    Filters out structural numbering (like markdown headers or list numbers).
    """
    without_citations = CITATION_REF_RE.sub(" ", text)
    tokens: List[str] = []

    for match in NUMBER_PATTERN.finditer(without_citations):
        raw = match.group(0).strip()
        num = match.group("number")
        scale = match.group("scale")
        percent = match.group("percent")
        currency = match.group("currency")

        if not num:
            continue

        # Skip standalone single digits (1, 2, 3...) that lack currency, percentage, or scaling
        cleaned_num = num.replace(",", "").strip()
        if cleaned_num.isdigit() and len(cleaned_num) == 1 and not (currency or percent or scale):
            continue

        tokens.append(raw)

    for d in DATE_PATTERN.findall(without_citations):
        tokens.append(d)

    return list(dict.fromkeys(tokens))


def extract_numbers_from_evidence(evidence_text: str) -> Set[Decimal]:
    """Extracts all numbers from evidence as Decimal values."""
    numbers: Set[Decimal] = set()
    for match in NUMBER_PATTERN.finditer(evidence_text):
        num_str = match.group("number")
        scale = match.group("scale")
        d_val = parse_financial_number(num_str, scale)
        if d_val is not None:
            numbers.add(d_val)
            # Also add unscaled version if scale was present
            if scale:
                raw_d = parse_financial_number(num_str)
                if raw_d is not None:
                    numbers.add(raw_d)
    return numbers


def verify_grounding(
    answer: str,
    citations: Optional[List[Dict[str, Any]]] = None,
    mode: str = "text",
    not_found_phrase: str = "couldn't find that in your indexed documents",
    retrieved_chunks: Optional[List[Dict[str, Any]]] = None,
    valid_citations: Optional[List[Dict[str, Any]]] = None,
    grounded_threshold: float = 0.8,
    **kwargs: Any,
) -> Dict[str, Any]:
    """
    Phase 3.6 Strict Grounding Verifier:
    1. Extracts all inline citation markers [n].
    2. Gathers evidence ONLY from CITED passages in text mode.
    3. Compares parsed Decimal numbers from answer against numbers extracted from cited evidence.
    4. Eliminates fuzzy "counts as grounded": any ungrounded claim invalidates grounding.
    """
    if citations is None:
        citations = valid_citations or retrieved_chunks or []
    if not answer or not answer.strip():
        return {
            "grounded": False,
            "referenced_citations": [],
            "valid_citations": [],
            "invalid_citations": [],
            "unverified_numeric_claims": [],
            "numeric_claim_accuracy": 1.0,
            "warning": "Empty answer.",
        }

    lower_ans = answer.lower()
    if not_found_phrase.lower() in lower_ans:
        return {
            "grounded": False,
            "referenced_citations": [],
            "valid_citations": [],
            "invalid_citations": [],
            "unverified_numeric_claims": [],
            "numeric_claim_accuracy": 1.0,
            "warning": "Information not found in indexed corpus.",
        }

    referenced_refs = [int(n) for n in CITATION_REF_RE.findall(answer)]
    available_refs = {c.get("ref"): c for c in citations if "ref" in c}

    valid_refs = [r for r in referenced_refs if r in available_refs]
    invalid_refs = [r for r in referenced_refs if r not in available_refs]

    # In text mode, evidence must come from CITED passages only
    if mode == "voice":
        evidence_text = " ".join(c.get("snippet", "") + " " + c.get("text", "") for c in citations)
    else:
        cited_passages = [available_refs[r] for r in valid_refs]
        evidence_text = " ".join(c.get("snippet", "") + " " + c.get("text", "") for c in cited_passages)

    # Extract decimals from cited evidence
    evidence_numbers = extract_numbers_from_evidence(evidence_text)
    answer_tokens = extract_numeric_tokens(answer)
    unverified_claims: List[str] = []

    for token in answer_tokens:
        # If it's a date string, verify literal presence
        if re.match(r"^\d{4}-\d{2}-\d{2}$", token) or re.match(r"^\d{1,2}/\d{1,2}/\d{2,4}$", token):
            if token not in evidence_text:
                unverified_claims.append(token)
            continue

        # Parse token to Decimal
        match = NUMBER_PATTERN.search(token)
        if match:
            num_part = match.group("number")
            scale_part = match.group("scale")
            token_decimal = parse_financial_number(num_part, scale_part)
            if token_decimal is not None:
                # Direct Decimal match in evidence
                if token_decimal in evidence_numbers:
                    continue
                # Raw unscaled match
                raw_dec = parse_financial_number(num_part)
                if raw_dec is not None and raw_dec in evidence_numbers:
                    continue

        # Substring exact check as secondary safeguard
        clean_token = token.replace(",", "").strip()
        if clean_token in evidence_text or token in evidence_text:
            continue

        unverified_claims.append(token)

    total_claims = len(answer_tokens)
    accuracy = ((total_claims - len(unverified_claims)) / total_claims) if total_claims > 0 else 1.0

    # Strict Grounding Invariant:
    # 1. Must cite valid references (or have citations in voice mode)
    # 2. Zero invalid citation numbers ([99])
    # 3. Exactly ZERO unverified numeric claims (no fuzzy >= 0.8)
    has_citations = bool(valid_refs) if mode != "voice" else bool(citations)
    no_bad_refs = len(invalid_refs) == 0
    numeric_grounded = len(unverified_claims) == 0

    is_grounded = bool(has_citations and no_bad_refs and numeric_grounded)

    warning = None
    if invalid_refs:
        warning = f"Answer cited nonexistent references: {invalid_refs}."
    elif unverified_claims:
        warning = f"Unverified numeric claims detected: {', '.join(unverified_claims[:5])}."

    return {
        "grounded": is_grounded,
        "referenced_citations": sorted(list(set(referenced_refs))),
        "valid_citations": [available_refs[r] for r in set(valid_refs)],
        "invalid_citations": invalid_refs,
        "unverified_numeric_claims": unverified_claims,
        "numeric_claim_accuracy": round(accuracy, 2),
        "warning": warning,
    }
