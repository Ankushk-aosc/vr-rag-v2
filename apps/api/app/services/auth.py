import hashlib
import hmac
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
import jwt
from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from app.config import settings
from app.services import pinecone_service

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours

security = HTTPBearer(auto_error=False)


PBKDF2_ITERATIONS = 600_000

# Precomputed dummy hash parameters for constant-time failure mitigation (Audit S11)
_DUMMY_SALT = "0" * 32
_DUMMY_HASH = hashlib.pbkdf2_hmac(
    "sha256",
    b"dummy_timing_mitigation_secret",
    _DUMMY_SALT.encode("utf-8"),
    PBKDF2_ITERATIONS
).hex()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITERATIONS
    )
    return f"{PBKDF2_ITERATIONS}${salt}${key.hex()}"


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        parts = hashed_password.split("$")
        if len(parts) == 3:
            iterations, salt, expected_hex = int(parts[0]), parts[1], parts[2]
        elif len(parts) == 2:
            iterations, salt, expected_hex = 100_000, parts[0], parts[1]
        else:
            return False

        calculated = hashlib.pbkdf2_hmac(
            "sha256",
            plain_password.encode("utf-8"),
            salt.encode("utf-8"),
            iterations
        )
        return hmac.compare_digest(calculated.hex(), expected_hex)
    except Exception:
        return False


def dummy_verify_password(plain_password: str) -> bool:
    """
    Constant-time dummy password hashing on user miss to prevent timing-based user enumeration (Audit S11).
    Always returns False.
    """
    try:
        calculated = hashlib.pbkdf2_hmac(
            "sha256",
            plain_password.encode("utf-8"),
            _DUMMY_SALT.encode("utf-8"),
            PBKDF2_ITERATIONS
        )
        hmac.compare_digest(calculated.hex(), _DUMMY_HASH)
    except Exception:
        pass
    return False


def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    if "jti" not in to_encode:
        to_encode["jti"] = str(uuid.uuid4())
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.APP_SECRET_KEY, algorithm=ALGORITHM)


def issue_access_token(user: Dict[str, Any]) -> str:
    """Access token bound to the user's current session version (Audit I-15)."""
    return create_access_token({
        "sub": user["id"],
        "email": user["email"],
        "ver": int(user.get("token_version") or 0),
    })


def decode_access_token(token: str) -> Dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.APP_SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired. Please log in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization token.")


# Family invites (Audit I-01): joining an existing family requires a signed, single-use,
# expiring token issued by a family_admin of that family.
INVITE_TOKEN_TYPE = "family_invite"
INVITABLE_ROLES = ("family_member", "read_only_adviser")
INVITE_MAX_HOURS = 168


def create_invite_token(family_entity_id: str, role: str, inviter_id: str, expires_hours: int) -> Dict[str, Any]:
    if role not in INVITABLE_ROLES:
        raise ValueError(f"Role '{role}' cannot be granted by invite.")
    hours = max(1, min(int(expires_hours), INVITE_MAX_HOURS))
    expires_at = datetime.now(timezone.utc) + timedelta(hours=hours)
    jti = str(uuid.uuid4())
    token = jwt.encode(
        {
            "typ": INVITE_TOKEN_TYPE,
            "fam": family_entity_id,
            "role": role,
            "inv": inviter_id,
            "jti": jti,
            "exp": expires_at,
        },
        settings.APP_SECRET_KEY,
        algorithm=ALGORITHM,
    )
    return {"token": token, "jti": jti, "expires_at": expires_at.isoformat()}


def decode_invite_token(token: str) -> Dict[str, Any]:
    """Validates signature, expiry and token type. Raises 403 on any failure (fail closed)."""
    try:
        payload = jwt.decode(token, settings.APP_SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Family invite has expired.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid family invite.")
    if (
        payload.get("typ") != INVITE_TOKEN_TYPE
        or not payload.get("fam")
        or not payload.get("jti")
        or payload.get("role") not in INVITABLE_ROLES
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid family invite.")
    return payload


async def get_current_user_optional(
    auth_cred: Optional[HTTPAuthorizationCredentials] = Security(security)
) -> Optional[Dict[str, Any]]:
    if not auth_cred:
        return None
    payload = decode_access_token(auth_cred.credentials)
    # Invite (or any other typed) tokens must never authenticate API calls
    if payload.get("typ") not in (None, "access"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization token.")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject identifier."
        )
    
    # Query transactional system of record
    from app.db import sqlite
    jti = payload.get("jti")
    if jti and sqlite.is_token_revoked(jti):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization token has been revoked. Please log in again."
        )
    user = sqlite.get_user_by_id(user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found or deactivated. Access denied."
        )
    # Tokens issued before the last password change are dead (Audit I-15). Tokens minted before
    # versioning existed carry no `ver` and count as version 0.
    if int(payload.get("ver") or 0) != int(user.get("token_version") or 0):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your password was changed. Please log in again."
        )
    user.pop("token_version", None)

    # Derive real memberships strictly from system of record (fail closed, never default to admin)
    memberships = sqlite.get_user_memberships(user_id)
    user["memberships"] = memberships
    return user


async def get_current_user(
    auth_cred: Optional[HTTPAuthorizationCredentials] = Security(security)
) -> Dict[str, Any]:
    if not auth_cred:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please provide a valid Bearer token."
        )
    user = await get_current_user_optional(auth_cred)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found or invalid token."
        )
    return user
