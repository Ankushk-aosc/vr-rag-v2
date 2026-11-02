import logging
from typing import Any, Dict, List, Optional
import httpx

from app.providers.base import Capability, ProviderInfo
from app.providers.errors import ProviderCallError, ProviderNotConfigured
from app.providers.llm.base import LLMProvider, LLMResponse, Usage

logger = logging.getLogger(__name__)


class OpenAICompatibleLLM(LLMProvider):
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        name: str = "openai_compatible",
        client: Optional[httpx.AsyncClient] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        region: Optional[str] = None,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model or "gpt-3.5-turbo"
        self.info = ProviderInfo(
            name=name,
            capability=Capability.CHAT,
            requires_key=True,
            supports_streaming=True,
            supports_usage=True,
            default_model=self.model,
            region=region,
        )

        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5.0, read=60.0, write=30.0, pool=10.0),
                transport=transport,
            )
            self._owns_client = True

    def is_configured(self) -> bool:
        return bool(self.api_key and self.base_url)

    async def chat(
        self,
        messages: List[Dict[str, Any]],
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        **opts
    ) -> LLMResponse:
        if not self.is_configured():
            raise ProviderNotConfigured(
                f"Provider '{self.info.name}' is not configured (missing base_url or api_key)."
            )

        endpoint = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if temperature is not None:
            payload["temperature"] = temperature
        for k, v in opts.items():
            if k not in payload and v is not None:
                payload[k] = v

        try:
            resp = await self._client.post(endpoint, json=payload, headers=headers)
        except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.TimeoutException) as e:
            raise ProviderCallError(f"Provider '{self.info.name}' request timed out") from e
        except httpx.RequestError as e:
            # Never include secret in exception message
            safe_err = str(e).replace(self.api_key, "[REDACTED]") if self.api_key else str(e)
            raise ProviderCallError(f"Provider '{self.info.name}' network error: {safe_err}") from e

        if resp.status_code in (401, 403):
            raise ProviderCallError(f"Provider '{self.info.name}' auth failed (status {resp.status_code})")
        elif resp.status_code == 429:
            raise ProviderCallError(f"Provider '{self.info.name}' rate limited (status 429)")
        elif resp.status_code >= 500:
            raise ProviderCallError(f"Provider '{self.info.name}' server error (status {resp.status_code})")
        elif resp.status_code != 200:
            raise ProviderCallError(f"Provider '{self.info.name}' unexpected response (status {resp.status_code})")

        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            raise ProviderCallError(f"Provider '{self.info.name}' returned no choices")

        msg = choices[0].get("message") or {}
        text = msg.get("content") or ""

        raw_usage = data.get("usage")
        if raw_usage and isinstance(raw_usage, dict):
            prompt_tokens = int(raw_usage.get("prompt_tokens") or 0)
            comp_tokens = int(raw_usage.get("completion_tokens") or 0)
            tot_tokens = int(raw_usage.get("total_tokens") or (prompt_tokens + comp_tokens))
            usage = Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=comp_tokens,
                total_tokens=tot_tokens,
                cost_usd=None,
            )
        else:
            prompt_chars = sum(len(str(m.get("content", ""))) for m in messages)
            prompt_tokens = prompt_chars // 4
            comp_tokens = len(text) // 4
            usage = Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=comp_tokens,
                total_tokens=prompt_tokens + comp_tokens,
                cost_usd=None,
            )

        return LLMResponse(
            text=text,
            model=data.get("model", self.model),
            provider=self.info.name,
            usage=usage,
            raw=data,
        )

    async def close(self) -> None:
        if self._owns_client and not self._client.is_closed:
            await self._client.aclose()
