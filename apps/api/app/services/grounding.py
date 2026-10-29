"""
Grounding & Numeric Claim Verification for Financial RAG.
Resolves Audit ID: R4.
"""
import re
from typing import Any, Dict, List, Set, Tuple

# Patterns to match financial numbers, currencies, percentages, and dates
# e.g. $1,250.50, 45.2%, 176,000,000, 2024-04-01
NUMERIC_CLAIM_RE = re.compile(
    r"""
    (?:\$|AUD\s*|USD\s*)?                # Optional currency symbol or prefix
    \b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b%?  # Number with optional commas, decimals, percent
    |\b\d{4}-\d{2}-\d{2}\b               # ISO Dates
    """,
    re.VERBOSE | re.IGNORECASE
)

# Structural numbers to exclude from financial claim validation (bullet numbers, citations)
CITATION_REF_RE = re.compile(r"\[(\d+)\]")


def normalize_numeric_string(s: str) -> str:
    """Normalizes numeric representations (e.g. '$1,250.00' -> '1250' or '1250.00')."""
    cleaned = re.sub(r"[\$,AUDusd\s%]", "", s)
    return cleaned.strip()


def extract_numeric_tokens(text: str) -> List[str]:
    """
    Extracts significant numeric facts, currencies, and percentages from text,
    filtering out single-digit structural markers (e.g. markdown headers, list bullets).
    """
    # Remove citation brackets so '[1]' is not treated as number 1
    without_citations = CITATION_REF_RE.sub(" ", text)

    raw_matches = NUMERIC_CLAIM_RE.findall(without_citations)
    significant_tokens = []
    for match in raw_matches:
        token = match.strip()
        norm = normalize_numeric_string(token)
        # Skip empty or trivial single-digit integers (often list numbers or markdown levels)
        if not norm or (norm.isdigit() and len(norm) == 1 and "$" not in token and "%" not in token):
            continue
        # Skip common markdown headings like '###'
        if norm.isdigit() and int(norm) in (1, 2, 3, 4, 5, 6) and "$" not in token and "%" not in token:
            continue
        significant_tokens.append(token)

    return list(dict.fromkeys(significant_tokens))


def verify_grounding(
    answer: str,
    citations: List[Dict[str, Any]],
    mode: str = "text",
    not_found_phrase: str = "couldn't find that in your indexed documents"
) -> Dict[str, Any]:
    """
    Comprehensive Grounding & Numeric Verification:
    1. Extracts all inline citation markers [n].
    2. Validates that referenced citations exist in the retrieved evidence.
    3. Extracts numeric, currency, and percentage claims from the generated answer.
    4. Checks whether each numeric claim exists in the evidence text.
    5. Flags hallucinated numbers and calculates grounding confidence.
    """
    if not answer or not answer.strip():
        return {
            "grounded": False,
            "referenced_citations": [],
            "valid_citations": [],
            "invalid_citations": [],
            "unverified_numeric_claims": [],
            "numeric_claim_accuracy": 1.0,
            "warning": "Empty answer."
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
            "warning": "Information not found in indexed corpus."
        }

    # 1. Citation reference verification
    referenced_refs = [int(n) for n in CITATION_REF_RE.findall(answer)]
    available_refs = {c.get("ref"): c for c in citations if "ref" in c}

    valid_refs = [r for r in referenced_refs if r in available_refs]
    invalid_refs = [r for r in referenced_refs if r not in available_refs]

    # In text mode, evidence comes from the cited passages; in voice mode from all retrieved citations
    if mode == "voice":
        evidence_text = " ".join([c.get("snippet", "") + " " + c.get("text", "") for c in citations])
    else:
        cited_passages = [available_refs[r] for r in valid_refs]
        evidence_text = " ".join([c.get("snippet", "") + " " + c.get("text", "") for c in cited_passages])
        # If no citations were placed in text mode, check all retrieved
        if not evidence_text:
            evidence_text = " ".join([c.get("snippet", "") + " " + c.get("text", "") for c in citations])

    # 2. Extract numeric claims from answer
    answer_numbers = extract_numeric_tokens(answer)
    unverified_claims = []

    for num_str in answer_numbers:
        norm = normalize_numeric_string(num_str)
        # Check if the number appears in the evidence text either as formatted string or normalized
        if num_str in evidence_text or norm in evidence_text:
            continue
        # Also check without trailing zero decimals (e.g. 58.1 vs 58.10)
        try:
            val_float = float(norm)
            # check string of int or float
            if str(int(val_float)) in evidence_text or f"{val_float:.2f}" in evidence_text or f"{val_float:.1f}" in evidence_text:
                continue
        except ValueError:
            pass

        unverified_claims.append(num_str)

    # 3. Compute accuracy & grounding status
    total_claims = len(answer_numbers)
    if total_claims == 0:
        accuracy = 1.0
    else:
        accuracy = (total_claims - len(unverified_claims)) / total_claims

    # Grounded condition:
    # Must have citations (or retrieved docs in voice mode)
    # Must not have invalid citations ([99])
    # Must have >= 80% numeric claim accuracy (or 0 claims)
    has_citations = bool(valid_refs) if mode != "voice" else bool(citations)
    no_bad_refs = len(invalid_refs) == 0
    numeric_grounded = len(unverified_claims) == 0 or (accuracy >= 0.8)

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
        "warning": warning
    }

