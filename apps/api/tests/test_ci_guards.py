"""
I-18 regression: CI runs the full suite on Python 3.11, and the workflow keeps all its gates.

Python 3.14 evaluates annotations lazily, so a typing name used without being imported passes locally
but raises NameError at import time on 3.11 (CI). That broke evals/generate_corpus.py, evals/report.py
and evals/run.py, and therefore the existing evals workflow.
"""
import ast
from pathlib import Path

import yaml

API = Path(__file__).resolve().parents[1]
REPO = API.parents[1]
TYPING_NAMES = {
    "Any", "Dict", "List", "Optional", "Tuple", "Set", "Union", "Callable", "Iterable", "Iterator",
    "AsyncIterator", "Generator", "Sequence", "Mapping", "Literal", "Type",
}


def test_every_typing_name_is_imported():
    problems = []
    for root in ("app", "evals", "tests", "alembic"):
        for path in (API / root).rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            imported = {
                alias.asname or alias.name
                for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module in ("typing", "collections.abc")
                for alias in node.names
            }
            used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id in TYPING_NAMES}
            if used - imported:
                problems.append(f"{path.relative_to(API)}: {sorted(used - imported)}")
    assert not problems, "typing names used but not imported (NameError on Python 3.11):\n" + "\n".join(problems)


def test_ci_workflow_runs_every_gate():
    workflow = yaml.safe_load((REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8"))
    jobs = workflow["jobs"]
    assert set(jobs) == {"backend", "postgres", "web", "mobile"}
    runs = {name: " ".join(step.get("run", "") for step in job["steps"]) for name, job in jobs.items()}
    assert "pytest -q" in runs["backend"] and "tests/" not in runs["backend"]  # the whole suite, not a subset
    assert "sqlite.init_db()" in runs["postgres"] and "TEST_DATABASE_URL" in str(jobs["postgres"])
    assert "NOSUPERUSER NOBYPASSRLS" in runs["postgres"]  # RLS is meaningless for a superuser role
    assert "tsc --noEmit" in runs["web"] and "npm run build" in runs["web"]
    assert "tsc --noEmit" in runs["mobile"]
    for job in jobs.values():
        versions = [s["with"].get("python-version") for s in job["steps"] if "setup-python" in s.get("uses", "")]
        assert all(v == "3.11" for v in versions)


def test_nightly_real_llm_eval_opts_in_to_cloud_mode():
    evals = yaml.safe_load((REPO / ".github" / "workflows" / "evals.yml").read_text(encoding="utf-8"))
    nightly = next(s for s in evals["jobs"]["eval-nightly"]["steps"] if "--real-llm" in s.get("run", ""))
    assert nightly["env"]["PRIVACY_MODE"] == "cloud"


def test_requirements_cover_third_party_imports():
    declared = {
        line.split("[")[0].split(">=")[0].split("==")[0].strip().lower()
        for line in (API / "requirements.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }
    # import name -> distribution name, for everything app/evals/tests import at module level
    needed = {
        "sqlalchemy": "sqlalchemy", "alembic": "alembic", "psycopg": "psycopg", "PIL": "pillow",
        "pytesseract": "pytesseract", "cv2": "opencv-python-headless", "boto3": "boto3", "numpy": "numpy",
        "fastembed": "fastembed", "fitz": "pymupdf", "docx": "python-docx", "openpyxl": "openpyxl", "jwt": "pyjwt",
    }
    assert {dist for dist in needed.values()} <= declared, sorted(set(needed.values()) - declared)
