"""
Generates the evals/golden.jsonl dataset containing >= 80 annotated evaluation cases.
"""
import json
import sys
from pathlib import Path

EVALS_DIR = Path(__file__).resolve().parent
GOLDEN_PATH = EVALS_DIR / "golden.jsonl"

# Ensure apps/api is in sys.path, so `python evals/generate_golden.py` works as a script (as in evals/run.py)
API_ROOT = EVALS_DIR.parent
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from evals.golden_cases import CASES  # noqa: E402  (data split into evals/golden_cases/, Audit I-22)


def generate_golden_dataset():
    with GOLDEN_PATH.open("w", encoding="utf-8") as f:
        for case in CASES:
            f.write(json.dumps(case) + "\n")
    print(f"Generated {len(CASES)} golden cases to {GOLDEN_PATH}")
    return len(CASES)


if __name__ == "__main__":
    generate_golden_dataset()

