import re
import uuid
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator
from app.services import auth, pinecone_service
from app.middleware.rate_limiter import rate_limit

router = APIRouter(prefix="/api/auth", tags=["Authentication & Family Access"])

EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")


def _mask_email(email: str) -> str:
    """Mask email for privacy in audit logs (e.g. j***e@example.com)."""
    if "@" not in email:
        return "***"
    local_part, domain = email.split("@", 1)
    if len(local_part) <= 2:
        masked_local = local_part[0] + "***"
    else:
        masked_local = local_part[0] + "***" + local_part[-1]
    return f"{masked_local}@{domain}"


class RegisterRequest(BaseModel):
    email: str = Field(..., description="Valid email address")
    password: str = Field(..., min_length=8, description="Minimum 8 characters")
    full_name: str = Field(..., min_length=2)
    family_entity_name: Optional[str] = Field(None, description="Family office or trust name")
    invite_entity_id: Optional[str] = Field(None, description="Optional entity ID to join an existing family")

    @field_validator("email")
    @classmethod
    def validate_email_format(cls, v: str) -> str:
        clean = v.strip().lower()
        if not EMAIL_REGEX.match(clean):
            raise ValueError("Invalid email address format.")
        return clean


class LoginRequest(BaseModel):
    email: str = Field(..., description="Valid email address")
    password: str

    @field_validator("email")
    @classmethod
    def validate_email_format(cls, v: str) -> str:
        clean = v.strip().lower()
        if not EMAIL_REGEX.match(clean):
            raise ValueError("Invalid email address format.")
        return clean


class PasswordResetRequest(BaseModel):
    current_password: str = Field(..., min_length=1, description="Current account password")
    new_password: str = Field(..., min_length=8, description="Minimum 8 characters")


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

@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit(max_requests=20, window_seconds=60))]
)
async def register(req: RegisterRequest):
    existing = sqlite.get_user_by_email(req.email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email address already exists."
        )

    user_id = str(uuid.uuid4())
    hashed_pwd = auth.hash_password(req.password)

    user_record = {
        "id": user_id,
        "email": req.email.lower().strip(),
        "hashed_password": hashed_pwd,
        "full_name": req.full_name
    }
    sqlite.create_user(user_record)

    # Determine tenant entity and role
    if req.invite_entity_id:
        existing_entity = sqlite.get_family_entity(req.invite_entity_id)
        if not existing_entity:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Target family entity '{req.invite_entity_id}' does not exist."
            )
        entity_id = req.invite_entity_id
        assigned_role = "family_member"
    else:
        # Create dedicated, isolated family entity for new registrant
        entity_id = f"fam_{uuid.uuid4().hex[:12]}"
        entity_name = (
            req.family_entity_name.strip()
            if req.family_entity_name and req.family_entity_name.strip()
            else f"{req.full_name}'s Family Office"
        )
        sqlite.create_family_entity({
            "id": entity_id,
            "name": entity_name,
            "entity_type": "Family Trust"
        })
        assigned_role = "family_admin"

    membership_id = str(uuid.uuid4())
    sqlite.create_membership({
        "id": membership_id,
        "user_id": user_id,
        "family_entity_id": entity_id,
        "role": assigned_role
    })

    sqlite.log_audit_event(
        action="USER_REGISTERED",
        user_id=user_id,
        family_entity_id=entity_id,
        resource_id=entity_id,
        details=f"User registered with family role '{assigned_role}'."
    )

    token = auth.create_access_token({"sub": user_id, "email": req.email})
    safe_user = {
        "id": user_id,
        "email": req.email,
        "full_name": req.full_name,
        "memberships": [{"family_entity_id": entity_id, "role": assigned_role}]
    }

    return AuthResponse(access_token=token, user=safe_user)


@router.post(
    "/login",
    response_model=AuthResponse,
    dependencies=[Depends(rate_limit(max_requests=20, window_seconds=60))]
)
async def login(req: LoginRequest):
    user = sqlite.get_user_by_email(req.email)
    if not user:
        # Mitigate timing attack user enumeration by executing constant-time dummy hashing (Audit S11)
        auth.dummy_verify_password(req.password)
        sqlite.log_audit_event(
            action="LOGIN_FAILED",
            user_id=None,
            family_entity_id=None,
            resource_id=None,
            details=f"Invalid credentials attempt for {_mask_email(req.email)}."
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password."
        )

    if not auth.verify_password(req.password, user.get("hashed_password", "")):
        sqlite.log_audit_event(
            action="LOGIN_FAILED",
            user_id=None,
            family_entity_id=None,
            resource_id=None,
            details=f"Invalid credentials attempt for {_mask_email(req.email)}."
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

    primary_entity = memberships[0]["family_entity_id"]
    sqlite.log_audit_event(
        action="LOGIN_SUCCESS",
        user_id=user_id,
        family_entity_id=primary_entity,
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
async def get_audit_trail(
    family_entity_id: Optional[str] = None,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Sovereign Audit Trail:
    Enforces strict tenant isolation and RBAC. Family admins can view entity-scoped audit logs.
    Non-admins are restricted to their own user-scoped events.
    """
    user_memberships = current_user.get("memberships") or []
    admin_entities = [m["family_entity_id"] for m in user_memberships if m.get("role") == "family_admin"]
    member_entities = [m["family_entity_id"] for m in user_memberships]

    if family_entity_id:
        if family_entity_id not in member_entities:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access denied: You do not hold active membership in family entity '{family_entity_id}'."
            )
        if family_entity_id not in admin_entities:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Permission denied: Only family_admin can view entity-wide audit logs."
            )
        return sqlite.get_audit_events_for_entities([family_entity_id], limit=50)

    # If no specific entity requested, return audit trail for the caller's admin entities
    if admin_entities:
        return sqlite.get_audit_events_for_entities(admin_entities, limit=50)

    # Non-admin users are strictly restricted to their own user-scoped audit records
    return sqlite.get_audit_events_for_user(current_user["id"], limit=50)


@router.post("/logout")
async def logout(
    current_user: Dict[str, Any] = Depends(auth.get_current_user),
    auth_cred: Optional[HTTPAuthorizationCredentials] = Security(auth.security)
):
    """
    Session Logout & Token Revocation:
    Blacklists the caller's JWT ID so it cannot be reused.
    """
    user_id = current_user.get("id")
    primary_entity = (current_user.get("memberships") or [{}])[0].get("family_entity_id")
    if auth_cred and auth_cred.credentials:
        try:
            payload = auth.decode_access_token(auth_cred.credentials)
            jti = payload.get("jti")
            if jti:
                sqlite.revoke_token(jti, user_id)
        except Exception:
            pass

    sqlite.log_audit_event(
        action="USER_LOGGED_OUT",
        user_id=user_id,
        family_entity_id=primary_entity,
        details="User logged out."
    )
    return {"message": "Logged out successfully."}


@router.post("/password-reset")
async def reset_password(
    req: PasswordResetRequest,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Password Reset:
    Verifies the user's existing credentials before updating the password hash.
    """
    user_id = current_user["id"]
    primary_entity = (current_user.get("memberships") or [{}])[0].get("family_entity_id")
    db_user = sqlite.get_user_by_id(user_id)
    if not db_user or not auth.verify_password(req.current_password, db_user.get("hashed_password", "")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password verification failed."
        )

    new_hashed = auth.hash_password(req.new_password)
    sqlite.update_user_password(user_id, new_hashed)
    sqlite.log_audit_event(
        action="PASSWORD_RESET",
        user_id=user_id,
        family_entity_id=primary_entity,
        details="User reset their password."
    )
    return {"message": "Password updated successfully."}


@router.delete("/account")
async def delete_account(
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Right to Erasure / Account Deletion (APP 11 / GDPR):
    Permanently erases user account and cascades memberships.
    """
    user_id = current_user["id"]
    primary_entity = (current_user.get("memberships") or [{}])[0].get("family_entity_id")
    sqlite.log_audit_event(
        action="ACCOUNT_DELETED",
        user_id=user_id,
        family_entity_id=primary_entity,
        details="User permanently erased their account."
    )
    sqlite.delete_user_account(user_id)
    return {"message": "User account permanently deleted."}
