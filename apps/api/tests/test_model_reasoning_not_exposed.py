"""
I-10 regression: the model's private reasoning (<think> ... </think>) is never streamed, returned or
spoken. Only the answer leaves the API, even when the reasoning block is malformed or cut off.
"""
import json
from pathlib import Path

import pytest

from app.providers.llm.fake import FakeLLM
from app.services import rag_engine
from app.services.rag_engine import REASONING_ONLY_MESSAGE, strip_model_reasoning

SECRET = "internal chain of thought about the trust deed"
REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("raw,expected", [
    (f"<think>{SECRET}</think>\n\nYou received $4,210 in franking credits [1].",
     "You received $4,210 in franking credits [1]."),
    (f"<THINK>{SECRET}</THINK>Answer.", "Answer."),
    (f"Intro. <think>{SECRET}</think> Answer.", "Intro.  Answer."),
    # opening tag supplied by the chat template, only the closing tag is in the output
    (f"{SECRET}\n</think>\nAnswer.", "Answer."),
    # reasoning cut off by max_tokens: never closed
    (f"Answer first. <think>{SECRET}", "Answer first."),
    (f"<think>{SECRET}", ""),
    ("Plain answer with no reasoning.", "Plain answer with no reasoning."),
    ("", ""),
])
def test_strip_model_reasoning(raw, expected):
    assert strip_model_reasoning(raw) == expected


async def _events(monkeypatch, llm_text, mode="text"):
    llm = FakeLLM(script=[llm_text])
    monkeypatch.setattr(rag_engine, "get_llm", lambda: llm)

    async def no_semantic(*a, **k):
        return []

    monkeypatch.setattr(rag_engine, "_semantic_search", no_semantic)
    monkeypatch.setattr(rag_engine.lexical_index, "search", lambda *a, **k: [])
    monkeypatch.setattr(rag_engine.UsageRecorder, "record", lambda *a, **k: None)
    return [e async for e in rag_engine.stream_rag_events(
        "What franking credits did we receive?", "fam", ["family_admin"], mode=mode, user_id="u1")]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["text", "voice"])
async def test_stream_never_contains_reasoning(monkeypatch, mode):
    events = await _events(monkeypatch, f"<think>{SECRET}</think>The documents do not show franking credits.", mode)
    assert all(e["type"] != "reasoning" for e in events)
    assert SECRET not in json.dumps(events)
    done = next(e for e in events if e["type"] == "done")
    assert done["answer"] == "The documents do not show franking credits."
    assert "reasoning" not in done


@pytest.mark.asyncio
async def test_unterminated_reasoning_is_not_returned_as_the_answer(monkeypatch):
    events = await _events(monkeypatch, f"<think>{SECRET} ... and then the token budget ran out")
    assert SECRET not in json.dumps(events)
    assert events[-1] == {"type": "error", "message": REASONING_ONLY_MESSAGE}


@pytest.mark.asyncio
async def test_non_streaming_result_has_empty_reasoning(monkeypatch):
    llm = FakeLLM(script=[f"<think>{SECRET}</think>Answer."])
    monkeypatch.setattr(rag_engine, "get_llm", lambda: llm)

    async def no_semantic(*a, **k):
        return []

    monkeypatch.setattr(rag_engine, "_semantic_search", no_semantic)
    monkeypatch.setattr(rag_engine.lexical_index, "search", lambda *a, **k: [])
    monkeypatch.setattr(rag_engine.UsageRecorder, "record", lambda *a, **k: None)
    result = await rag_engine.execute_rag_query("Question?", "fam", ["family_admin"], user_id="u1")
    assert result["answer"] == "Answer."
    assert SECRET not in json.dumps(result, default=str)
    from app.schemas.query import QueryResponse
    assert QueryResponse(**result).reasoning == ""


def test_web_client_ignores_reasoning_events():
    api_ts = (REPO_ROOT / "apps/web/src/lib/api.ts").read_text(encoding="utf-8")
    page = (REPO_ROOT / "apps/web/src/app/page.tsx").read_text(encoding="utf-8")
    assert 'type: "reasoning"' not in api_ts
    assert 'case "reasoning"' not in page
