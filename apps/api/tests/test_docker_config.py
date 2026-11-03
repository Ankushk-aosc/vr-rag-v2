"""
I-17 regression: docker-compose.yml builds images that exist and configures the API with settings it reads.

Before the fix compose pointed at Dockerfiles that did not exist, set JWT_SECRET (the API reads
APP_SECRET_KEY), used a postgresql:// URL with no installed driver, connected the API as the Postgres
superuser (which bypasses row-level security) and hard-coded passwords.
"""
import re
from pathlib import Path

import yaml

from app.config import Settings, is_private_endpoint

API = Path(__file__).resolve().parents[1]
REPO = API.parents[1]
COMPOSE = yaml.safe_load((REPO / "docker-compose.yml").read_text(encoding="utf-8"))
SERVICES = COMPOSE["services"]
INIT_SCRIPT = REPO / "docker" / "postgres" / "init-app-role.sh"


def _default(value: str) -> str:
    """Resolve ${VAR:-default} references to their defaults, as compose does with VAR unset."""
    return re.sub(r"\$\{[A-Z_]+:-([^}]*)\}", r"\1", value)


def test_every_build_has_a_dockerfile_and_dockerignore():
    for name, service in SERVICES.items():
        if "build" not in service:
            continue
        context = REPO / service["build"]["context"]
        assert (context / service["build"]["dockerfile"]).is_file(), name
        ignore = (context / ".dockerignore").read_text(encoding="utf-8")
        assert ".env" in ignore, f"{name}: .env would be copied into the image"


def test_api_environment_names_are_settings_the_api_reads():
    unknown = set(SERVICES["api"]["environment"]) - set(Settings.model_fields)
    assert not unknown, f"the API ignores {sorted(unknown)}"


def test_no_secret_is_hard_coded():
    for name, service in SERVICES.items():
        for key, value in (service.get("environment") or {}).items():
            if any(word in key for word in ("PASSWORD", "SECRET", "API_KEY")):
                assert str(value).startswith("${"), f"{name}.{key} must come from .env"
    for required in ("APP_SECRET_KEY", "APP_DB_PASSWORD", "POSTGRES_ADMIN_PASSWORD"):
        assert f"${{{required}:?" in (REPO / "docker-compose.yml").read_text(encoding="utf-8")


def test_api_uses_installed_driver_and_non_superuser_role():
    url = SERVICES["api"]["environment"]["DATABASE_URL"]
    assert url.startswith("postgresql+psycopg://")  # plain postgresql:// needs psycopg2, not installed
    assert "${POSTGRES_USER" not in url and "postgres:" not in url.split("@")[0]
    script = INIT_SCRIPT.read_text(encoding="utf-8")
    assert "NOSUPERUSER NOBYPASSRLS" in script
    mounts = SERVICES["postgres"]["volumes"]
    assert any(m.startswith("./docker/postgres/init-app-role.sh:/docker-entrypoint-initdb.d/") for m in mounts)
    assert b"\r\n" not in INIT_SCRIPT.read_bytes()  # CRLF breaks the script inside the Linux container


def test_compose_defaults_are_a_valid_local_privacy_configuration():
    env = {key: _default(str(value)) for key, value in SERVICES["api"]["environment"].items()}
    assert env["PRIVACY_MODE"] == "local"
    assert is_private_endpoint(env["LOCAL_LLM_BASE_URL"])
    assert "127.0.0.1" not in env["LOCAL_LLM_BASE_URL"]  # that would be the API container itself
    assert "host.docker.internal:host-gateway" in SERVICES["api"]["extra_hosts"]


def test_database_port_is_not_published_beyond_this_machine():
    for port in SERVICES["postgres"].get("ports", []):
        assert str(port).startswith("127.0.0.1:")


def test_settings_load_from_a_shallow_install():
    """The image installs the API at /app, so app/config.py has only three parents (IndexError before)."""
    source = (API / "app" / "config.py").read_text(encoding="utf-8")
    namespace = {"__file__": "/app/app/config.py", "__name__": "shallow_config"}
    exec(compile(source, "/app/app/config.py", "exec"), namespace)
    assert namespace["settings"].PRIVACY_MODE in ("local", "cloud")


def test_env_example_documents_every_required_variable():
    example = (REPO / ".env.example").read_text(encoding="utf-8")
    required = re.findall(r"\$\{([A-Z_]+):\?", (REPO / "docker-compose.yml").read_text(encoding="utf-8"))
    for name in required:
        assert re.search(rf"^{name}=", example, re.M), name
