"""
I-19 regression: relative data paths resolve against apps/api, not the working directory.

Before the fix `SQLITE_DB_PATH=data/app.db` and `UPLOADS_DIR=data/uploads` were CWD-relative, so starting the
API (or a script) from the repo root used a different database and uploads folder than starting it from
apps/api, and documents seemed to disappear.
"""
import os
import subprocess
import sys
from pathlib import Path

from app.config import API_ROOT, Settings, resolve_data_path

API = Path(__file__).resolve().parents[1]


def test_api_root_is_apps_api():
    assert API_ROOT == API


def test_relative_paths_are_anchored_to_apps_api():
    s = Settings(SQLITE_DB_PATH="data/app.db", UPLOADS_DIR="data/uploads")
    assert Path(s.SQLITE_DB_PATH) == API / "data" / "app.db"
    assert Path(s.UPLOADS_DIR) == API / "data" / "uploads"


def test_absolute_paths_are_unchanged(tmp_path):
    db, uploads = tmp_path / "x.db", tmp_path / "up"
    s = Settings(SQLITE_DB_PATH=str(db), UPLOADS_DIR=str(uploads))
    assert Path(s.SQLITE_DB_PATH) == db and Path(s.UPLOADS_DIR) == uploads
    assert resolve_data_path(str(db)) == str(db)


def test_paths_do_not_depend_on_the_working_directory(tmp_path):
    """Start Python from an unrelated folder: the database, uploads and keyword index still live under apps/api."""
    script = (
        "import sys; sys.path.insert(0, sys.argv[1]);"
        "from app.config import settings; from app.services.lexical_index import LEXICAL_DIR;"
        "from app.services.storage import StorageService;"
        "print(settings.SQLITE_DB_PATH); print(settings.UPLOADS_DIR); print(LEXICAL_DIR); print(StorageService().local_dir)"
    )
    env_overrides = {"SQLITE_DB_PATH": "data/app.db", "UPLOADS_DIR": "data/uploads", "PRIVACY_MODE": "local"}
    env = {**os.environ, **env_overrides}
    out = subprocess.run(
        [sys.executable, "-c", script, str(API)], cwd=tmp_path, env=env, capture_output=True, text=True, check=True
    ).stdout.split("\n")
    db, uploads, lexical, storage = (Path(line.strip()) for line in out[:4])
    assert db == API / "data" / "app.db"
    assert uploads == API / "data" / "uploads" == storage
    assert lexical == API / "data" / "lexical"
    assert not (tmp_path / "data").exists()  # nothing was created under the working directory
