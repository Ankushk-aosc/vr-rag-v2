import json
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from app.schemas.query import QueryRequest, QueryResponse
from app.services import auth, rag_engine
from app.middleware.rate_limiter import rate_limit
from app.middleware.token_budget import check_token_budget
from app.services.safe_errors import log_with_reference, safe_message

router = APIRouter(prefix="/api/query", tags=["Query"])

# Chunks are tagged with family_admin/family_member only. A read-only adviser may read family-wide
# documents (the same rule the listing and document endpoints apply), so it retrieves with the
# member tag; admin-only chunks stay excluded (Audit I-07).
RETRIEVAL_ROLE_ALIASES = {"read_only_adviser": "family_member"}


def resolve_roles(family_entity_id: str, current_user: Dict[str, Any]) -> List[str]:
    if not current_user or not current_user.get("memberships"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please provide a valid Bearer token."
        )
    matched_roles = [
        m["role"] for m in current_user["memberships"]
        if m["family_entity_id"] == family_entity_id
    ]
    if not matched_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: You do not hold active membership in family entity '{family_entity_id}'."
        )
    return list(dict.fromkeys(RETRIEVAL_ROLE_ALIASES.get(r, r) for r in matched_roles))


@router.post("", response_model=QueryResponse, dependencies=[Depends(rate_limit(max_requests=45, window_seconds=60))])
async def ask_question(
    request: QueryRequest,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    user_roles = resolve_roles(request.family_entity_id, current_user)
    user_id = current_user.get("id")
    check_token_budget(request.family_entity_id, user_id)
    try:
        result = await rag_engine.execute_rag_query(
            question=request.question,
            family_entity_id=request.family_entity_id,
            user_roles=user_roles,
            top_k=request.top_k,
            history=[h.model_dump() for h in request.history],
            mode=request.mode,
            user_id=user_id,
        )
        return QueryResponse(**result)
    except rag_engine.RagError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
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
    Server-Sent Events stream of the RAG pipeline. Each `data:` line is a JSON event:
    stage | sources | answer | done | error  (model reasoning is never streamed, Audit I-10)
    """
    user_roles = resolve_roles(request.family_entity_id, current_user)
    user_id = current_user.get("id")
    check_token_budget(request.family_entity_id, user_id)

    async def event_source():
        try:
            async for event in rag_engine.stream_rag_events(
                question=request.question,
                family_entity_id=request.family_entity_id,
                user_roles=user_roles,
                top_k=request.top_k,
                history=[h.model_dump() for h in request.history],
                mode=request.mode,
                user_id=user_id,
            ):
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
