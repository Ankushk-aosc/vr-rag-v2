"""Multi-Model AI Architecture & Model Router.

Specializes model roles:
- Query Analyzer (intent extraction, entity resolution)
- Query Rewriter (conversational context resolution)
- Embedding Model (semantic encoding with dimension enforcement)
- Reranker (cross-encoder relevance scoring)
- Answer Model (evidence-grounded synthesis)
- Grounding Judge (factual verification & citation audit)
- Safety Model (prompt injection & exfiltration defense)

Enforces strict local privacy policy:
If PRIVACY_MODE == "local", all tasks are routed strictly to local models or mock/in-process engines.
Never falls back to cloud providers in local mode.
"""

from dataclasses import dataclass, field
from enum import Enum
import logging
from typing import Any, Dict, List, Optional

from app.config import Settings, settings as default_settings

logger = logging.getLogger(__name__)


class ModelTask(str, Enum):
    QUERY_ANALYZER = "query_analyzer"
    QUERY_REWRITER = "query_rewriter"
    EMBEDDING = "embedding"
    RERANKER = "reranker"
    ANSWER = "answer"
    GROUNDING_JUDGE = "judge"
    SAFETY = "safety"


@dataclass
class ModelSpec:
    task: ModelTask
    provider: str  # local, groq, openai_compatible, fake
    model_id: str
    dimension: Optional[int] = None
    context_window: int = 4096
    temperature: float = 0.0


class ModelRouter:
    """Intelligent router selecting the optimal model per task under tenant privacy constraints."""

    def __init__(self, cfg: Optional[Settings] = None) -> None:
        self.settings = cfg or default_settings

    @property
    def is_local_only(self) -> bool:
        return self.settings.PRIVACY_MODE == "local"

    def get_spec(self, task: ModelTask, complexity: str = "normal") -> ModelSpec:
        """Resolves ModelSpec for the given task adhering to privacy boundaries."""
        if self.is_local_only:
            # Strictly local routing (no cloud egress)
            if task == ModelTask.EMBEDDING:
                return ModelSpec(
                    task=task,
                    provider="local_st",
                    model_id=self.settings.EMBEDDING_MODEL,
                    dimension=self.settings.EMBEDDING_DIMENSION,
                )
            if task == ModelTask.RERANKER:
                return ModelSpec(
                    task=task,
                    provider="local",
                    model_id="cross-encoder/ms-marco-MiniLM-L-6-v2",
                )
            if task == ModelTask.SAFETY:
                return ModelSpec(
                    task=task,
                    provider="local",
                    model_id="llama-guard-local",
                )
            # LLM tasks in local mode
            local_model = self.settings.LLM_MODEL or "qwen3:8b"
            return ModelSpec(
                task=task,
                provider="local",
                model_id=local_model,
                temperature=0.0,
            )

        # Cloud / Hybrid routing
        if task == ModelTask.EMBEDDING:
            provider = self.settings.EMBEDDER_PROVIDER or "local_st"
            return ModelSpec(
                task=task,
                provider=provider,
                model_id=self.settings.EMBEDDER_MODEL or self.settings.EMBEDDING_MODEL,
                dimension=self.settings.EMBEDDER_DIM or self.settings.EMBEDDING_DIMENSION,
            )

        if task == ModelTask.RERANKER:
            return ModelSpec(
                task=task,
                provider="local",
                model_id="cross-encoder/ms-marco-MiniLM-L-6-v2",
            )

        if task in (ModelTask.QUERY_ANALYZER, ModelTask.QUERY_REWRITER):
            # Fast, smaller model for query transformation
            return ModelSpec(
                task=task,
                provider="groq" if self.settings.GROQ_API_KEY else "local",
                model_id="llama-3.1-8b-instant" if self.settings.GROQ_API_KEY else "qwen3:8b",
                temperature=0.0,
            )

        if task == ModelTask.GROUNDING_JUDGE:
            # Deterministic audit model
            return ModelSpec(
                task=task,
                provider="groq" if self.settings.GROQ_API_KEY else "local",
                model_id="llama-3.3-70b-versatile" if self.settings.GROQ_API_KEY else "qwen3:8b",
                temperature=0.0,
            )

        # Primary Answer generation
        return ModelSpec(
            task=ModelTask.ANSWER,
            provider="groq" if self.settings.GROQ_API_KEY else "local",
            model_id=self.settings.GROQ_MODEL if self.settings.GROQ_API_KEY else (self.settings.LLM_MODEL or "qwen3:8b"),
            temperature=0.1 if complexity == "creative" else 0.0,
        )


model_router = ModelRouter()

