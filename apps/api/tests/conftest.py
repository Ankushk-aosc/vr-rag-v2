"""
Shared test setup.

Offline by construction (Audit I-25): the developer's .env holds real Pinecone/Groq keys, and tests
used to make live calls with them. Every test now runs with cloud credentials blanked and with
outbound network blocked (loopback stays open for TestClient, local servers and the optional
TEST_DATABASE_URL Postgres). A blocked attempt raises inside the code under test and is listed in the
terminal summary, so a new live dependency is visible instead of silently hitting a real service.
"""
import os
import socket

import pytest

from app.config import settings

LOOPBACK = {"127.0.0.1", "::1", "localhost", "0.0.0.0"}
_blocked_attempts = []
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


def _host_of(address):
    if isinstance(address, tuple) and address:
        return str(address[0])
    return str(address)


def _is_local(address) -> bool:
    if not isinstance(address, tuple):  # AF_UNIX / named pipes
        return True
    host = _host_of(address)
    return host in LOOPBACK or host.startswith("127.")


def _guard(real):
    def connect(sock, address):
        if not _is_local(address):
            _blocked_attempts.append(_host_of(address))
            raise ConnectionRefusedError(f"Outbound network is blocked in tests (Audit I-25): {address}")
        return real(sock, address)
    return connect


def pytest_configure(config):
    # fastembed asks huggingface.co about the cached model on load; use the local cache only
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    socket.socket.connect = _guard(_real_connect)
    socket.socket.connect_ex = _guard(_real_connect_ex)


def pytest_unconfigure(config):
    socket.socket.connect = _real_connect
    socket.socket.connect_ex = _real_connect_ex


def pytest_terminal_summary(terminalreporter):
    if _blocked_attempts:
        hosts = sorted(set(_blocked_attempts))
        terminalreporter.write_line(
            f"Blocked {len(_blocked_attempts)} outbound connection attempt(s) to: {', '.join(hosts)}", yellow=True)


# Credentials that would let a test talk to a real cloud service
CLOUD_SECRETS = ("PINECONE_API_KEY", "GROQ_API_KEY", "LLM_API_KEY", "EMBEDDER_API_KEY", "LOCAL_LLM_API_KEY")


@pytest.fixture(autouse=True)
def _offline_cloud_settings(monkeypatch):
    """Blank cloud keys and cached cloud clients for every test (Audit I-25)."""
    for name in CLOUD_SECRETS:
        monkeypatch.setattr(settings, name, None if name == "PINECONE_API_KEY" else "")
    monkeypatch.setattr(settings, "S3_BUCKET_NAME", None)
    from app.services import pinecone_service, rag_engine
    monkeypatch.setattr(pinecone_service, "_pinecone_client", None)
    monkeypatch.setattr(pinecone_service, "_index", None)
    monkeypatch.setattr(rag_engine, "_groq_client", None)


@pytest.fixture
def cloud_mode(monkeypatch):
    """Run a test with PRIVACY_MODE=cloud (Pinecone/Groq code paths). The default is local (Audit I-09).
    Credentials stay blank, so tests that need Pinecone inject a fake index."""
    monkeypatch.setattr(settings, "PRIVACY_MODE", "cloud")


@pytest.fixture
def local_mode(monkeypatch):
    """Run a test with PRIVACY_MODE=local even if the environment opts in to cloud."""
    monkeypatch.setattr(settings, "PRIVACY_MODE", "local")
