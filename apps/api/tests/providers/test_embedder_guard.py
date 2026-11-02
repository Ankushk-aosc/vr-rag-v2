import pytest
from unittest.mock import AsyncMock, MagicMock
from app.config import Settings
from app.main import lifespan, app


@pytest.mark.asyncio
async def test_embedder_guard_mismatch_with_data_raises(monkeypatch):
    """If stored vectors exist (count > 0) and embedder model/dim differs, startup must abort."""
    mock_vector_store = MagicMock()
    mock_vector_store.get_index_meta = AsyncMock(return_value={
        "embedder_model": "old-text-embed-384",
        "embedder_dim": 384,
        "count": 1500,
        "untagged": False,
    })

    mock_embedder = MagicMock()
    mock_embedder.model = "new-model-768"
    mock_embedder.dim = 768

    monkeypatch.setattr("app.providers.factory.get_vector_store", lambda s: mock_vector_store)
    monkeypatch.setattr("app.providers.factory.get_embedder", lambda s: mock_embedder)

    with pytest.raises(RuntimeError) as exc_info:
        async with lifespan(app):
            pass

    assert "does not match" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_embedder_guard_mismatch_empty_index_proceeds(monkeypatch):
    """If index is empty (count == 0), mismatch only logs a warning and proceeds."""
    mock_vector_store = MagicMock()
    mock_vector_store.get_index_meta = AsyncMock(return_value={
        "embedder_model": "old-model-384",
        "embedder_dim": 384,
        "count": 0,
        "untagged": False,
    })

    mock_embedder = MagicMock()
    mock_embedder.model = "new-model-768"
    mock_embedder.dim = 768

    monkeypatch.setattr("app.providers.factory.get_vector_store", lambda s: mock_vector_store)
    monkeypatch.setattr("app.providers.factory.get_embedder", lambda s: mock_embedder)

    # Should not raise
    async with lifespan(app):
        assert app.state.embedder == mock_embedder
        assert app.state.vector_store == mock_vector_store


@pytest.mark.asyncio
async def test_embedder_guard_matching_proceeds(monkeypatch):
    """When models and dimensions match, startup proceeds cleanly."""
    mock_vector_store = MagicMock()
    mock_vector_store.get_index_meta = AsyncMock(return_value={
        "embedder_model": "all-MiniLM-L6-v2",
        "embedder_dim": 384,
        "count": 500,
        "untagged": False,
    })

    mock_embedder = MagicMock()
    mock_embedder.model = "all-MiniLM-L6-v2"
    mock_embedder.dim = 384

    monkeypatch.setattr("app.providers.factory.get_vector_store", lambda s: mock_vector_store)
    monkeypatch.setattr("app.providers.factory.get_embedder", lambda s: mock_embedder)

    async with lifespan(app):
        assert app.state.embedder == mock_embedder
