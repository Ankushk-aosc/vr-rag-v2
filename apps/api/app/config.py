from pathlib import Path
from typing import Optional
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[3] / ".env",
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

    @model_validator(mode="after")
    def validate_production_security(self) -> "Settings":
        env = (self.ENVIRONMENT or "").strip().lower()
        if env not in ("development", "test", "testing"):
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
    # "medium" makes the model emit reasoning tokens that stream into the live thinking panel
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


settings = Settings()
