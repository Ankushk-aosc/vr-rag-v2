from app.config import settings
from app.db.repositories.base import (
    BaseAuditRepository,
    BaseDocumentRepository,
    BaseFamilyRepository,
    BaseLocalIndexRepository,
    BaseTokenRepository,
    BaseUserRepository,
)
from app.db.repositories.sqlite_repo import (
    SqliteAuditRepository,
    SqliteDocumentRepository,
    SqliteFamilyRepository,
    SqliteTokenRepository,
    SqliteUserRepository,
)
from app.db.repositories.sqlalchemy_repo import (
    SqlAlchemyAuditRepository,
    SqlAlchemyDocumentRepository,
    SqlAlchemyFamilyRepository,
    SqlAlchemyTokenRepository,
    SqlAlchemyUserRepository,
)
from app.db.repositories.sqlite_local_index import SqliteLocalIndexRepository
from app.db.repositories.sqlalchemy_local_index import SqlAlchemyLocalIndexRepository


def is_postgres() -> bool:
    return bool(settings.DATABASE_URL and not settings.DATABASE_URL.startswith("sqlite"))


_sqlite_user_repo = SqliteUserRepository()
_sqlite_family_repo = SqliteFamilyRepository()
_sqlite_doc_repo = SqliteDocumentRepository()
_sqlite_audit_repo = SqliteAuditRepository()
_sqlite_token_repo = SqliteTokenRepository()
_sqlite_local_index_repo = SqliteLocalIndexRepository()

_sa_user_repo = SqlAlchemyUserRepository()
_sa_family_repo = SqlAlchemyFamilyRepository()
_sa_doc_repo = SqlAlchemyDocumentRepository()
_sa_audit_repo = SqlAlchemyAuditRepository()
_sa_token_repo = SqlAlchemyTokenRepository()
_sa_local_index_repo = SqlAlchemyLocalIndexRepository()


def get_user_repository() -> BaseUserRepository:
    return _sa_user_repo if is_postgres() else _sqlite_user_repo


def get_family_repository() -> BaseFamilyRepository:
    return _sa_family_repo if is_postgres() else _sqlite_family_repo


def get_document_repository() -> BaseDocumentRepository:
    return _sa_doc_repo if is_postgres() else _sqlite_doc_repo


def get_audit_repository() -> BaseAuditRepository:
    return _sa_audit_repo if is_postgres() else _sqlite_audit_repo


def get_token_repository() -> BaseTokenRepository:
    return _sa_token_repo if is_postgres() else _sqlite_token_repo


def get_local_index_repository() -> BaseLocalIndexRepository:
    return _sa_local_index_repo if is_postgres() else _sqlite_local_index_repo


__all__ = [
    "is_postgres",
    "get_user_repository",
    "get_family_repository",
    "get_document_repository",
    "get_audit_repository",
    "get_token_repository",
    "get_local_index_repository",
    "BaseUserRepository",
    "BaseFamilyRepository",
    "BaseDocumentRepository",
    "BaseAuditRepository",
    "BaseTokenRepository",
    "BaseLocalIndexRepository",
]
