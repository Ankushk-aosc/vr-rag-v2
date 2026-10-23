from fastapi import APIRouter, HTTPException, status
from app.schemas.query import QueryRequest, QueryResponse
from app.services import rag_engine

router = APIRouter(prefix="/api/query", tags=["Query"])


@router.post("", response_model=QueryResponse)
async def ask_question(request: QueryRequest):
    try:
        result = await rag_engine.execute_rag_query(
            question=request.question,
            family_entity_id=request.family_entity_id,
            top_k=request.top_k
        )
        return QueryResponse(**result)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Query execution error: {str(e)}"
        )
