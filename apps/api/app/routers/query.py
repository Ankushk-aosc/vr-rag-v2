import json
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from app.schemas.query import QueryRequest, QueryResponse
from app.services import auth, rag_engine

router = APIRouter(prefix="/api/query", tags=["Query"])


def resolve_roles(family_entity_id: str, current_user: Optional[Dict[str, Any]]) -> List[str]:
    user_roles = ["family_admin", "family_member"]
    # Scope permissions if user is authenticated
    if current_user and current_user.get("memberships"):
        matched_roles = [
            m["role"] for m in current_user["memberships"]
            if m["family_entity_id"] == family_entity_id
        ]
        if not matched_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You do not hold active membership in family entity '{family_entity_id}'."
            )
        user_roles = matched_roles
    return user_roles


@router.post("", response_model=QueryResponse)
async def ask_question(
    request: QueryRequest,
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    user_roles = resolve_roles(request.family_entity_id, current_user)
    try:
        result = await rag_engine.execute_rag_query(
            question=request.question,
            family_entity_id=request.family_entity_id,
            user_roles=user_roles,
            top_k=request.top_k,
            history=[h.model_dump() for h in request.history],
            mode=request.mode,
        )
        return QueryResponse(**result)
    except rag_engine.RagError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Query execution error: {str(e)}"
        )


@router.post("/stream")
async def ask_question_stream(
    request: QueryRequest,
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    Server-Sent Events stream of the RAG pipeline. Each `data:` line is a JSON event:
    stage | sources | reasoning | answer | done | error
    """
    user_roles = resolve_roles(request.family_entity_id, current_user)

    async def event_source():
        try:
            async for event in rag_engine.stream_rag_events(
                question=request.question,
                family_entity_id=request.family_entity_id,
                user_roles=user_roles,
                top_k=request.top_k,
                history=[h.model_dump() for h in request.history],
                mode=request.mode,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Query execution error: {e}'})}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
