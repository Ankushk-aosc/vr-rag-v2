import pytest
from app.config import Settings
from app.providers import factory
from app.providers.errors import ProviderNotConfigured
from app.providers.llm.fake import FakeLLM


def test_registry_returns_fake_llm():
    settings = Settings(LLM_PROVIDER="fake", LLM_MODEL="fake-model")
    llm = factory.get_llm(settings)
    assert isinstance(llm, FakeLLM)
    assert llm.info.name == "fake"


def test_registry_unknown_provider_raises():
    settings = Settings(LLM_PROVIDER="unknown_super_provider")
    with pytest.raises(ProviderNotConfigured) as exc_info:
        factory.get_llm(settings)
    assert "Unknown LLM provider" in str(exc_info.value)


def test_registry_strict_mode_missing_key_raises():
    settings = Settings(
        LLM_PROVIDER="openai_compatible",
        LLM_BASE_URL="https://api.openai.com/v1",
        LLM_API_KEY="",  # missing key
        PROVIDERS_STRICT=True,
    )
    with pytest.raises(ProviderNotConfigured) as exc_info:
        factory.get_llm(settings)
    assert "requires LLM_API_KEY" in str(exc_info.value)
