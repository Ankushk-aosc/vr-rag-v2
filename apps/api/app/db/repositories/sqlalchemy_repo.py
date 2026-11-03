import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import joinedload

from app.config import settings
from app.db.models import (
    AuditEventModel,
    DocumentAclModel,
    DocumentChunkModel,
    DocumentModel,
    FamilyEntityModel,
    MembershipModel,
    RevokedTokenModel,
    UserModel,
)
from app.db.repositories.base import (
    BaseAuditRepository,
    BaseDocumentRepository,
    BaseFamilyRepository,
    DuplicateDocumentError,
    BaseTokenRepository,
    BaseUserRepository,
)
from app.db.session import get_db_session


def _dt_to_str(dt: Any) -> Any:
    if isinstance(dt, datetime):
        return dt.isoformat()
    return dt


def _user_to_dict(user: UserModel) -> Dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "hashed_password": user.hashed_password,
        "full_name": user.full_name,
        "token_version": user.token_version or 0,
        "created_at": _dt_to_str(user.created_at),
    }


def _family_to_dict(entity: FamilyEntityModel) -> Dict[str, Any]:
    return {
        "id": entity.id,
        "name": entity.name,
        "entity_type": entity.entity_type,
        "created_at": _dt_to_str(entity.created_at),
    }


def _doc_to_dict(doc: DocumentModel) -> Dict[str, Any]:
    return {
        "id": doc.id,
        "filename": doc.filename,
        "original_name": doc.original_name,
        "mime_type": doc.mime_type,
        "file_size": doc.file_size,
        "file_hash": doc.file_hash,
        "total_pages": doc.total_pages,
        "family_entity_id": doc.family_entity_id,
        "status": doc.status,
        "uploaded_at": _dt_to_str(doc.uploaded_at),
    }


def _audit_to_dict(a: AuditEventModel) -> Dict[str, Any]:
    return {
        "id": a.id,
        "user_id": a.user_id,
        "family_entity_id": a.family_entity_id,
        "action": a.action,
        "resource_id": a.resource_id,
        "details": a.details,
        "timestamp": _dt_to_str(a.timestamp),
    }


class SqlAlchemyUserRepository(BaseUserRepository):
    def create_user(self, user: Dict[str, Any]) -> None:
        with get_db_session() as session:
            db_user = UserModel(
                id=user["id"],
                email=user["email"].lower().strip(),
                hashed_password=user["hashed_password"],
                full_name=user["full_name"],
            )
            session.add(db_user)

    def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        with get_db_session() as session:
            stmt = select(UserModel).where(UserModel.email == email.lower().strip())
            user = session.scalars(stmt).first()
            return _user_to_dict(user) if user else None

    def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        with get_db_session() as session:
            user = session.get(UserModel, user_id)
            return _user_to_dict(user) if user else None

    def update_user_password(self, user_id: str, hashed_password: str) -> int:
        with get_db_session() as session:
            stmt = (
                update(UserModel)
                .where(UserModel.id == user_id)
                .values(hashed_password=hashed_password, token_version=UserModel.token_version + 1)
                .returning(UserModel.token_version)
            )
            version = session.execute(stmt).scalar_one_or_none()
            return int(version or 0)

    def delete_user_account(self, user_id: str) -> bool:
        with get_db_session() as session:
            user = session.get(UserModel, user_id)
            if user:
                session.delete(user)
                return True
            return False

    def seed_default_demo_admin(self) -> None:
        demo_email = settings.DEMO_ADMIN_EMAIL
        demo_password = settings.DEMO_ADMIN_PASSWORD
        demo_entity_id = "default_family"
        user_id = "usr_demo_admin"

        with get_db_session() as session:
            user = session.scalars(select(UserModel).where(UserModel.email == demo_email)).first()
            if not user:
                from app.services.auth import hash_password

                hashed = hash_password(demo_password)
                user = UserModel(
                    id=user_id,
                    email=demo_email,
                    hashed_password=hashed,
                    full_name="Sovereign Administrator",
                )
                session.add(user)
                session.flush()

            # Ensure default_family entity exists
            entity = session.get(FamilyEntityModel, demo_entity_id)
            if not entity:
                entity = FamilyEntityModel(
                    id=demo_entity_id,
                    name="Default Family Trust",
                    entity_type="Family Trust",
                )
                session.add(entity)
                session.flush()

            # Ensure membership exists
            mem = session.scalars(
                select(MembershipModel).where(
                    MembershipModel.user_id == user.id,
                    MembershipModel.family_entity_id == demo_entity_id,
                )
            ).first()
            if not mem:
                mem = MembershipModel(
                    id="mem_demo_admin",
                    user_id=user.id,
                    family_entity_id=demo_entity_id,
                    role="family_admin",
                )
                session.add(mem)


class SqlAlchemyFamilyRepository(BaseFamilyRepository):
    def create_family_entity(self, entity: Dict[str, Any]) -> None:
        with get_db_session() as session:
            existing = session.get(FamilyEntityModel, entity["id"])
            if not existing:
                db_entity = FamilyEntityModel(
                    id=entity["id"],
                    name=entity["name"],
                    entity_type=entity.get("entity_type", "Family Trust"),
                )
                session.add(db_entity)

    def get_family_entity(self, entity_id: str) -> Optional[Dict[str, Any]]:
        with get_db_session() as session:
            entity = session.get(FamilyEntityModel, entity_id)
            return _family_to_dict(entity) if entity else None

    def create_membership(self, membership: Dict[str, Any]) -> None:
        with get_db_session() as session:
            stmt = select(MembershipModel).where(
                MembershipModel.user_id == membership["user_id"],
                MembershipModel.family_entity_id == membership["family_entity_id"],
            )
            existing = session.scalars(stmt).first()
            if existing:
                existing.role = membership["role"]
            else:
                mem = MembershipModel(
                    id=membership.get("id") or str(uuid.uuid4()),
                    user_id=membership["user_id"],
                    family_entity_id=membership["family_entity_id"],
                    role=membership["role"],
                )
                session.add(mem)

    def get_user_memberships(self, user_id: str) -> List[Dict[str, Any]]:
        with get_db_session() as session:
            stmt = (
                select(MembershipModel, FamilyEntityModel)
                .join(FamilyEntityModel, MembershipModel.family_entity_id == FamilyEntityModel.id)
                .where(MembershipModel.user_id == user_id)
            )
            rows = session.execute(stmt).all()
            results = []
            for m, e in rows:
                results.append({
                    "id": m.id,
                    "user_id": m.user_id,
                    "family_entity_id": m.family_entity_id,
                    "role": m.role,
                    "created_at": _dt_to_str(m.created_at),
                    "entity_name": e.name,
                    "entity_type": e.entity_type,
                })
            return results


class SqlAlchemyDocumentRepository(BaseDocumentRepository):
    def get_document_by_hash(self, family_entity_id: str, file_hash: str) -> Optional[Dict[str, Any]]:
        with get_db_session(family_ids=[family_entity_id]) as session:
            stmt = select(DocumentModel).where(
                DocumentModel.family_entity_id == family_entity_id,
                DocumentModel.file_hash == file_hash,
            )
            doc = session.scalars(stmt).first()
            return _doc_to_dict(doc) if doc else None

    def insert_document(self, doc: Dict[str, Any]) -> None:
        try:
            self._insert_document(doc)
        except IntegrityError as e:
            # The constraint name comes from migration 001; the column name covers create_all schemas
            if "uq_family_file_hash" in str(e.orig) or "file_hash" in str(e.orig):
                raise DuplicateDocumentError(doc["file_hash"]) from e
            raise

    def _insert_document(self, doc: Dict[str, Any]) -> None:
        family_id = doc["family_entity_id"]
        with get_db_session(family_ids=[family_id]) as session:
            db_doc = DocumentModel(
                id=doc["id"],
                filename=doc["filename"],
                original_name=doc["original_name"],
                mime_type=doc["mime_type"],
                file_size=doc["file_size"],
                file_hash=doc["file_hash"],
                total_pages=doc.get("total_pages", 1),
                family_entity_id=family_id,
                status=doc.get("status", "indexed"),
            )
            session.add(db_doc)

    def update_document_status(self, document_id: str, status: str) -> None:
        with get_db_session(system=True) as session:  # id lookup, authorized by the caller (Audit I-16)
            stmt = update(DocumentModel).where(DocumentModel.id == document_id).values(status=status)
            session.execute(stmt)

    def delete_document(self, document_id: str) -> bool:
        with get_db_session(system=True) as session:  # id lookup, authorized by the caller (Audit I-16)
            doc = session.get(DocumentModel, document_id)
            if doc:
                session.delete(doc)
                return True
            return False

    def insert_document_acl(self, document_id: str, family_entity_id: str, allowed_role: str) -> None:
        with get_db_session(family_ids=[family_entity_id]) as session:
            acl = DocumentAclModel(
                id=str(uuid.uuid4()),
                document_id=document_id,
                family_entity_id=family_entity_id,
                allowed_role=allowed_role,
            )
            session.add(acl)

    def get_document_allowed_roles(self, document_id: str, family_entity_id: str) -> List[str]:
        with get_db_session(family_ids=[family_entity_id]) as session:
            stmt = select(DocumentAclModel.allowed_role).where(
                DocumentAclModel.document_id == document_id,
                DocumentAclModel.family_entity_id == family_entity_id,
            )
            return list(session.scalars(stmt).all())

    def insert_chunks(self, chunks: List[Dict[str, Any]]) -> None:
        if not chunks:
            return
        with get_db_session(system=True) as session:  # id lookup, authorized by the caller (Audit I-16)
            for c in chunks:
                chunk_obj = DocumentChunkModel(
                    id=c["id"],
                    document_id=c["document_id"],
                    chunk_index=c["chunk_index"],
                    page_number=c["page_number"],
                    section_title=c.get("section_title"),
                    content=c["content"],
                    is_table=bool(c.get("is_table", False)),
                )
                session.merge(chunk_obj)

    def get_chunk_ids_for_document(self, document_id: str, family_entity_id: str) -> List[str]:
        with get_db_session(family_ids=[family_entity_id]) as session:
            stmt = (
                select(DocumentChunkModel.id)
                .join(DocumentModel, DocumentChunkModel.document_id == DocumentModel.id)
                .where(
                    DocumentChunkModel.document_id == document_id,
                    DocumentModel.family_entity_id == family_entity_id,
                )
            )
            return list(session.scalars(stmt).all())

    def get_chunks_by_ids(self, chunk_ids: List[str]) -> List[Dict[str, Any]]:
        if not chunk_ids:
            return []
        with get_db_session(system=True) as session:  # id lookup, authorized by the caller (Audit I-16)
            stmt = (
                select(DocumentChunkModel, DocumentModel.original_name, DocumentModel.family_entity_id)
                .join(DocumentModel, DocumentChunkModel.document_id == DocumentModel.id)
                .where(DocumentChunkModel.id.in_(chunk_ids))
            )
            rows = session.execute(stmt).all()
            results_map = {}
            for chunk, doc_name, family_id in rows:
                results_map[chunk.id] = {
                    "id": chunk.id,
                    "document_id": chunk.document_id,
                    "chunk_index": chunk.chunk_index,
                    "page_number": chunk.page_number,
                    "section_title": chunk.section_title,
                    "content": chunk.content,
                    "is_table": chunk.is_table,
                    "created_at": _dt_to_str(chunk.created_at),
                    "document_name": doc_name,
                    "family_entity_id": family_id,
                }
            return [results_map[cid] for cid in chunk_ids if cid in results_map]

    def get_documents_by_entity(self, entity_id: str, user_role: str) -> List[Dict[str, Any]]:
        with get_db_session(family_ids=[entity_id]) as session:
            stmt = (
                select(DocumentModel)
                .join(DocumentAclModel, DocumentModel.id == DocumentAclModel.document_id)
                .where(
                    DocumentModel.family_entity_id == entity_id,
                    or_(
                        DocumentAclModel.allowed_role == user_role,
                        DocumentAclModel.allowed_role == "family_member",
                        user_role == "family_admin",
                    ),
                )
                .distinct()
                .order_by(DocumentModel.uploaded_at.desc())
            )
            docs = session.scalars(stmt).all()
            return [_doc_to_dict(d) for d in docs]

    def get_all_documents(self) -> List[Dict[str, Any]]:
        with get_db_session(system=True) as session:  # cross-tenant maintenance only: reconcile, backfill, startup checks (Audit I-16)
            stmt = select(DocumentModel).order_by(DocumentModel.uploaded_at.desc())
            docs = session.scalars(stmt).all()
            return [_doc_to_dict(d) for d in docs]

    def get_lexical_chunks(self) -> List[Dict[str, Any]]:
        with get_db_session(system=True) as session:  # keyword-index rebuild, partitioned by tenant (Audit I-28)
            stmt = (
                select(
                    DocumentChunkModel.id, DocumentChunkModel.document_id, DocumentChunkModel.page_number,
                    DocumentChunkModel.is_table, DocumentChunkModel.content, DocumentModel.family_entity_id,
                    DocumentModel.original_name, DocumentAclModel.allowed_role,
                )
                .join(DocumentModel, DocumentChunkModel.document_id == DocumentModel.id)
                .outerjoin(
                    DocumentAclModel,
                    (DocumentAclModel.document_id == DocumentChunkModel.document_id)
                    & (DocumentAclModel.family_entity_id == DocumentModel.family_entity_id),
                )
            )
            return [dict(row._mapping) for row in session.execute(stmt).all()]

    def get_document_by_id(self, doc_id: str) -> Optional[Dict[str, Any]]:
        with get_db_session(system=True) as session:  # id lookup, authorized by the caller (Audit I-16)
            doc = session.get(DocumentModel, doc_id)
            return _doc_to_dict(doc) if doc else None

    def get_document_names(self, family_entity_id: str) -> Dict[str, str]:
        if not family_entity_id:
            return {}  # never a cross-tenant name map (Audit I-20)
        with get_db_session(family_ids=[family_entity_id]) as session:
            stmt = select(DocumentModel.id, DocumentModel.original_name, DocumentModel.filename).where(
                DocumentModel.family_entity_id == family_entity_id
            )
            rows = session.execute(stmt).all()
            return {
                doc_id: (orig_name or filename)
                for doc_id, orig_name, filename in rows
            }


class SqlAlchemyAuditRepository(BaseAuditRepository):
    def log_audit_event(
        self,
        action: str,
        user_id: Optional[str] = None,
        family_entity_id: Optional[str] = None,
        resource_id: Optional[str] = None,
        details: Optional[str] = None,
    ) -> None:
        family_ids = [family_entity_id] if family_entity_id else None
        with get_db_session(family_ids=family_ids) as session:
            evt = AuditEventModel(
                id=str(uuid.uuid4()),
                user_id=user_id,
                family_entity_id=family_entity_id,
                action=action,
                resource_id=resource_id,
                details=details,
            )
            session.add(evt)

    def get_audit_events_for_entities(self, entity_ids: List[str], limit: int = 50) -> List[Dict[str, Any]]:
        if not entity_ids:
            return []
        with get_db_session(family_ids=entity_ids) as session:
            stmt = (
                select(AuditEventModel)
                .where(AuditEventModel.family_entity_id.in_(entity_ids))
                .order_by(AuditEventModel.timestamp.desc())
                .limit(limit)
            )
            events = session.scalars(stmt).all()
            return [_audit_to_dict(e) for e in events]

    def get_audit_events_for_user(self, user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        with get_db_session(system=True) as session:  # filtered to this user's own events (Audit I-16)
            stmt = (
                select(AuditEventModel)
                .where(AuditEventModel.user_id == user_id)
                .order_by(AuditEventModel.timestamp.desc())
                .limit(limit)
            )
            events = session.scalars(stmt).all()
            return [_audit_to_dict(e) for e in events]

    def get_audit_events(self, limit: int = 50, family_entity_id: Optional[str] = None) -> List[Dict[str, Any]]:
        family_ids = [family_entity_id] if family_entity_id else None
        with get_db_session(family_ids=family_ids) as session:
            stmt = select(AuditEventModel)
            if family_entity_id:
                stmt = stmt.where(AuditEventModel.family_entity_id == family_entity_id)
            stmt = stmt.order_by(AuditEventModel.timestamp.desc()).limit(limit)
            events = session.scalars(stmt).all()
            return [_audit_to_dict(e) for e in events]


class SqlAlchemyTokenRepository(BaseTokenRepository):
    def revoke_token(self, jti: str, user_id: str, expires_at: Optional[str] = None) -> None:
        with get_db_session() as session:
            exp_dt = None
            if expires_at:
                try:
                    exp_dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                except Exception:
                    pass
            rev = session.get(RevokedTokenModel, jti)
            if rev:
                rev.user_id = user_id
                rev.expires_at = exp_dt
            else:
                rev = RevokedTokenModel(jti=jti, user_id=user_id, expires_at=exp_dt)
                session.add(rev)

    def is_token_revoked(self, jti: str) -> bool:
        with get_db_session() as session:
            rev = session.get(RevokedTokenModel, jti)
            return rev is not None

    def cleanup_expired_tokens(self) -> int:
        with get_db_session() as session:
            now = datetime.now(timezone.utc)
            stmt = delete(RevokedTokenModel).where(
                RevokedTokenModel.expires_at.is_not(None),
                RevokedTokenModel.expires_at < now,
            )
            res = session.execute(stmt)
            return res.rowcount or 0
