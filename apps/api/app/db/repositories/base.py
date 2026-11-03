from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


class BaseUserRepository(ABC):
    @abstractmethod
    def create_user(self, user: Dict[str, Any]) -> None: ...

    @abstractmethod
    def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]: ...

    @abstractmethod
    def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]: ...

    @abstractmethod
    def update_user_password(self, user_id: str, hashed_password: str) -> int:
        """Stores the new hash and bumps token_version in one statement. Returns the new version."""
        ...

    @abstractmethod
    def delete_user_account(self, user_id: str) -> bool: ...

    @abstractmethod
    def seed_default_demo_admin(self) -> None: ...


class BaseFamilyRepository(ABC):
    @abstractmethod
    def create_family_entity(self, entity: Dict[str, Any]) -> None: ...

    @abstractmethod
    def get_family_entity(self, entity_id: str) -> Optional[Dict[str, Any]]: ...

    @abstractmethod
    def create_membership(self, membership: Dict[str, Any]) -> None: ...

    @abstractmethod
    def get_user_memberships(self, user_id: str) -> List[Dict[str, Any]]: ...


class DuplicateDocumentError(Exception):
    """The family already has a document with this file hash (UNIQUE(family_entity_id, file_hash)).
    Raised by insert_document so the database constraint, not a prior read, decides duplicates (Audit I-24)."""


class BaseDocumentRepository(ABC):
    @abstractmethod
    def get_document_by_hash(self, family_entity_id: str, file_hash: str) -> Optional[Dict[str, Any]]: ...

    @abstractmethod
    def insert_document(self, doc: Dict[str, Any]) -> None: ...

    @abstractmethod
    def update_document_status(self, document_id: str, status: str) -> None: ...

    @abstractmethod
    def delete_document(self, document_id: str) -> bool: ...

    @abstractmethod
    def insert_document_acl(self, document_id: str, family_entity_id: str, allowed_role: str) -> None: ...

    @abstractmethod
    def get_document_allowed_roles(self, document_id: str, family_entity_id: str) -> List[str]: ...

    @abstractmethod
    def insert_chunks(self, chunks: List[Dict[str, Any]]) -> None: ...

    @abstractmethod
    def get_chunks_by_ids(self, chunk_ids: List[str]) -> List[Dict[str, Any]]: ...

    @abstractmethod
    def get_chunk_ids_for_document(self, document_id: str, family_entity_id: str) -> List[str]: ...

    @abstractmethod
    def get_documents_by_entity(self, entity_id: str, user_role: str) -> List[Dict[str, Any]]: ...

    @abstractmethod
    def get_all_documents(self) -> List[Dict[str, Any]]: ...

    @abstractmethod
    def get_lexical_chunks(self) -> List[Dict[str, Any]]:
        """Every chunk with its tenant, document name and ACL role, for rebuilding the keyword index.
        Cross-tenant: callers partition the rows by family_entity_id before any search (Audit I-28)."""

    @abstractmethod
    def get_document_by_id(self, doc_id: str) -> Optional[Dict[str, Any]]: ...

    @abstractmethod
    def get_document_names(self, family_entity_id: str) -> Dict[str, str]:
        """document_id -> display name for one family; {} without a family (Audit I-20)."""


class BaseAuditRepository(ABC):
    @abstractmethod
    def log_audit_event(
        self,
        action: str,
        user_id: Optional[str] = None,
        family_entity_id: Optional[str] = None,
        resource_id: Optional[str] = None,
        details: Optional[str] = None,
    ) -> None: ...

    @abstractmethod
    def get_audit_events_for_entities(self, entity_ids: List[str], limit: int = 50) -> List[Dict[str, Any]]: ...

    @abstractmethod
    def get_audit_events_for_user(self, user_id: str, limit: int = 50) -> List[Dict[str, Any]]: ...

    @abstractmethod
    def get_audit_events(self, limit: int = 50, family_entity_id: Optional[str] = None) -> List[Dict[str, Any]]: ...


class BaseTokenRepository(ABC):
    @abstractmethod
    def revoke_token(self, jti: str, user_id: str, expires_at: Optional[str] = None) -> None: ...

    @abstractmethod
    def is_token_revoked(self, jti: str) -> bool: ...

    @abstractmethod
    def cleanup_expired_tokens(self) -> int: ...


class BaseLocalIndexRepository(ABC):
    """Local vector index + document display metadata (Audit I-09, PRIVACY_MODE=local)."""

    @abstractmethod
    def upsert_chunk_vectors(self, rows: List[Dict[str, Any]]) -> int:
        """rows: chunk_id, document_id, family_entity_id, allowed_roles (list), embedder_model,
        embedding_dim, embedding (float32 bytes). Returns the number written."""
        ...

    @abstractmethod
    def get_chunk_vectors(self, family_entity_id: str) -> List[Dict[str, Any]]:
        """All vectors of one tenant: chunk_id, document_id, allowed_roles (list), embedding (bytes)."""
        ...

    @abstractmethod
    def delete_chunk_vectors(self, document_id: str, family_entity_id: str) -> int: ...

    @abstractmethod
    def get_chunks_without_vectors(self, family_entity_id: str) -> List[Dict[str, Any]]:
        """Chunks of one tenant with no local vector: id, document_id, content, allowed_role."""
        ...

    @abstractmethod
    def upsert_document_meta(self, document_id: str, family_entity_id: str, meta: Dict[str, Any]) -> None: ...

    @abstractmethod
    def get_document_meta(self, document_id: str) -> Optional[Dict[str, Any]]: ...

    @abstractmethod
    def list_document_meta(self, family_entity_id: str) -> Dict[str, Dict[str, Any]]: ...
