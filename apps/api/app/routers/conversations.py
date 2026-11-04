"""Tenant-isolated, user-scoped Conversations & Messages API Router."""

import json
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.db import sqlite
from app.services.security_context import SecurityContext, get_security_context, require_permission

router = APIRouter(prefix="/api/conversations", tags=["Conversations"])


class CreateConversationRequest(BaseModel):
    title: Optional[str] = Field("Financial Inquiry", max_length=255)


class AddMessageRequest(BaseModel):
    role: str = Field(..., pattern="^(user|assistant|system)$")
    content: str = Field(..., min_length=1)
    citations: Optional[List[Dict[str, Any]]] = None
    metadata: Optional[Dict[str, Any]] = None


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_new_conversation(
    req: CreateConversationRequest,
    sec: SecurityContext = Depends(require_permission("conversations.create")),
):
    """Creates a new conversation strictly bound to the authenticated tenant and user."""
    conv = sqlite.create_conversation(
        tenant_id=sec.tenant_id,
        user_id=sec.user_id,
        title=req.title or "Financial Inquiry",
    )
    return conv


@router.get("")
async def list_user_conversations(
    sec: SecurityContext = Depends(require_permission("conversations.read")),
):
    """Lists conversations owned by the caller within their authorized tenant."""
    return sqlite.list_conversations(tenant_id=sec.tenant_id, user_id=sec.user_id)


@router.get("/{conversation_id}")
async def get_conversation_details(
    conversation_id: str,
    sec: SecurityContext = Depends(require_permission("conversations.read")),
):
    """Retrieves conversation and messages, validating strict tenant & user ownership."""
    conv = sqlite.get_conversation(
        conversation_id=conversation_id,
        tenant_id=sec.tenant_id,
        user_id=sec.user_id,
    )
    if not conv:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found or access denied.",
        )
    messages = sqlite.list_messages(conversation_id=conversation_id)
    # Parse citations and metadata JSON
    parsed_messages = []
    for m in messages:
        msg_dict = dict(m)
        if msg_dict.get("citations_json"):
            try:
                msg_dict["citations"] = json.loads(msg_dict["citations_json"])
            except Exception:
                msg_dict["citations"] = []
        if msg_dict.get("metadata_json"):
            try:
                msg_dict["metadata"] = json.loads(msg_dict["metadata_json"])
            except Exception:
                msg_dict["metadata"] = {}
        parsed_messages.append(msg_dict)

    conv["messages"] = parsed_messages
    return conv


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    conversation_id: str,
    sec: SecurityContext = Depends(require_permission("conversations.delete")),
):
    """Deletes conversation, ensuring only the genuine owner in the same tenant can delete it."""
    deleted = sqlite.delete_conversation(
        conversation_id=conversation_id,
        tenant_id=sec.tenant_id,
        user_id=sec.user_id,
    )
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found or access denied.",
        )
    return None


@router.post("/{conversation_id}/messages", status_code=status.HTTP_201_CREATED)
async def add_message_to_conversation(
    conversation_id: str,
    req: AddMessageRequest,
    sec: SecurityContext = Depends(require_permission("conversations.create")),
):
    """Appends a message to an existing conversation owned by the caller."""
    conv = sqlite.get_conversation(
        conversation_id=conversation_id,
        tenant_id=sec.tenant_id,
        user_id=sec.user_id,
    )
    if not conv:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found or access denied.",
        )

    cit_json = json.dumps(req.citations) if req.citations else None
    meta_json = json.dumps(req.metadata) if req.metadata else None

    msg = sqlite.add_message(
        conversation_id=conversation_id,
        role=req.role,
        content=req.content,
        citations_json=cit_json,
        metadata_json=meta_json,
    )
    return msg

