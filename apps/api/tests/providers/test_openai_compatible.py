import json
import pytest
import httpx
from app.config import Settings
from app.providers import factory
from app.providers.errors import ProviderCallError
from app.providers.llm.openai_compatible import OpenAICompatibleLLM


@pytest.mark.asyncio
async def test_openai_compatible_success():
    secret_key = "test_super_secret_llm_key_12345"
    recorded_requests = []

    def mock_handler(request: httpx.Request):
        recorded_requests.append(request)
        body = json.loads(request.read())
        assert body["model"] == "test-model-qwen"
        assert body["messages"][0]["content"] == "Calculate franking credits"

        resp_data = {
            "id": "chatcmpl-test-123",
            "model": "test-model-qwen",
            "choices": [
                {"message": {"role": "assistant", "content": "Franking credits are AUD $4,200.00."}}
            ],
            "usage": {
                "prompt_tokens": 15,
                "completion_tokens": 8,
                "total_tokens": 23,
            },
        }
        return httpx.Response(200, json=resp_data)

    transport = httpx.MockTransport(mock_handler)
    llm = OpenAICompatibleLLM(
        base_url="https://api.test-provider.com/v1",
        api_key=secret_key,
        model="test-model-qwen",
        transport=transport,
    )
    assert llm.is_configured() is True

    res = await llm.chat([{"role": "user", "content": "Calculate franking credits"}])
    assert res.text == "Franking credits are AUD $4,200.00."
    assert res.model == "test-model-qwen"
    assert res.usage.prompt_tokens == 15
    assert res.usage.completion_tokens == 8
    assert res.usage.total_tokens == 23

    # Assert request headers
    assert len(recorded_requests) == 1
    req = recorded_requests[0]
    assert req.url == "https://api.test-provider.com/v1/chat/completions"
    assert req.headers["Authorization"] == f"Bearer {secret_key}"
    assert req.headers["Content-Type"] == "application/json"

    await llm.close()


@pytest.mark.asyncio
async def test_openai_compatible_auth_error_no_secret_leak():
    secret_key = "super_confidential_sk_secret_9999"

    def mock_handler(request: httpx.Request):
        return httpx.Response(401, json={"error": "Invalid API key"})

    transport = httpx.MockTransport(mock_handler)
    llm = OpenAICompatibleLLM(
        base_url="https://api.test-provider.com/v1",
        api_key=secret_key,
        model="test-model",
        transport=transport,
    )

    with pytest.raises(ProviderCallError) as exc_info:
        await llm.chat([{"role": "user", "content": "Ping"}])

    err_msg = str(exc_info.value)
    assert "auth failed" in err_msg.lower()
    # CRITICAL: Secret key must NEVER appear in the exception message
    assert secret_key not in err_msg


@pytest.mark.asyncio
async def test_openai_compatible_rate_limited():
    def mock_handler(request: httpx.Request):
        return httpx.Response(429, json={"error": "Rate limit exceeded"})

    transport = httpx.MockTransport(mock_handler)
    llm = OpenAICompatibleLLM(
        base_url="https://api.test-provider.com/v1",
        api_key="some_key",
        model="test-model",
        transport=transport,
    )

    with pytest.raises(ProviderCallError) as exc_info:
        await llm.chat([{"role": "user", "content": "Ping"}])

    err_msg = str(exc_info.value)
    assert "rate limited" in err_msg.lower()


@pytest.mark.asyncio
async def test_swapping_llm_provider_fake_to_openai_compatible(monkeypatch):
    """
    Acceptance Gate 3:
    Swapping LLM_PROVIDER from fake to openai_compatible in a test with mock transport
    runs the SAME call path with no code changes.
    """
    # 1. Fake provider call path
    settings_fake = Settings(LLM_PROVIDER="fake")
    llm_fake = factory.get_llm(settings_fake)
    res_fake = await llm_fake.chat([{"role": "user", "content": "What is our balance?"}])
    assert res_fake.text == "FAKE: What is our balance?"
    assert res_fake.provider == "fake"

    # 2. OpenAI-compatible provider call path using same messages schema
    def mock_handler(request: httpx.Request):
        return httpx.Response(200, json={
            "choices": [{"message": {"role": "assistant", "content": "Balance is AUD $1,250,000.00."}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18}
        })

    transport = httpx.MockTransport(mock_handler)
    settings_compat = Settings(
        LLM_PROVIDER="openai_compatible",
        LLM_BASE_URL="https://api.openai.com/v1",
        LLM_API_KEY="sk-test-key",
        LLM_MODEL="gpt-4o",
    )

    orig_client = httpx.AsyncClient
    monkeypatch.setattr(
        "app.providers.llm.openai_compatible.httpx.AsyncClient",
        lambda *args, **kwargs: orig_client(transport=transport)
    )

    llm_compat = factory.get_llm(settings_compat)
    res_compat = await llm_compat.chat([{"role": "user", "content": "What is our balance?"}])
    assert res_compat.text == "Balance is AUD $1,250,000.00."
    assert res_compat.provider == "openai_compatible"
    assert res_compat.usage.total_tokens == 18
