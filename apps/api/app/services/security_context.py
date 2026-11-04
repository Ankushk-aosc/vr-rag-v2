"""FastAPI-facing security context.

A thin adapter over app/services/authorization.py, which owns every role, permission and policy
decision. Routers depend on `get_security_context` / `require_permission`; nothing here keeps its own
copy of the rules.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, FrozenSet, List, Optional

from fastapi import Depends, HTTPException, Query, Request, status

from app.services import auth, authorization
from app.services.authorization import Subject


class Role(str, Enum):
    FAMILY_ADMIN = authorization.FAMILY_ADMIN
    FAMILY_MEMBER = authorization.FAMILY_MEMBER
    READ_ONLY_ADVISER = authorization.READ_ONLY_ADVISER


class Permission(str, Enum):
    DOCUMENT_READ = authorization.DOCUMENT_READ
    DOCUMENT_UPLOAD = authorization.DOCUMENT_UPLOAD
    DOCUMENT_DELETE = authorization.DOCUMENT_DELETE
    QUERY_EXECUTE = authorization.QUERY_EXECUTE
    AUDIT_READ = authorization.AUDIT_READ
    USERS_MANAGE = authorization.USERS_MANAGE
    INVITES_MANAGE = authorization.INVITES_MANAGE
    CONVERSATIONS_READ = authorization.CONVERSATIONS_READ
    CONVERSATIONS_CREATE = authorization.CONVERSATIONS_CREATE
    CONVERSATIONS_DELETE = authorization.CONVERSATIONS_DELETE


ROLE_PERMISSIONS = authorization.ROLE_PERMISSIONS


@dataclass(frozen=True)
class SecurityContext:
    subject: Subject

    @property
    def user_id(self) -> str:
        return self.subject.user_id

    @property
    def tenant_id(self) -> str:
        return self.subject.family_entity_id

    @property
    def roles(self) -> List[str]:
        return [self.subject.role]

    @property
    def permissions(self) -> FrozenSet[str]:
        return self.subject.permissions

    @property
    def email(self) -> Optional[str]:
        return self.subject.email

    def has_role(self, role: str) -> bool:
        return self.subject.role == role

    def has_permission(self, permission: str) -> bool:
        return authorization.check_rbac(self.subject, permission)


def build_security_context(user: Dict[str, Any], requested_tenant_id: Optional[str] = None) -> SecurityContext:
    """Tenant is resolved from the user's own memberships; a requested id only selects among them."""
    return SecurityContext(authorization.resolve_subject(user, requested_tenant_id))


async def get_security_context(
    request: Request,
    family_entity_id: Optional[str] = Query(None, alias="tenant_id"),
    current_user: Dict[str, Any] = Depends(auth.get_current_user),
) -> SecurityContext:
    return build_security_context(current_user, family_entity_id or request.headers.get("x-tenant-id"))


def require_permission(permission: str):
    """Dependency enforcing RBAC AND ABAC (tenant scope) for `permission`."""
    def dependency(sec: SecurityContext = Depends(get_security_context)) -> SecurityContext:
        authorization.authorize(sec.subject, permission)
        return sec
    return dependency


def require_role(allowed_roles: List[str]):
    def dependency(sec: SecurityContext = Depends(get_security_context)) -> SecurityContext:
        if sec.subject.role not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=authorization.DENIED)
        return sec
    return dependency
