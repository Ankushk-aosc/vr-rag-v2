from decimal import Decimal
from typing import Any, Dict, List, Optional
from app.providers.base import Capability, ProviderInfo
from app.providers.llm.base import LLMProvider, LLMResponse, Usage


class FakeLLM(LLMProvider):
    def __init__(self, script: Optional[List[str]] = None, model: str = "fake-model"):
        self.info = ProviderInfo(
            name="fake",
            capability=Capability.CHAT,
            requires_key=False,
            supports_streaming=True,
            supports_usage=True,
            default_model=model,
            region="local"
        )
        self.script: List[str] = list(script) if script else []
        self.calls: List[Dict[str, Any]] = []

    def is_configured(self) -> bool:
        return True

    async def chat(
        self,
        messages: List[Dict[str, Any]],
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        **opts
    ) -> LLMResponse:
        call_record = {
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "opts": opts,
        }
        self.calls.append(call_record)

        if self.script:
            response_text = self.script.pop(0)
        else:
            last_user_msg = ""
            for m in reversed(messages):
                if m.get("role") == "user":
                    last_user_msg = m.get("content", "")
                    break
            response_text = f"FAKE: {last_user_msg}"

        prompt_chars = sum(len(str(m.get("content", ""))) for m in messages)
        prompt_tokens = prompt_chars // 4
        comp_tokens = len(response_text) // 4
        total_tokens = prompt_tokens + comp_tokens

        usage = Usage(
            prompt_tokens=prompt_tokens,
            completion_tokens=comp_tokens,
            total_tokens=total_tokens,
            cost_usd=Decimal("0"),
        )

        return LLMResponse(
            text=response_text,
            model=self.info.default_model or "fake-model",
            provider="fake",
            usage=usage,
            raw={"script_remaining": len(self.script)},
        )
