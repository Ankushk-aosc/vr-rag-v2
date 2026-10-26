from typing import Any, Dict, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from app.schemas.query import QueryRequest, QueryResponse
from app.services import auth, rag_engine

router = APIRouter(prefix="/api/query", tags=["Query"])


@router.post("", response_model=QueryResponse)
async def ask_question(
    request: QueryRequest,
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    user_id = current_user.get("id") if current_user else "anonymous"
    user_roles = ["family_admin", "family_member"]

    # Scope permissions if user is authenticated
    if current_user and current_user.get("memberships"):
        memberships = current_user["memberships"]
        matched_roles = [
            m["role"] for m in memberships
            if m["family_entity_id"] == request.family_entity_id
        ]
        if not matched_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You do not hold active membership in family entity '{request.family_entity_id}'."
            )
        user_roles = matched_roles

    try:
        result = await rag_engine.execute_rag_query(
            question=request.question,
            family_entity_id=request.family_entity_id,
            user_roles=user_roles,
            top_k=request.top_k
        )


        return QueryResponse(**result)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Query execution error: {str(e)}"
        )
