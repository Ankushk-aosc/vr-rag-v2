import ipaddress
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Environments where development conveniences (default secret, demo admin seed) are permitted
DEV_ENVIRONMENTS = ("development", "test", "testing")


def is_dev_environment(environment: Optional[str]) -> bool:
    return (environment or "").strip().lower() in DEV_ENVIRONMENTS


# Privacy architecture (Audit I-09). "local": documents, vectors, prompts and audio never leave this
# deployment; every cloud setting (Pinecone, Groq, edge-tts, Textract, S3) is ignored. "cloud" is an
# explicit opt-in to the disclosed cloud data flows.
PRIVACY_MODES = ("local", "cloud")

# Relative data paths resolve against apps/api, not the process working directory, so the API, scripts and
# tests started from any folder share one database and uploads directory (Audit I-19)
API_ROOT = Path(__file__).resolve().parents[1]


def resolve_data_path(value: str) -> str:
    path = Path(value).expanduser()
    return str(path if path.is_absolute() else API_ROOT / path)


def is_private_endpoint(url: str) -> bool:
    """True when url points at this machine or a private network (loopback, RFC 1918, link-local,
    a bare service name like `ollama`, or a *.local / *.internal / *.localhost host)."""
    host = (urlparse(url or "").hostname or "").lower()
    if not host:
        return False
    if host == "localhost" or "." not in host or host.endswith((".local", ".internal", ".localhost")):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Repo root, apps/, apps/api, then CWD. Slicing (not indexing) keeps shallow installs such as
        # the /app/app/config.py container layout working (Audit I-17)
        env_file=[
            *(parent / ".env" for parent in reversed(Path(__file__).resolve().parents[1:4])),
            Path(".env").resolve(),
            ".env",
        ],
        env_file_encoding="utf-8",
        extra="ignore"
    )

    API_HOST: str = "127.0.0.1"
    API_PORT: int = 8000
    ENVIRONMENT: str = "development"
    APP_SECRET_KEY: str = "dev-insecure-key-change-in-production"
    SQLITE_DB_PATH: str = "data/app.db"
    DATABASE_URL: Optional[str] = None  # e.g. postgresql+psycopg://user:password@localhost:5432/vr_rag
    USE_POSTGRES_LEXICAL: bool = False
    UPLOADS_DIR: str = "data/uploads"
    MAX_FILE_SIZE_MB: int = 100

    # Demo administrator seed (Audit I-14): only ever seeded in development/test environments
    SEED_DEMO_ADMIN: bool = True
    DEMO_ADMIN_EMAIL: str = "admin@sovereignfamily.com.au"
    DEMO_ADMIN_PASSWORD: str = "SovereignAdmin2026!"  # dev-only credential, never seeded outside dev/test

    # Privacy architecture (Audit I-09): see PRIVACY_MODES
    PRIVACY_MODE: str = "local"
    # Local OpenAI-compatible LLM server (Ollama, llama.cpp, vLLM, LM Studio) used in local mode
    LOCAL_LLM_BASE_URL: str = "http://127.0.0.1:11434/v1"
    LOCAL_LLM_MODEL: str = "qwen3:8b"
    LOCAL_LLM_API_KEY: str = ""  # most local servers need none

    @property
    def is_local_mode(self) -> bool:
        return self.PRIVACY_MODE == "local"

    @model_validator(mode="after")
    def validate_privacy_mode(self) -> "Settings":
        self.PRIVACY_MODE = (self.PRIVACY_MODE or "").strip().lower()
        if self.PRIVACY_MODE not in PRIVACY_MODES:
            raise ValueError(f"PRIVACY_MODE must be one of {PRIVACY_MODES}, got '{self.PRIVACY_MODE}'.")
        if self.is_local_mode and not is_private_endpoint(self.LOCAL_LLM_BASE_URL):
            raise ValueError(
                "PRIVACY_MODE=local requires LOCAL_LLM_BASE_URL to point at this machine or a private "
                f"network, got '{self.LOCAL_LLM_BASE_URL}'. Set PRIVACY_MODE=cloud to use a hosted LLM."
            )
        return self

    @model_validator(mode="after")
    def anchor_data_paths(self) -> "Settings":
        self.SQLITE_DB_PATH = resolve_data_path(self.SQLITE_DB_PATH)
        self.UPLOADS_DIR = resolve_data_path(self.UPLOADS_DIR)
        return self

    @model_validator(mode="after")
    def validate_production_security(self) -> "Settings":
        if not is_dev_environment(self.ENVIRONMENT):
            if self.APP_SECRET_KEY == "dev-insecure-key-change-in-production" or len(self.APP_SECRET_KEY) < 32:
                raise ValueError(
                    "CRITICAL SECURITY CONFIGURATION ERROR: In production and staging environments, "
                    "APP_SECRET_KEY must be a secure, cryptographically random key containing at least 32 characters. "
                    "Default or short secrets are strictly forbidden."
                )
        return self

    # Pinecone
    PINECONE_API_KEY: Optional[str] = None
    PINECONE_INDEX_NAME: str = "australian-financial-rag"
    PINECONE_CLOUD: str = "aws"
    PINECONE_REGION: str = "us-east-1"

    # Embeddings
    EMBEDDING_MODEL: str = "all-MiniLM-L6-v2"
    EMBEDDING_DIMENSION: int = 384

    # Currency and Regulatory Defaults
    DEFAULT_CURRENCY: str = "AUD"
    FINANCIAL_YEAR_BOUNDARY_MONTH: int = 7  # July 1

    # Groq Cloud LLM (Strict Cloud Provider, Zero Fallback)
    GROQ_API_KEY: Optional[str] = None
    GROQ_MODEL: str = "qwen/qwen3.8-27b"
    # Reasoning effort for Groq reasoning models. Their <think> output is stripped server-side (Audit I-10)
    GROQ_REASONING_EFFORT: str = "medium"

    # Local Whisper Speech-to-Text & Voice
    WHISPER_MODEL_SIZE: str = "base.en"
    WHISPER_DEVICE: str = "cpu"
    # 0 = auto (one thread per physical core)
    WHISPER_CPU_THREADS: int = 0
    TTS_ENGINE: str = "local"
    TTS_VOICE: str = "en-AU-NatashaNeural"
    GROQ_STT_MODEL: str = "whisper-large-v3-turbo"

    # Phase 4 Multi-Provider Registry Settings
    LLM_PROVIDER: str = "fake"          # fake | openai_compatible | groq | ...
    LLM_MODEL: str = "fake-model"
    LLM_BASE_URL: str = ""              # e.g. https://api.groq.com/openai/v1
    LLM_API_KEY: str = ""              # secret; from Secrets Manager in prod
    EMBEDDER_PROVIDER: str = "fake"          # fake | local_st | openai_compatible | ...
    EMBEDDER_MODEL: str = "fake-embed-8"
    EMBEDDER_DIM: int = 8
    EMBEDDER_BASE_URL: str = ""
    EMBEDDER_API_KEY: str = ""
    VECTOR_STORE: str = "memory"        # memory | pinecone | (pgvector later)
    STT_PROVIDER: str = "fake"          # fake | browser (client) | openai_whisper
    TTS_PROVIDER: str = "fake"          # fake | browser (client) | openai_tts
    PROVIDERS_STRICT: bool = False           # if True, missing required key = fail startup
    TOKEN_BUDGET_ENABLED: bool = False       # 4b only
    TENANT_DAILY_TOKEN_CAP: int = 0          # 4b only
    USER_DAILY_TOKEN_CAP: int = 0            # 4b only

    # Phase 2 OCR Settings
    OCR_ENGINE: str = "tesseract"       # tesseract | textract | noop
    OCR_LANG: str = "eng"
    OCR_MIN_CONFIDENCE: float = 0.60    # Avg page confidence threshold
    OCR_PREPROCESS_ENABLED: bool = True
    OCR_PDF_TEXT_THRESHOLD: int = 50    # Minimum chars to consider PDF page born-digital
    S3_BUCKET_NAME: Optional[str] = None
    AWS_REGION: str = "us-east-1"


settings = Settings()
