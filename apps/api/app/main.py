from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.db import sqlite
from app.routers import auth, documents, query


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize SQLite tables on startup
    sqlite.init_db()
    yield


app = FastAPI(
    title="Aurora Spatial Financial RAG API (Australia)",
    description=(
        "Privacy-preserving, voice-first financial RAG assistant for Australian family offices. "
        "Integrates Pinecone vector indexing with zero-leakage local SQLite text storage."
    ),
    version="1.0.0",
    lifespan=lifespan
)

# CORS configuration for web and WebXR clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth.router)
app.include_router(documents.router)
app.include_router(query.router)


@app.get("/api/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "environment": settings.ENVIRONMENT,
        "jurisdiction": "Australia (Cth)",
        "currency": settings.DEFAULT_CURRENCY,
        "pinecone_configured": bool(settings.PINECONE_API_KEY and settings.PINECONE_API_KEY != "your-pinecone-api-key-here"),
        "sqlite_database": settings.SQLITE_DB_PATH
    }
