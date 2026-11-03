import asyncio
import base64
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field

from app.config import settings
from app.services import auth, rag_engine, voice
from app.services.upload_security import validate_audio_upload
from app.middleware.rate_limiter import rate_limit
from app.routers.query import resolve_roles

router = APIRouter(prefix="/api/voice", tags=["Voice Interaction"])
client_logger = logging.getLogger("voice.client")
logger = logging.getLogger(__name__)

MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 25MB audio limit


class TranscribeResponse(BaseModel):
    transcript: str
    language: str = "en"
    is_silence: bool = False


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice: Optional[str] = None


class VoiceAskResponse(BaseModel):
    user_transcript: str
    answer: str
    audio_base64: Optional[str] = None
    citations: list
    grounded: bool
    currency: str = "AUD"


async def _transcribe(file: UploadFile) -> str:
    file_bytes = await file.read()
    validate_audio_upload(file_bytes, max_bytes=MAX_AUDIO_BYTES)
    file_suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    try:
        return await asyncio.to_thread(voice.transcribe_audio_bytes, file_bytes, file_suffix)
    except Exception as e:
        logger.error("Speech-to-text failure: %s", e)
        stt = voice.stt_status()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech-to-text transcription service is currently unavailable. Please try again or type your question.",
        )


class ClientLogBatch(BaseModel):
    events: List[Dict[str, Any]] = Field(default_factory=list, max_length=200)
    userAgent: str = ""


@router.post(
    "/client-log",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limit(max_requests=60, window_seconds=60))]
)
async def client_log(
    batch: ClientLogBatch,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Voice diagnostics from the browser (Audit S12):
    Enforces authentication, rate limits, and strips control chars/newlines to prevent log forging.
    """
    for event in batch.events:
        # Strip newlines and control characters
        raw_name = str(event.get("event", "?"))[:40]
        safe_name = re.sub(r"[\r\n\x00-\x1f]", "", raw_name)
        details = {k: v for k, v in event.items() if k not in ("event",)}
        safe_details = re.sub(r"[\r\n]", " ", json.dumps(details, default=str)[:400])
        client_logger.info("ClientEvent: %s %s", safe_name, safe_details)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/status")
async def voice_status(current_user: Dict[str, Any] = Depends(auth.get_current_user)):
    """Voice service health and status behind authenticated session (Audit S15)."""
    return {"stt": voice.stt_status(), "tts_voice": settings.TTS_VOICE}


@router.post(
    "/transcribe",
    response_model=TranscribeResponse,
    dependencies=[Depends(rate_limit(max_requests=30, window_seconds=60))]
)
async def transcribe_audio(
    file: UploadFile = File(...),
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    transcript = await _transcribe(file)
    silent = voice.is_probable_hallucination(transcript)
    return TranscribeResponse(transcript="" if silent else transcript, is_silence=silent)


@router.post(
    "/synthesize",
    dependencies=[Depends(rate_limit(max_requests=30, window_seconds=60))]
)
async def synthesize_text(
    req: SynthesizeRequest,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    try:
        audio_bytes = await voice.synthesize_speech(req.text, req.voice)
    except Exception as e:
        logger.error("Speech synthesis error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech synthesis service encountered an error."
        )
    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech synthesis produced no audio.",
        )
    media_type = "audio/wav" if audio_bytes[:4] == b"RIFF" else "audio/mpeg"
    return Response(content=audio_bytes, media_type=media_type, headers={"Cache-Control": "no-store"})


@router.post(
    "/ask",
    response_model=VoiceAskResponse,
    dependencies=[Depends(rate_limit(max_requests=30, window_seconds=60))]
)
async def ask_by_voice(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family"),
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    End-to-End Voice Interaction (used by the mobile app):
    1. Transcribes incoming spoken audio.
    2. Runs evidence-grounded RAG query against authorized family records.
    3. Synthesizes Australian English spoken audio.
    4. Returns user transcript, answer, citations, and base64 audio in a single call.
    """
    transcript = await _transcribe(file)
    if voice.is_probable_hallucination(transcript):
        return VoiceAskResponse(
            user_transcript="",
            answer="I didn't catch any speech. Please try again and speak your question.",
            citations=[],
            grounded=False
        )

    user_roles = resolve_roles(family_entity_id, current_user)

    try:
        rag_result = await rag_engine.execute_rag_query(
            question=transcript,
            family_entity_id=family_entity_id,
            user_roles=user_roles,
            mode="voice",
        )
    except rag_engine.RagError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))

    audio_base64 = None
    try:
        audio_bytes = await voice.synthesize_speech(rag_result["answer"])
        if audio_bytes:
            audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    except Exception:
        pass

    return VoiceAskResponse(
        user_transcript=transcript,
        answer=rag_result["answer"],
        audio_base64=audio_base64,
        citations=rag_result["citations"],
        grounded=rag_result["grounded"],
        currency=rag_result.get("currency", "AUD"),
    )
