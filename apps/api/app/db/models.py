import uuid
from datetime import datetime
from decimal import Decimal
from typing import Optional
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class UserModel(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Session version (Audit I-15): access tokens carry it as `ver`; a password change bumps it
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    memberships = relationship("MembershipModel", back_populates="user", cascade="all, delete-orphan")


class FamilyEntityModel(Base):
    __tablename__ = "family_entities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False, default="Family Trust")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    memberships = relationship("MembershipModel", back_populates="family_entity", cascade="all, delete-orphan")
    documents = relationship("DocumentModel", back_populates="family_entity", cascade="all, delete-orphan")


class MembershipModel(Base):
    __tablename__ = "memberships"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    family_entity_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user = relationship("UserModel", back_populates="memberships")
    family_entity = relationship("FamilyEntityModel", back_populates="memberships")

    __table_args__ = (
        UniqueConstraint("user_id", "family_entity_id", name="uq_user_family_membership"),
        CheckConstraint(
            "role IN ('family_admin', 'family_member', 'read_only_adviser')",
            name="ck_membership_role",
        ),
        Index("idx_memberships_user", "user_id"),
        Index("idx_memberships_family", "family_entity_id"),
    )


class DocumentModel(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    file_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    total_pages: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    family_entity_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(50), default="indexed", nullable=False)
    # ABAC attributes (migration 008): who uploaded it and its sensitivity tier
    owner_user_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    classification: Mapped[str] = mapped_column(String(20), default="confidential", server_default="confidential", nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    family_entity = relationship("FamilyEntityModel", back_populates="documents")
    acl = relationship("DocumentAclModel", back_populates="document", cascade="all, delete-orphan")
    chunks = relationship("DocumentChunkModel", back_populates="document", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("family_entity_id", "file_hash", name="uq_family_file_hash"),
        Index("idx_documents_family", "family_entity_id"),
    )


class DocumentAclModel(Base):
    __tablename__ = "document_acl"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    family_entity_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    allowed_role: Mapped[str] = mapped_column(String(50), nullable=False)

    document = relationship("DocumentModel", back_populates="acl")

    __table_args__ = (
        Index("idx_doc_acl", "document_id", "family_entity_id"),
    )


class DocumentChunkModel(Base):
    __tablename__ = "document_chunks"

    # Chunk ids are "{document_id}_p{page}_c{n}", longer than a UUID (Audit I-16, migration 006)
    id: Mapped[str] = mapped_column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    page_number: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    section_title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_table: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    document = relationship("DocumentModel", back_populates="chunks")

    __table_args__ = (
        Index("idx_chunks_doc_id", "document_id"),
        Index("idx_chunks_page", "page_number"),
    )


class AuditEventModel(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    family_entity_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    details: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("idx_audit_family_timestamp", "family_entity_id", "timestamp"),
        Index("idx_audit_user", "user_id"),
    )


class RevokedTokenModel(Base):
    __tablename__ = "revoked_tokens"

    jti: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    revoked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, index=True)

    __table_args__ = (
        Index("idx_revoked_tokens_expires", "expires_at"),
    )


class LLMUsageModel(Base):
    __tablename__ = "llm_usage"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    family_entity_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    route: Mapped[str] = mapped_column(String(255), nullable=False)
    provider: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str] = mapped_column(String(255), nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_usd: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 6), nullable=True)
    run_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("idx_llm_usage_family_created", "family_entity_id", "created_at"),
        Index("idx_llm_usage_user_created", "user_id", "created_at"),
    )


class ChunkVectorModel(Base):
    """Local vector index (Audit I-09): one embedding per chunk, scored in-process. Text stays in document_chunks."""
    __tablename__ = "chunk_vectors"

    chunk_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    family_entity_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False
    )
    allowed_roles: Mapped[str] = mapped_column(Text, nullable=False)  # JSON list
    embedder_model: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    embedding_dim: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)  # float32, L2-normalised

    __table_args__ = (
        Index("idx_chunk_vectors_family", "family_entity_id"),
    )


class DocumentMetaModel(Base):
    """Local display metadata (columns, sample rows, preview) that previously lived only in Pinecone."""
    __tablename__ = "document_meta"

    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )
    family_entity_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    meta_json: Mapped[str] = mapped_column(Text, nullable=False)


class ConversationModel(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    tenant_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), default="Financial Inquiry", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    messages = relationship("MessageModel", back_populates="conversation", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_conversations_tenant_user", "tenant_id", "user_id"),
    )


class MessageModel(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    citations_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    conversation = relationship("ConversationModel", back_populates="messages")

    __table_args__ = (
        Index("idx_messages_conversation", "conversation_id"),
    )
