import logging
from typing import Any, Dict
from fastapi import APIRouter, Depends, HTTPException, status
from app.config import settings
from app.providers import factory
from app.services import auth

router = APIRouter(prefix="/api/providers", tags=["Providers"])
logger = logging.getLogger(__name__)


@router.get("")
async def get_providers_info(
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Returns active provider registry details (Phase 4a.7).
    Restricted strictly to family_admin role.
    Guarantees zero leakage of API keys, tokens, or credential-bearing URLs.
    """
    memberships = current_user.get("memberships") or []
    is_admin = any(m.get("role") == "family_admin" for m in memberships)
    if not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Only family_admin can inspect provider configuration."
        )

    llm = factory.get_llm(settings)
    embedder = factory.get_embedder(settings)
    vector_store = factory.get_vector_store(settings)
    stt = factory.get_stt(settings)
    tts = factory.get_tts(settings)

    return {
        "llm": {
            "provider": llm.info.name,
            "model": getattr(llm, "model", llm.info.default_model),
            "region": llm.info.region,
            "requires_key": llm.info.requires_key,
        },
        "embedder": {
            "provider": embedder.info.name,
            "model": getattr(embedder, "model", getattr(embedder, "model_name", embedder.info.default_model)),
            "dim": getattr(embedder, "dim", None),
            "requires_key": embedder.info.requires_key,
        },
        "vector_store": {
            "provider": vector_store.info.name,
            "region": vector_store.info.region,
            "requires_key": vector_store.info.requires_key,
        },
        "stt": {
            "provider": stt.info.name,
            "region": stt.info.region,
            "requires_key": stt.info.requires_key,
        },
        "tts": {
            "provider": tts.info.name,
            "region": tts.info.region,
            "requires_key": tts.info.requires_key,
        },
    }
