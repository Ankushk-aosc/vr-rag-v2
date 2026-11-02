import pytest
from app.providers.llm.fake import FakeLLM


@pytest.mark.asyncio
async def test_fake_llm_scripted_and_echo():
    # 1. Scripted answers popped first
    llm = FakeLLM(script=["First response", "Second response"], model="fake-test-model")
    assert llm.is_configured() is True
    assert llm.info.name == "fake"
    assert llm.info.requires_key is False

    # Turn 1
    res1 = await llm.chat([{"role": "user", "content": "Hello world"}])
    assert res1.text == "First response"
    assert res1.model == "fake-test-model"
    assert res1.usage.prompt_tokens == len("Hello world") // 4
    assert res1.usage.completion_tokens == len("First response") // 4
    assert res1.usage.total_tokens == res1.usage.prompt_tokens + res1.usage.completion_tokens

    # Turn 2
    res2 = await llm.chat([{"role": "user", "content": "How are franking credits treated?"}])
    assert res2.text == "Second response"

    # Turn 3 (script exhausted -> echoes last user message)
    res3 = await llm.chat([
        {"role": "system", "content": "You are a sovereign financial assistant."},
        {"role": "user", "content": "Explain trust distributions"}
    ])
    assert res3.text == "FAKE: Explain trust distributions"

    # Verify calls recorded
    assert len(llm.calls) == 3
    assert llm.calls[0]["messages"][0]["content"] == "Hello world"
    assert llm.calls[2]["messages"][1]["content"] == "Explain trust distributions"
