from typing import Any, Dict, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.routers.query import resolve_scope
from app.services import auth, dashboards

router = APIRouter(prefix="/api/dashboards", tags=["Dashboards"])


class DashboardRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)
    answer: str = Field("", max_length=8000, description="The answer already shown, used to keep the dashboard on topic")
    family_entity_id: Optional[str] = Field(None, max_length=64)


@router.post("")
async def create_dashboard(
    request: DashboardRequest,
    current_user: Dict[str, Any] = Depends(auth.get_current_user),
):
    """
    Build a dashboard (KPI tiles + charts) for a question. Values are computed from the tables in
    the caller's own indexed documents; the language model only chooses what to plot.
    """
    scope = resolve_scope(request.family_entity_id, current_user)
    try:
        return await dashboards.build_dashboard(
            question=request.question,
            answer=request.answer,
            family_entity_id=scope.family_entity_id,
            user_roles=scope.retrieval_roles,
            allowed_document_ids=scope.allowed_document_ids,
        )
    except LookupError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
