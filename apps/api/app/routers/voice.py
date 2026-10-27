import asyncio
import base64
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field

from app.config import settings
from app.services import auth, rag_engine, voice

router = APIRouter(prefix="/api/voice", tags=["Voice Interaction"])
client_logger = logging.getLogger("voice.client")


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
    if not file_bytes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded audio file is empty.")
    file_suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    try:
        return await asyncio.to_thread(voice.transcribe_audio_bytes, file_bytes, file_suffix)
    except Exception as e:
        stt = voice.stt_status()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                f"Speech-to-text unavailable: {e}. Groq Whisper: {stt['groq_whisper']}; "
                f"local Whisper: {stt['local_whisper']}."
            ),
        )


class ClientLogBatch(BaseModel):
    events: List[Dict[str, Any]] = Field(default_factory=list, max_length=200)
    userAgent: str = ""


@router.post("/client-log", status_code=status.HTTP_204_NO_CONTENT)
async def client_log(batch: ClientLogBatch):
    """Voice diagnostics from the browser (event names, timings, short transcripts - no audio)."""
    for event in batch.events:
        name = str(event.get("event", "?"))[:40]
        details = {k: v for k, v in event.items() if k not in ("event",)}
        client_logger.info("%s %s", name, json.dumps(details, default=str)[:400])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/status")
async def voice_status():
    return {"stt": voice.stt_status(), "tts_voice": settings.TTS_VOICE}


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(file: UploadFile = File(...)):
    transcript = await _transcribe(file)
    silent = voice.is_probable_hallucination(transcript)
    return TranscribeResponse(transcript="" if silent else transcript, is_silence=silent)


@router.post("/synthesize")
async def synthesize_text(req: SynthesizeRequest):
    try:
        audio_bytes = await voice.synthesize_speech(req.text, req.voice)
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"Speech synthesis error: {e}")
    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech synthesis produced no audio (edge-tts offline and no local SAPI5 voice).",
        )
    media_type = "audio/wav" if audio_bytes[:4] == b"RIFF" else "audio/mpeg"
    return Response(content=audio_bytes, media_type=media_type, headers={"Cache-Control": "no-store"})


@router.post("/ask", response_model=VoiceAskResponse)
async def ask_by_voice(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family"),
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
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

    user_roles = ["family_admin", "family_member"]
    if current_user and current_user.get("memberships"):
        matched_roles = [
            m["role"] for m in current_user["memberships"]
            if m["family_entity_id"] == family_entity_id
        ]
        if matched_roles:
            user_roles = matched_roles

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
