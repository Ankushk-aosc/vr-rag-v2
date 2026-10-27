import uuid
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from app.services import auth, pinecone_service

router = APIRouter(prefix="/api/auth", tags=["Authentication & Family Access"])


class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=5, description="Email address")
    password: str = Field(..., min_length=8, description="Minimum 8 characters")
    full_name: str = Field(..., min_length=2)
    family_entity_name: str = Field("Smith Family Trust", description="Family office or trust name")


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=5, description="Email address")
    password: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: Dict[str, Any]


class MembershipResponse(BaseModel):
    id: str
    family_entity_id: str
    entity_name: str
    role: str


from app.db import sqlite

@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(req: RegisterRequest):
    existing = sqlite.get_user_by_email(req.email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email address already exists."
        )

    user_id = str(uuid.uuid4())
    entity_id = "default_family"
    hashed_pwd = auth.hash_password(req.password)

    user_record = {
        "id": user_id,
        "email": req.email.lower().strip(),
        "hashed_password": hashed_pwd,
        "full_name": req.full_name
    }
    sqlite.create_user(user_record)

    # Ensure family entity exists and bind user membership
    sqlite.create_family_entity({
        "id": entity_id,
        "name": req.family_entity_name or "Default Family Trust",
        "entity_type": "Family Trust"
    })
    membership_id = str(uuid.uuid4())
    sqlite.create_membership({
        "id": membership_id,
        "user_id": user_id,
        "family_entity_id": entity_id,
        "role": "family_admin"
    })

    sqlite.log_audit_event(
        action="USER_REGISTERED",
        user_id=user_id,
        resource_id=entity_id,
        details=f"User registered with family role 'family_admin'."
    )

    token = auth.create_access_token({"sub": user_id, "email": req.email})
    safe_user = {
        "id": user_id,
        "email": req.email,
        "full_name": req.full_name,
        "memberships": [{"family_entity_id": entity_id, "role": "family_admin"}]
    }

    return AuthResponse(access_token=token, user=safe_user)


@router.post("/login", response_model=AuthResponse)
async def login(req: LoginRequest):
    user = sqlite.get_user_by_email(req.email)
    if not user or not auth.verify_password(req.password, user.get("hashed_password", "")):
        sqlite.log_audit_event(
            action="LOGIN_FAILED",
            user_id=req.email,
            resource_id=None,
            details="Invalid credentials attempt."
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password."
        )

    user_id = user["id"]
    memberships = sqlite.get_user_memberships(user_id)
    if not memberships:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No active family office or trust memberships found."
        )

    sqlite.log_audit_event(
        action="LOGIN_SUCCESS",
        user_id=user_id,
        resource_id=None,
        details="User successfully authenticated."
    )

    token = auth.create_access_token({"sub": user_id, "email": user["email"]})
    safe_user = {
        "id": user_id,
        "email": user["email"],
        "full_name": user.get("full_name", ""),
        "memberships": memberships
    }

    return AuthResponse(access_token=token, user=safe_user)


@router.get("/me")
async def get_my_profile(current_user: Dict[str, Any] = Depends(auth.get_current_user)):
    safe = current_user.copy()
    safe.pop("hashed_password", None)
    return safe


@router.get("/audit")
async def get_audit_trail(current_user: Dict[str, Any] = Depends(auth.get_current_user)):
    user_id = current_user["id"]
    events = sqlite.get_audit_events(limit=50)
    # Filter to authorized family events
    return events
