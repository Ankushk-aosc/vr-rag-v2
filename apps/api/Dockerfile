# VR-RAG API (Audit I-17). Built by docker-compose.yml from the repository root.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FASTEMBED_CACHE_PATH=/opt/models/fastembed \
    HF_HOME=/models/huggingface \
    UPLOADS_DIR=/data/uploads \
    SQLITE_DB_PATH=/data/app.db

# tesseract-ocr backs the local OCR pipeline; libglib2.0-0 is needed by opencv-python-headless
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app

# Bake the embedding model into the image so a running container never downloads it
RUN python -c "from app.services.embeddings import embed_texts; embed_texts(['warm up'])"

# Run as an unprivileged user; /data (uploads, SQLite) and /models (Whisper cache) are volumes
RUN useradd --system --uid 10001 --home-dir /app app \
    && mkdir -p /data/uploads /models \
    && chown -R app:app /data /models /opt/models
USER app

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
