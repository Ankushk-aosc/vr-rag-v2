"""
Centralized authorization: RBAC AND ABAC, evaluated before any retrieval.

Every request that touches family data follows the same path:

    JWT -> current user -> resolve_subject (tenant from server-side memberships)
        -> authorize(subject, action, resource)  = check_rbac AND check_abac, fail closed
        -> build_access_scope(subject)            = authorized document ids, computed in the database
        -> retrieval (pgvector / local / Pinecone / BM25 / tsvector) restricted to that scope
        -> LLM sees only scoped chunks -> validate_citations against the scope

The LLM is never the security boundary: prompts may repeat these rules as defence in depth, but by
the time a prompt is built, unauthorized text has already been excluded from the candidate set.
"""
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Tuple

from fastapi import HTTPException, status

from app.db import sqlite

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- roles and permissions (RBAC)

FAMILY_ADMIN = "family_admin"
FAMILY_MEMBER = "family_member"
READ_ONLY_ADVISER = "read_only_adviser"
KNOWN_ROLES = (FAMILY_ADMIN, FAMILY_MEMBER, READ_ONLY_ADVISER)

DOCUMENT_READ = "document.read"
DOCUMENT_UPLOAD = "document.upload"
DOCUMENT_DELETE = "document.delete"
QUERY_EXECUTE = "query.execute"
AUDIT_READ = "audit.read"
USERS_MANAGE = "users.manage"
INVITES_MANAGE = "invites.manage"
CONVERSATIONS_READ = "conversations.read"
CONVERSATIONS_CREATE = "conversations.create"
CONVERSATIONS_DELETE = "conversations.delete"

ROLE_PERMISSIONS: Dict[str, FrozenSet[str]] = {
    FAMILY_ADMIN: frozenset({
        DOCUMENT_READ, DOCUMENT_UPLOAD, DOCUMENT_DELETE, QUERY_EXECUTE, AUDIT_READ, USERS_MANAGE,
        INVITES_MANAGE, CONVERSATIONS_READ, CONVERSATIONS_CREATE, CONVERSATIONS_DELETE,
    }),
    FAMILY_MEMBER: frozenset({
        DOCUMENT_READ, DOCUMENT_UPLOAD, QUERY_EXECUTE,
        CONVERSATIONS_READ, CONVERSATIONS_CREATE, CONVERSATIONS_DELETE,
    }),
    READ_ONLY_ADVISER: frozenset({
        DOCUMENT_READ, QUERY_EXECUTE, CONVERSATIONS_READ, CONVERSATIONS_CREATE,
    }),
}

# ---------------------------------------------------------------- classification (ABAC attribute)

INTERNAL, CONFIDENTIAL, RESTRICTED = "internal", "confidential", "restricted"
CLASSIFICATIONS = (INTERNAL, CONFIDENTIAL, RESTRICTED)
DEFAULT_CLASSIFICATION = CONFIDENTIAL

# Which classifications each role may read or create. Restricted = family admins only, which is
# exactly the pre-existing "admin-only" document ACL; advisers keep reading family-wide records.
ROLE_CLEARANCE: Dict[str, Tuple[str, ...]] = {
    FAMILY_ADMIN: (INTERNAL, CONFIDENTIAL, RESTRICTED),
    FAMILY_MEMBER: (INTERNAL, CONFIDENTIAL),
    READ_ONLY_ADVISER: (INTERNAL, CONFIDENTIAL),
}

# Actions whose resource must belong to the caller unless they are a family admin. None of today's
# endpoints needs this (delete is admin-only by RBAC), but the rule is enforced if one is added.
OWNER_ONLY_ACTIONS: FrozenSet[str] = frozenset()

DENIED = "Access denied."


def acl_role_for(classification: str) -> str:
    """The document_acl row that mirrors a classification (kept for the role-tagged vector stores)."""
    return FAMILY_ADMIN if classification == RESTRICTED else FAMILY_MEMBER


def classification_for_acl(allowed_role: str) -> str:
    return RESTRICTED if allowed_role == FAMILY_ADMIN else CONFIDENTIAL


# ---------------------------------------------------------------- subject, resource, scope

@dataclass(frozen=True)
class Subject:
    user_id: str
    family_entity_id: str
    role: str
    email: Optional[str] = None

    @property
    def permissions(self) -> FrozenSet[str]:
        return ROLE_PERMISSIONS.get(self.role, frozenset())


@dataclass(frozen=True)
class Resource:
    type: str  # "document" | "family_entity" | "audit" | ...
    id: Optional[str]
    family_entity_id: Optional[str]
    owner_id: Optional[str] = None
    classification: Optional[str] = None


@dataclass(frozen=True)
class AccessScope:
    """What one request may see. Built before retrieval; every search is restricted to it."""
    user_id: str
    family_entity_id: str
    role: str
    allowed_actions: FrozenSet[str]
    allowed_classifications: Tuple[str, ...]
    allowed_document_ids: FrozenSet[str] = field(default_factory=frozenset)

    @property
    def retrieval_roles(self) -> List[str]:
        """Role tags carried by vector records (Pinecone / local index). Ingestion tags every record
        with family_admin and family-wide ones also with family_member; advisers read via the member tag."""
        if self.role == FAMILY_ADMIN:
            return [FAMILY_ADMIN]
        return [FAMILY_MEMBER] if self.role in KNOWN_ROLES else []

    @property
    def is_empty(self) -> bool:
        return not self.allowed_document_ids


EMPTY_SCOPE_ROLE = "none"


def empty_scope(family_entity_id: str = "", user_id: str = "") -> AccessScope:
    return AccessScope(user_id, family_entity_id, EMPTY_SCOPE_ROLE, frozenset(), (), frozenset())


# ---------------------------------------------------------------- auditing

def audit_denied(subject_or_user: Any, action: str, resource: Optional[Resource], reason: str) -> None:
    """Records ACCESS_DENIED with who / what / why. Never logs content, prompts or tokens."""
    user_id = getattr(subject_or_user, "user_id", None) or (
        subject_or_user.get("id") if isinstance(subject_or_user, dict) else None
    )
    family = getattr(subject_or_user, "family_entity_id", None) or (resource.family_entity_id if resource else None)
    details = (
        f"action={action}; resource_type={resource.type if resource else '-'}; "
        f"resource_family={resource.family_entity_id if resource else '-'}; decision=deny; reason={reason}"
    )
    try:
        sqlite.log_audit_event(
            action="ACCESS_DENIED",
            user_id=user_id,
            family_entity_id=family,
            resource_id=resource.id if resource else None,
            details=details,
        )
    except Exception as e:  # auditing must never turn a denial into an allow or a 500
        logger.warning("Could not record ACCESS_DENIED audit event: %s", type(e).__name__)


def _deny(subject_or_user: Any, action: str, resource: Optional[Resource], reason: str) -> HTTPException:
    audit_denied(subject_or_user, action, resource, reason)
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=DENIED)


# ---------------------------------------------------------------- tenant resolution

def resolve_subject(user: Optional[Dict[str, Any]], requested_family_entity_id: Optional[str] = None,
                    action: str = "tenant.resolve") -> Subject:
    """
    The tenant comes from the user's server-side memberships, never from the request alone.
    A client may name one of its own families (users can belong to several); anything it is not a
    member of is denied. With no selection, the first membership is used.
    """
    if not user or not user.get("id"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    memberships = user.get("memberships") or []
    if requested_family_entity_id:
        membership = next((m for m in memberships if m.get("family_entity_id") == requested_family_entity_id), None)
    else:
        membership = memberships[0] if memberships else None
    if not membership:
        resource = Resource("family_entity", requested_family_entity_id, requested_family_entity_id)
        raise _deny(user, action, resource, "not_a_member")
    role = membership.get("role")
    if role not in KNOWN_ROLES:  # unknown roles get nothing (fail closed)
        raise _deny(user, action, None, "unknown_role")
    return Subject(user_id=user["id"], family_entity_id=membership["family_entity_id"], role=role,
                   email=user.get("email"))


# ---------------------------------------------------------------- policy evaluation

def check_rbac(subject: Subject, action: str) -> bool:
    return action in subject.permissions


def check_abac(subject: Subject, action: str, resource: Optional[Resource]) -> Tuple[bool, str]:
    """Subject x resource x action. Returns (allowed, reason). Anything undeterminable is denied."""
    target = resource or Resource("family_entity", subject.family_entity_id, subject.family_entity_id)
    if not target.family_entity_id or target.family_entity_id != subject.family_entity_id:
        return False, "tenant_mismatch"
    if target.type == "document":
        cls = (target.classification or "").lower()
        if cls not in CLASSIFICATIONS:
            return False, "unknown_classification"
        if cls not in ROLE_CLEARANCE.get(subject.role, ()):
            return False, "classification_not_permitted"
        if action in OWNER_ONLY_ACTIONS and subject.role != FAMILY_ADMIN and target.owner_id != subject.user_id:
            return False, "not_owner"
    return True, "ok"


def authorize(subject: Subject, action: str, resource: Optional[Resource] = None) -> None:
    """RBAC AND ABAC. Raises 403 (and audits) unless both allow."""
    if not subject:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    if not check_rbac(subject, action):
        raise _deny(subject, action, resource, "rbac")
    allowed, reason = check_abac(subject, action, resource)
    if not allowed:
        raise _deny(subject, action, resource, reason)


def is_authorized(subject: Subject, action: str, resource: Optional[Resource] = None) -> bool:
    """Same decision as authorize() without raising or auditing (for filtering lists)."""
    return check_rbac(subject, action) and check_abac(subject, action, resource)[0]


# ---------------------------------------------------------------- scopes

def build_access_scope(subject: Subject, action: str = QUERY_EXECUTE) -> AccessScope:
    """Authorizes `action` for the tenant, then resolves the readable document ids in the database."""
    authorize(subject, action)
    authorize(subject, DOCUMENT_READ)
    classes = ROLE_CLEARANCE.get(subject.role, ())
    doc_ids = frozenset(sqlite.get_authorized_document_ids(subject.family_entity_id, list(classes)))
    return AccessScope(
        user_id=subject.user_id,
        family_entity_id=subject.family_entity_id,
        role=subject.role,
        allowed_actions=subject.permissions,
        allowed_classifications=classes,
        allowed_document_ids=doc_ids,
    )


def authorize_query(user: Dict[str, Any], requested_family_entity_id: Optional[str] = None) -> AccessScope:
    """Entry point for /api/query, /api/query/stream, voice and dashboards."""
    subject = resolve_subject(user, requested_family_entity_id, action=QUERY_EXECUTE)
    return build_access_scope(subject, QUERY_EXECUTE)


def scope_for_roles(family_entity_id: str, user_roles: Iterable[str], user_id: str = "") -> AccessScope:
    """
    Scope for internal callers that already resolved tenant and roles (legacy rag_engine signature).
    The strongest known role wins; an unknown role set yields an empty scope (nothing retrievable).
    """
    roles = set(user_roles or [])
    role = next((r for r in KNOWN_ROLES if r in roles), None)
    if not family_entity_id or not role:
        return empty_scope(family_entity_id, user_id)
    classes = ROLE_CLEARANCE[role]
    ids = frozenset(sqlite.get_authorized_document_ids(family_entity_id, list(classes)))
    return AccessScope(user_id, family_entity_id, role, ROLE_PERMISSIONS[role], classes, ids)


# ---------------------------------------------------------------- documents

def deny_unknown_resource(user: Any, action: str, resource_type: str, resource_id: Optional[str]) -> HTTPException:
    """Unknown ids are denied exactly like forbidden ones (same status and body), and audited."""
    return _deny(user, action, Resource(resource_type, resource_id, None), "unknown_resource")


def document_resource(doc: Dict[str, Any]) -> Resource:
    # A record without a classification is never assumed to be the default tier: it is treated as
    # restricted (admins only), so a data-layer omission can only narrow access, not widen it
    return Resource(
        type="document",
        id=doc.get("id"),
        family_entity_id=doc.get("family_entity_id"),
        owner_id=doc.get("owner_user_id"),
        classification=doc.get("classification") or RESTRICTED,
    )


def authorize_document(user: Dict[str, Any], document_id: str, action: str = DOCUMENT_READ) -> Tuple[Subject, Dict[str, Any]]:
    """
    Loads one document from the SQL system of record and authorizes `action` on it.
    A missing, failed or other-family document gets the same 403 "Access denied.", so a caller cannot
    tell whether an id exists anywhere outside their own scope.
    """
    doc = sqlite.get_document_by_id(document_id)
    if not doc or doc.get("status") == "failed":
        raise deny_unknown_resource(user, action, "document", document_id)
    resource = document_resource(doc)
    subject = resolve_subject(user, resource.family_entity_id, action=action)
    authorize(subject, action, resource)
    return subject, doc


# ---------------------------------------------------------------- citations

def validate_citations(citations: List[Dict[str, Any]], scope: AccessScope) -> List[Dict[str, Any]]:
    """Drops any citation whose document is outside the scope. Retrieval already guarantees this;
    the check makes a regression or a model-invented reference unable to reach the client."""
    kept = [c for c in citations or [] if c.get("document_id") in scope.allowed_document_ids]
    dropped = len(citations or []) - len(kept)
    if dropped:
        logger.warning("Removed %d citation(s) outside the access scope for family %s", dropped, scope.family_entity_id)
    return kept


def filter_chunks_to_scope(chunks: List[Dict[str, Any]], scope: AccessScope) -> List[Dict[str, Any]]:
    """Defence in depth after retrieval: keeps only chunks of authorized documents of this tenant."""
    out = []
    for c in chunks or []:
        meta = c.get("metadata") or {}
        doc_id = c.get("document_id") or meta.get("document_id")
        fam = c.get("family_entity_id") or meta.get("family_entity_id") or scope.family_entity_id
        if doc_id in scope.allowed_document_ids and fam == scope.family_entity_id:
            out.append(c)
    return out
