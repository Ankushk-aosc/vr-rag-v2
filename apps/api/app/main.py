from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.routers import auth, documents, query, voice


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title="Aether Sovereign Financial RAG API (Australia)",
    description=(
        "Privacy-preserving, voice-first financial RAG assistant for Australian family offices. "
        "Cloud-native architecture powered by Pinecone serverless vector & metadata storage and Groq cloud inference."
    ),
    version="2.0.0",
    lifespan=lifespan
)

# CORS configuration for web, LAN, and WebXR/Expo mobile clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:8081",
        "http://127.0.0.1:8081",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth.router)
app.include_router(documents.router)
app.include_router(query.router)
app.include_router(voice.router)


@app.get("/api/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "environment": settings.ENVIRONMENT,
        "jurisdiction": "Australia (Cth)",
        "currency": settings.DEFAULT_CURRENCY,
        "storage_provider": "Pinecone Cloud Serverless (Zero Local Storage)",
        "pinecone_index": settings.PINECONE_INDEX_NAME,
        "pinecone_configured": bool(settings.PINECONE_API_KEY and settings.PINECONE_API_KEY != "your-pinecone-api-key-here"),
        "llm_provider": "Groq Cloud API (Zero Fallback)",
        "groq_model": settings.GROQ_MODEL
    }

