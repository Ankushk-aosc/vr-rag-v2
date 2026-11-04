"""Centralized Enterprise RAG Orchestrator.

Orchestrates:
1. Authorization (RBAC AND ABAC) -> AccessScope, before any retrieval (services/authorization.py)
2. Query Analysis & Prompt Injection Defense
3. Conversational Query Rewriting
4. Scope-restricted Hybrid Retrieval (pgvector/vector + BM25): only authorized document ids are searched
5. Defence-in-depth check that every candidate is inside the scope
6. Candidate Reranking
7. Context Compression & Provenance Packaging
8. Multi-Model Answer Generation
9. Citation Validation & Grounding Verification
10. Correlation Observability & Audit Logging
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional
from fastapi import HTTPException

from app.config import settings
from app.db import sqlite
from app.services.grounding import verify_grounding
from app.services.model_router import ModelRouter, ModelTask, model_router
from app.services.query_analyzer import analyze_query, rewrite_conversational_query
from app.services.rag_engine import (
    EVIDENCE_CHAR_BUDGET,
    NOT_FOUND_PHRASE,
    SYSTEM_PROMPT,
    TEXT_FORMAT,
    VOICE_FORMAT,
    _citations_for,
    _clean_history,
    _friendly_llm_error,
    _fuse,
    _pack_evidence,
    _semantic_search,
    parse_structured_answer,
    strip_model_reasoning,
)
from app.services.reranker import rerank_passages
from app.services import authorization
from app.services.authorization import AccessScope
from app.services.security_context import SecurityContext

logger = logging.getLogger(__name__)


def _stage_event(id_: str, title: str, status: str, detail: str = "", duration_ms: int = 0) -> Dict[str, Any]:
    return {
        "type": "stage",
        "id": id_,
        "title": title,
        "status": status,
        "detail": detail,
        "duration_ms": duration_ms,
    }


class RagOrchestrator:
    def __init__(self, router: Optional[ModelRouter] = None) -> None:
        self.router = router or model_router

    async def execute_query_stream(
        self,
        question: str,
        sec: Optional[SecurityContext] = None,
        history: Optional[List[Dict[str, str]]] = None,
        mode: str = "text",
        top_k: int = 8,
        correlation_id: Optional[str] = None,
        scope: Optional[AccessScope] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Streaming execution pipeline yielding typed SSE events."""
        req_id = correlation_id or str(uuid.uuid4())
        t0 = time.perf_counter()
        # Authorization first: without a scope nothing is retrieved (raises 403 if RBAC/ABAC deny)
        if scope is None:
            if sec is None:
                raise HTTPException(status_code=401, detail="Authentication required.")
            scope = authorization.build_access_scope(sec.subject, authorization.QUERY_EXECUTE)

        # Step 1: Security & Analysis
        yield _stage_event("analyze", "Query Analysis & Security", "running")
        analysis = analyze_query(question)
        if analysis.get("has_injection_risk"):
            logger.warning("Prompt safety violation flagged for req=%s: %s", req_id, analysis["safety_violation"])
        yield _stage_event(
            "analyze",
            "Query Analysis & Security",
            "done",
            f"Intent: {analysis['intent']}",
            int((time.perf_counter() - t0) * 1000),
        )

        # Step 2: Query Rewriting
        effective_query = rewrite_conversational_query(question, history)

        # Step 3: Security-Filtered Hybrid Retrieval
        t_ret = time.perf_counter()
        yield _stage_event("retrieval", "Hybrid Index Retrieval", "running")

        # Both retrievers receive the same scope: tenant, role tags and authorized document ids are
        # part of each search itself, so unauthorized chunks are never scored or returned
        retrieval_roles = scope.retrieval_roles
        allowed_ids = scope.allowed_document_ids
        sem_task = _semantic_search(
            effective_query,
            family_entity_id=scope.family_entity_id,
            user_roles=retrieval_roles,
            k=max(20, top_k * 2),
            allowed_document_ids=allowed_ids,
        )
        try:
            sem_hits = await sem_task
        except Exception as e:
            logger.error("Semantic search failed: %s", e)
            sem_hits = []

        # Lexical search
        try:
            from app.services.lexical_index import lexical_index
            lex_hits = lexical_index.search(
                effective_query,
                family_entity_id=scope.family_entity_id,
                user_roles=retrieval_roles,
                top_k=max(20, top_k * 2),
                allowed_document_ids=allowed_ids,
            )
        except Exception as e:
            logger.error("Lexical search failed: %s", e)
            lex_hits = []

        # Fuse vector and lexical candidates
        fused_candidates = _fuse(
            semantic=sem_hits,
            lexical=lex_hits,
            dates=analysis.get("years", []),
            top_k=max(30, top_k * 3),
        )

        # Step 4: defence in depth only. Retrieval was already restricted to the scope; this makes a
        # regression in any retriever unable to put another document in front of the model.
        authorized_candidates = [p for p in fused_candidates if p.get("document_id") in allowed_ids]

        # Step 5: Candidate Reranking
        reranked = rerank_passages(effective_query, authorized_candidates, top_k=top_k)
        ret_ms = int((time.perf_counter() - t_ret) * 1000)
        yield _stage_event(
            "retrieval",
            "Hybrid Index Retrieval",
            "done",
            f"{len(reranked)} verified passages identified",
            ret_ms,
        )

        # Step 6: Evidence Citations & Packaging
        citations = authorization.validate_citations(_citations_for(reranked, scope.family_entity_id), scope)
        yield {"type": "sources", "citations": citations}

        packed = _pack_evidence(reranked, analysis.get("years", []), EVIDENCE_CHAR_BUDGET)

        # Step 7: Answer Generation
        t_gen = time.perf_counter()
        yield _stage_event("generate", "Evidence Synthesis", "running")

        # Build prompt with strict prompt-injection defense instructions
        format_instr = VOICE_FORMAT if mode == "voice" else TEXT_FORMAT
        user_prompt = f"{packed}\n\n{format_instr}\n\nQuestion: {question}"

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            *_clean_history(history),
            {"role": "user", "content": user_prompt},
        ]

        # Model routing
        model_spec = self.router.get_spec(ModelTask.ANSWER)

        # Stream tokens from LLM provider
        from app.providers import factory
        llm = factory.get_llm(settings)

        full_answer = ""
        try:
            if hasattr(llm, "stream"):
                async for token in llm.stream(messages):
                    full_answer += token
                    yield {"type": "answer", "delta": token}
            elif hasattr(llm, "chat"):
                resp = await llm.chat(messages)
                full_answer = resp.text
                yield {"type": "answer", "delta": full_answer}
            elif hasattr(llm, "generate"):
                resp = await llm.generate(messages)
                full_answer = getattr(resp, "text", str(resp))
                yield {"type": "answer", "delta": full_answer}
            else:
                full_answer = "No synthesis response."
                yield {"type": "answer", "delta": full_answer}
        except Exception as e:
            err_msg = _friendly_llm_error(e)
            yield {"type": "error", "message": err_msg}
            return

        clean_answer = strip_model_reasoning(full_answer)
        gen_ms = int((time.perf_counter() - t_gen) * 1000)
        yield _stage_event(
            "generate",
            "Evidence Synthesis",
            "done",
            f"Grounded answer synthesized ({model_spec.model_id})",
            gen_ms,
        )

        # Step 8: Grounding Audit
        eval_result = verify_grounding(
            answer=clean_answer,
            citations=citations,
            retrieved_chunks=reranked,
            valid_citations=citations,
            grounded_threshold=settings.GROUNDING_THRESHOLD if hasattr(settings, "GROUNDING_THRESHOLD") else 0.8,
        )

        total_latency_ms = int((time.perf_counter() - t0) * 1000)

        # Audit metadata only: the question and answer are private financial content and are not logged
        try:
            sqlite.log_audit_event(
                action="QUERY",
                user_id=scope.user_id,
                family_entity_id=scope.family_entity_id,
                resource_id=req_id,
                details=(
                    f"question_chars={len(question)}; passages={len(reranked)}; "
                    f"documents={len({c.get('document_id') for c in citations})}; "
                    f"latency_ms={total_latency_ms}; grounded={bool(eval_result.get('grounded'))}"
                ),
            )
        except Exception as e:
            logger.warning("Could not record QUERY audit event: %s", type(e).__name__)

        structured = parse_structured_answer(clean_answer) if mode != "voice" else None

        yield {
            "type": "done",
            "answer": clean_answer,
            "structured_data": structured,
            "citations": authorization.validate_citations(eval_result.get("valid_citations") or citations, scope),
            "grounded": bool(eval_result.get("grounded", False)),
            "total_latency_ms": total_latency_ms,
            "thinking_trace": [],
        }


    async def execute_query(
        self,
        question: str,
        sec: Optional[SecurityContext] = None,
        history: Optional[List[Dict[str, str]]] = None,
        mode: str = "text",
        top_k: int = 8,
        correlation_id: Optional[str] = None,
        scope: Optional[AccessScope] = None,
    ) -> Dict[str, Any]:
        """Synchronous query execution returning full QueryResponse payload."""
        done_event = {}
        async for event in self.execute_query_stream(
            question=question,
            sec=sec,
            history=history,
            mode=mode,
            top_k=top_k,
            correlation_id=correlation_id,
            scope=scope,
        ):
            if event.get("type") == "done":
                done_event = event
            elif event.get("type") == "error":
                raise HTTPException(status_code=502, detail=event.get("message", "Synthesis failed"))

        return {
            "answer": done_event.get("answer", "I couldn't find that in your indexed documents."),
            "citations": done_event.get("citations", []),
            "thinking_trace": done_event.get("thinking_trace", []),
            "structured_data": done_event.get("structured_data"),
            "grounded": done_event.get("grounded", False),
            "total_latency_ms": done_event.get("total_latency_ms"),
        }


rag_orchestrator = RagOrchestrator()

