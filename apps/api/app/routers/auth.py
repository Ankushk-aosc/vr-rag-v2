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


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(req: RegisterRequest):
    existing = pinecone_service.get_user_from_pinecone(req.email)
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
        "email": req.email,
        "hashed_password": hashed_pwd,
        "full_name": req.full_name,
        "role": "family_admin",
        "family_entity_id": entity_id
    }
    pinecone_service.save_user_to_pinecone(user_record)

    token = auth.create_access_token({"sub": user_id, "email": req.email})
    safe_user = user_record.copy()
    safe_user.pop("hashed_password", None)
    safe_user["memberships"] = [{"family_entity_id": entity_id, "role": "family_admin"}]

    return AuthResponse(access_token=token, user=safe_user)


@router.post("/login", response_model=AuthResponse)
async def login(req: LoginRequest):
    user = pinecone_service.get_user_from_pinecone(req.email)
    if not user or not auth.verify_password(req.password, user.get("hashed_password", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password."
        )

    token = auth.create_access_token({"sub": user["id"], "email": user["email"]})
    safe_user = user.copy()
    safe_user.pop("hashed_password", None)
    safe_user["memberships"] = [
        {"family_entity_id": user.get("family_entity_id", "default_family"), "role": user.get("role", "family_admin")}
    ]

    return AuthResponse(access_token=token, user=safe_user)


@router.get("/me")
async def get_my_profile(current_user: Dict[str, Any] = Depends(auth.get_current_user)):
    current_user.pop("hashed_password", None)
    return current_user


@router.get("/audit")
async def get_audit_trail(current_user: Dict[str, Any] = Depends(auth.get_current_user)):
    return [
        {
            "id": "audit-1",
            "action": "CLOUD_SESSION_ACTIVE",
            "user_id": current_user.get("id"),
            "details": "Cloud-native session active via Pinecone & Groq Cloud API",
            "timestamp": "2026-10-26T00:00:00Z"
        }
    ]
