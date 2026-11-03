"""
I-22 regression: source files stay within the project's 600-line limit (.agents/base_rules.md).

VoiceEngine.ts, Dashboard3D.ts, generate_golden.py, dashboards.py and routers/documents.py had grown past it
and were split along existing seams (re-exporting the original names so no import changed).
"""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MAX_LINES = 600
SOURCE_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".css"}


def _source_files():
    """Tracked plus new (not ignored) files, so dependencies and build output are never counted."""
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout
    for rel in out.splitlines():
        path = REPO / rel
        if path.suffix in SOURCE_SUFFIXES and path.is_file():
            yield rel, path


def test_no_source_file_exceeds_the_line_limit():
    files = list(_source_files())
    assert len(files) > 100  # the listing really ran
    too_long = {
        rel: n for rel, path in files
        if (n := len(path.read_text(encoding="utf-8", errors="replace").splitlines())) > MAX_LINES
    }
    assert not too_long, f"files over {MAX_LINES} lines: {too_long}"
