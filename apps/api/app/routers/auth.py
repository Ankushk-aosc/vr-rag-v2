import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator
from app.services import auth, authorization, pinecone_service
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
    invite_token: Optional[str] = Field(None, description="Invite issued by a family_admin via POST /api/auth/invites")
    invite_entity_id: Optional[str] = Field(
        None, description="Deprecated: only accepted alongside a matching invite_token"
    )

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


class InviteRequest(BaseModel):
    family_entity_id: str = Field(..., description="Family entity the invitee will join")
    role: Literal["family_member", "read_only_adviser"] = "family_member"
    expires_in_hours: int = Field(72, ge=1, le=auth.INVITE_MAX_HOURS)


class InviteResponse(BaseModel):
    invite_token: str
    family_entity_id: str
    role: str
    expires_at: str


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

# Serialises check-then-claim of single-use invites within this process
_invite_claim_lock = threading.Lock()


def _validate_invite(invite_token: Optional[str], invite_entity_id: Optional[str]) -> Dict[str, Any]:
    if not invite_token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Joining an existing family requires an invite issued by a family_admin."
        )
    payload = auth.decode_invite_token(invite_token)
    entity_id = payload["fam"]
    if invite_entity_id and invite_entity_id != entity_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invite does not match the requested family.")
    if sqlite.is_token_revoked(payload["jti"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Family invite has already been used or revoked.")
    if not sqlite.get_family_entity(entity_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid family invite.")
    # The inviter must still administer the family at redemption time
    inviter_memberships = sqlite.get_user_memberships(payload.get("inv") or "")
    if not any(m["family_entity_id"] == entity_id and m.get("role") == "family_admin" for m in inviter_memberships):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Family invite is no longer valid.")
    return payload


def _claim_invite(invite: Dict[str, Any], user_id: str) -> None:
    """Marks the invite as used before the account is created so it cannot be redeemed twice."""
    expires_at = datetime.fromtimestamp(invite["exp"], tz=timezone.utc).isoformat()
    with _invite_claim_lock:
        if sqlite.is_token_revoked(invite["jti"]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Family invite has already been used or revoked.")
        sqlite.revoke_token(invite["jti"], user_id, expires_at)


@router.post(
    "/invites",
    response_model=InviteResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit(max_requests=20, window_seconds=60))]
)
async def create_invite(
    req: InviteRequest,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """Family admins issue single-use, expiring invites for new members or read-only advisers."""
    # RBAC invites.manage (family admins) AND ABAC (the caller's own family)
    subject = authorization.resolve_subject(current_user, req.family_entity_id, action=authorization.INVITES_MANAGE)
    authorization.authorize(subject, authorization.INVITES_MANAGE)

    issued = auth.create_invite_token(req.family_entity_id, req.role, current_user["id"], req.expires_in_hours)
    sqlite.log_audit_event(
        action="INVITE_CREATED",
        user_id=current_user["id"],
        family_entity_id=req.family_entity_id,
        resource_id=issued["jti"],
        details=f"Invite issued for role '{req.role}', expires {issued['expires_at']}."
    )
    return InviteResponse(
        invite_token=issued["token"],
        family_entity_id=req.family_entity_id,
        role=req.role,
        expires_at=issued["expires_at"],
    )


@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit(max_requests=20, window_seconds=60, per="ip"))]
)
async def register(req: RegisterRequest, response: Response):
    existing = sqlite.get_user_by_email(req.email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email address already exists."
        )

    # Joining an existing family requires a valid invite; never trust a bare entity ID (Audit I-01).
    # Validate before creating the user so a rejected invite leaves no orphan account behind.
    invite = _validate_invite(req.invite_token, req.invite_entity_id) if (req.invite_token or req.invite_entity_id) else None

    user_id = str(uuid.uuid4())
    hashed_pwd = auth.hash_password(req.password)

    if invite:
        _claim_invite(invite, user_id)

    user_record = {
        "id": user_id,
        "email": req.email.lower().strip(),
        "hashed_password": hashed_pwd,
        "full_name": req.full_name
    }
    sqlite.create_user(user_record)

    # Determine tenant entity and role
    if invite:
        entity_id = invite["fam"]
        assigned_role = invite["role"]
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
        details=(
            f"User registered with family role '{assigned_role}'"
            + (f" via invite from user {invite['inv']}." if invite else ".")
        )
    )

    token = auth.issue_access_token({"id": user_id, "email": req.email, "token_version": 0})
    safe_user = {
        "id": user_id,
        "email": req.email,
        "full_name": req.full_name,
        "memberships": [{"family_entity_id": entity_id, "role": assigned_role}]
    }

    if response:
        response.set_cookie(
            key="aether_session",
            value=token,
            httponly=True,
            secure=False,
            samesite="lax",
            max_age=auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            path="/",
        )
    return AuthResponse(access_token=token, user=safe_user)


@router.post(
    "/login", 
    response_model=AuthResponse,
    dependencies=[Depends(rate_limit(max_requests=20, window_seconds=60, per="ip"))]
)
async def login(req: LoginRequest, response: Response):
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

    token = auth.issue_access_token(user)
    safe_user = {
        "id": user_id,
        "email": user["email"],
        "full_name": user.get("full_name", ""),
        "memberships": memberships
    }

    if response:
        response.set_cookie(
            key="aether_session",
            value=token,
            httponly=True,
            secure=False,
            samesite="lax",
            max_age=auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            path="/",
        )
    return AuthResponse(access_token=token, user=safe_user)


@router.post("/refresh", response_model=AuthResponse)
async def refresh_session(
    response: Response,
    current_user: Dict[str, Any] = Depends(auth.get_current_user),
):
    """Refreshes the caller's session and updates HttpOnly cookie."""
    token = auth.issue_access_token(current_user)
    response.set_cookie(
        key="aether_session",
        value=token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )
    safe_user = current_user.copy()
    safe_user.pop("hashed_password", None)
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
    if family_entity_id:
        # RBAC audit.read (family admins) AND ABAC (the caller's own family)
        subject = authorization.resolve_subject(current_user, family_entity_id, action=authorization.AUDIT_READ)
        authorization.authorize(subject, authorization.AUDIT_READ)
        return sqlite.get_audit_events_for_entities([family_entity_id], limit=50)

    admin_entities = [
        m["family_entity_id"] for m in current_user.get("memberships") or []
        if authorization.AUDIT_READ in authorization.ROLE_PERMISSIONS.get(m.get("role"), frozenset())
    ]

    # If no specific entity requested, return audit trail for the caller's admin entities
    if admin_entities:
        return sqlite.get_audit_events_for_entities(admin_entities, limit=50)

    # Non-admin users are strictly restricted to their own user-scoped audit records
    return sqlite.get_audit_events_for_user(current_user["id"], limit=50)


@router.post("/logout")
async def logout(
    response: Response,
    current_user: Dict[str, Any] = Depends(auth.get_current_user),
    auth_cred: Optional[HTTPAuthorizationCredentials] = Security(auth.security),
):
    response.delete_cookie(key="aether_session", path="/")
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
    # Bumping the session version signs out every other device, and this one's old token (Audit I-15)
    new_version = sqlite.update_user_password(user_id, new_hashed)
    sqlite.log_audit_event(
        action="PASSWORD_RESET",
        user_id=user_id,
        family_entity_id=primary_entity,
        details="User reset their password; all other sessions were signed out."
    )
    # Keep the device that made the change signed in with a token for the new version
    token = auth.issue_access_token({**db_user, "token_version": new_version})
    return {
        "message": "Password updated successfully. You have been signed out on all other devices.",
        "access_token": token,
        "token_type": "bearer",
    }


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
