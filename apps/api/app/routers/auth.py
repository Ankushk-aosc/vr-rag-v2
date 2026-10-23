import uuid
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from app.db import sqlite
from app.services import auth

router = APIRouter(prefix="/api/auth", tags=["Authentication & Family Access"])


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, description="Minimum 8 characters")
    full_name: str = Field(..., min_length=2)
    family_entity_name: str = Field("Smith Family Trust", description="Family office or trust name")


class LoginRequest(BaseModel):
    email: EmailStr
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
    existing = sqlite.get_user_by_email(req.email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email address already exists."
        )

    user_id = str(uuid.uuid4())
    hashed_pwd = auth.hash_password(req.password)

    # 1. Create User
    sqlite.create_user({
        "id": user_id,
        "email": req.email,
        "hashed_password": hashed_pwd,
        "full_name": req.full_name
    })

    # 2. Create Default Family Entity if not exists
    entity_id = str(uuid.uuid4())
    sqlite.create_family_entity({
        "id": entity_id,
        "name": req.family_entity_name,
        "entity_type": "Family Trust"
    })

    # 3. Create Membership (First user is family_admin)
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
        details=f"Created user {req.email} with family_admin role in {req.family_entity_name}"
    )

    token = auth.create_access_token({"sub": user_id, "email": req.email})
    user_record = sqlite.get_user_by_id(user_id)
    user_record.pop("hashed_password", None)
    user_record["memberships"] = sqlite.get_user_memberships(user_id)

    return AuthResponse(access_token=token, user=user_record)


@router.post("/login", response_model=AuthResponse)
async def login(req: LoginRequest):
    user = sqlite.get_user_by_email(req.email)
    if not user or not auth.verify_password(req.password, user["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password."
        )

    token = auth.create_access_token({"sub": user["id"], "email": user["email"]})
    user.pop("hashed_password", None)
    user["memberships"] = sqlite.get_user_memberships(user["id"])

    sqlite.log_audit_event(
        action="USER_LOGIN",
        user_id=user["id"],
        details=f"Successful login for {user['email']}"
    )

    return AuthResponse(access_token=token, user=user)


@router.get("/me")
async def get_my_profile(current_user: Dict[str, Any] = Depends(auth.get_current_user)):
    current_user.pop("hashed_password", None)
    return current_user


@router.get("/audit")
async def get_audit_trail(current_user: Dict[str, Any] = Depends(auth.get_current_user)):
    # Verify user has family_admin role in at least one entity
    roles = [m["role"] for m in current_user.get("memberships", [])]
    if "family_admin" not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Audit logs are restricted to family administrators."
        )
    return sqlite.get_audit_events(limit=50)
