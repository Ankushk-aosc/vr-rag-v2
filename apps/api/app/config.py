from pathlib import Path
from typing import Optional
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
    LLM_PROVIDER: str = "groq"

    # Local Whisper Speech-to-Text & Voice
    WHISPER_MODEL_SIZE: str = "base.en"
    WHISPER_DEVICE: str = "cpu"
    TTS_ENGINE: str = "local"
    GROQ_STT_MODEL: str = "whisper-large-v3-turbo"


settings = Settings()
