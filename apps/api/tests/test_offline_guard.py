"""
I-25 regression: the suite is offline by construction. Cloud credentials from .env are blanked for every
test, cached cloud clients are reset, and any non-loopback connection is refused (see conftest.py).
"""
import socket

import pytest

from app.config import settings
from app.services import pinecone_service, rag_engine


def test_cloud_credentials_are_blank():
    assert not settings.PINECONE_API_KEY
    assert not settings.GROQ_API_KEY and not settings.LLM_API_KEY and not settings.EMBEDDER_API_KEY
    assert not settings.S3_BUCKET_NAME


def test_cloud_clients_cannot_be_built_even_in_cloud_mode(cloud_mode):
    assert pinecone_service.get_pinecone_client() is None
    assert rag_engine.get_groq_client() is None


@pytest.mark.parametrize("address", [("8.8.8.8", 53), ("34.36.155.80", 443)])
def test_outbound_connections_are_refused(address):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        with pytest.raises(ConnectionRefusedError, match="blocked in tests"):
            s.connect(address)
    finally:
        s.close()


def test_loopback_stays_open():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        client.connect(server.getsockname())  # must not raise
    finally:
        client.close()
        server.close()
