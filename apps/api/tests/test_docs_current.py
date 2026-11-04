"""
I-21 regression: the operator docs describe the code as it is.

The runbook told operators to set OLLAMA_BASE_URL / OLLAMA_MODEL (never read by the API), used hard-coded
d:\\VR-RAG paths, described a cloud-only data flow and named VR buttons that no longer exist; the README listed
a packages/contracts directory that does not exist; the audit report presented "85/85 tests" as current.
"""
import re
from pathlib import Path

import pytest

from app.config import Settings

REPO = Path(__file__).resolve().parents[3]
DOCS = [REPO / "README.md", REPO / "docs" / "runbook.md", REPO / "docs" / "POC.md", REPO / ".env.example"]
# Variables read by something other than the API's Settings
NON_API_VARS = {
    "POSTGRES_ADMIN_PASSWORD", "APP_DB_USER", "APP_DB_PASSWORD", "MIGRATION_DB_PASSWORD", "APP_DB_NAME", "DOCKER_LOCAL_LLM_BASE_URL",
    "TEST_DATABASE_URL", "EXPO_PUBLIC_API_URL",
}


def _env_assignments(text: str):
    """VAR= lines in .env files and ini/bash code blocks (commented-out ones included)."""
    return set(re.findall(r"^\s*#?\s*([A-Z][A-Z0-9_]+)=", text, re.M))


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: p.name)
def test_no_stale_settings_or_machine_paths(doc):
    text = doc.read_text(encoding="utf-8")
    assert not re.search(r"\b[a-zA-Z]:\\VR-RAG", text), "hard-coded drive path"
    for name in ("OLLAMA_BASE_URL", "OLLAMA_MODEL", "JWT_SECRET"):
        assert name not in text, f"{name} is not a setting the API reads"
    unknown = {
        v for v in _env_assignments(text)
        if v not in Settings.model_fields and v not in NON_API_VARS and not v.startswith("NEXT_PUBLIC_")
    }
    assert not unknown, f"{doc.name} documents variables nothing reads: {sorted(unknown)}"


def test_readme_directory_tree_exists():
    tree = re.search(r"```\nVR-RAG/\n(.*?)```", (REPO / "README.md").read_text(encoding="utf-8"), re.S).group(1)
    stack = []
    for line in tree.splitlines():
        m = re.match(r"^((?:│   |    )*)[├└]── ([^\s#]+)", line)
        if not m:
            continue
        depth = len(m.group(1)) // 4
        stack[depth:] = [m.group(2).rstrip("/")]
        assert (REPO.joinpath(*stack)).exists(), "/".join(stack)


def test_runbook_vr_labels_match_the_web_client():
    web = "".join(p.read_text(encoding="utf-8") for p in (REPO / "apps" / "web" / "src").rglob("*.tsx"))
    runbook = (REPO / "docs" / "runbook.md").read_text(encoding="utf-8")
    vr = runbook[runbook.index('## 6. "View in VR"'):runbook.index("## 7.")]
    labels = re.findall(r"\*\*([^*]+)\*\*", vr)
    assert labels
    for label in labels:
        assert label in web, f"runbook names a VR button that does not exist: {label}"


def test_audit_report_test_count_is_marked_historical():
    text = (REPO / "docs" / "AUDIT_REMEDIATION_FEATURES.md").read_text(encoding="utf-8")
    for line in text.splitlines():
        if "85/85" in line:
            assert "snapshot" in line.lower()
