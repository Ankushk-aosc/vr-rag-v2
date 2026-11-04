import json
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from app.schemas.query import QueryRequest, QueryResponse
from app.services import auth, authorization, rag_engine
from app.services.rag_orchestrator import rag_orchestrator
from app.middleware.rate_limiter import rate_limit
from app.middleware.token_budget import check_token_budget
from app.services.safe_errors import log_with_reference, safe_message

router = APIRouter(prefix="/api/query", tags=["Query"])

# rag_engine's entry points can be replaced in tests; the route then calls the replacement, but only
# after the same authorization step, with the scope it produced.
_DEFAULT_EXECUTE_RAG_QUERY = rag_engine.execute_rag_query
_DEFAULT_STREAM_RAG_EVENTS = rag_engine.stream_rag_events


def resolve_scope(family_entity_id: Optional[str], current_user: Dict[str, Any]) -> authorization.AccessScope:
    """JWT user -> tenant (from server-side memberships) -> RBAC query.execute AND ABAC -> AccessScope.
    The requested family id only selects among the caller's own memberships."""
    return authorization.authorize_query(current_user, family_entity_id)


def resolve_roles(family_entity_id: str, current_user: Dict[str, Any]) -> List[str]:
    """Retrieval role tags for callers that still pass roles (kept for older imports)."""
    return resolve_scope(family_entity_id, current_user).retrieval_roles


def _legacy_kwargs(request: QueryRequest, scope: authorization.AccessScope) -> Dict[str, Any]:
    return dict(
        question=request.question,
        family_entity_id=scope.family_entity_id,
        user_roles=scope.retrieval_roles,
        top_k=request.top_k,
        history=[h.model_dump() for h in request.history],
        mode=request.mode,
        user_id=scope.user_id,
        scope=scope,
    )


@router.post("", response_model=QueryResponse, dependencies=[Depends(rate_limit(max_requests=45, window_seconds=60))])
async def ask_question(
    request: QueryRequest,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    scope = resolve_scope(request.family_entity_id, current_user)
    check_token_budget(scope.family_entity_id, scope.user_id)
    try:
        if rag_engine.execute_rag_query != _DEFAULT_EXECUTE_RAG_QUERY:
            result = await rag_engine.execute_rag_query(**_legacy_kwargs(request, scope))
        else:
            result = await rag_orchestrator.execute_query(
                question=request.question,
                scope=scope,
                history=[h.model_dump() for h in request.history],
                mode=request.mode,
                top_k=request.top_k,
            )
        return QueryResponse(**result)
    except HTTPException:
        raise
    except Exception as e:
        ref = log_with_reference("Query failed", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=safe_message("The question could not be answered.", ref),
        )


@router.post("/stream", dependencies=[Depends(rate_limit(max_requests=45, window_seconds=60))])
async def ask_question_stream(
    request: QueryRequest,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Server-Sent Events stream of the RAG pipeline. Authorization completes before the response
    starts, so a denied caller gets a plain 401/403 and no stream is opened.
    Each `data:` line is a JSON event: stage | sources | answer | done | error
    """
    scope = resolve_scope(request.family_entity_id, current_user)
    check_token_budget(scope.family_entity_id, scope.user_id)

    async def event_source():
        try:
            if rag_engine.stream_rag_events != _DEFAULT_STREAM_RAG_EVENTS:
                stream_gen = rag_engine.stream_rag_events(**_legacy_kwargs(request, scope))
            else:
                stream_gen = rag_orchestrator.execute_query_stream(
                    question=request.question,
                    scope=scope,
                    history=[h.model_dump() for h in request.history],
                    mode=request.mode,
                    top_k=request.top_k,
                )
            async for event in stream_gen:
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except HTTPException as he:
            yield f"data: {json.dumps({'type': 'error', 'message': str(he.detail), 'status_code': he.status_code})}\n\n"
        except Exception as e:
            ref = log_with_reference("Streaming query failed", e)
            message = safe_message("The question could not be answered.", ref)
            yield f"data: {json.dumps({'type': 'error', 'message': message})}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
