import asyncio
import base64
from pathlib import Path
from typing import Any, Dict, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field

from app.schemas.query import QueryResponse
from app.services import auth, rag_engine, voice

router = APIRouter(prefix="/api/voice", tags=["Voice Interaction"])


class TranscribeResponse(BaseModel):
    transcript: str
    language: str = "en"


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice: Optional[str] = "en-AU-NatashaNeural"


class VoiceAskResponse(BaseModel):
    user_transcript: str
    answer: str
    audio_base64: Optional[str] = None
    citations: list
    grounded: bool
    currency: str = "AUD"


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(file: UploadFile = File(...)):
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded audio file is empty."
        )

    file_suffix = Path(file.filename).suffix or ".wav"
    try:
        transcript = await asyncio.to_thread(voice.transcribe_audio_bytes, file_bytes, file_suffix)
        return TranscribeResponse(transcript=transcript)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Speech transcription failed: {str(e)}"
        )


@router.post("/synthesize")
async def synthesize_text(req: SynthesizeRequest):
    try:
        audio_bytes = await voice.synthesize_speech(req.text)
        if not audio_bytes:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to generate speech audio."
            )
        # Return MP3 / WAV audio binary stream
        media_type = "audio/mpeg" if audio_bytes[:3] == b"ID3" or b"LAME" in audio_bytes[:20] else "audio/wav"
        return Response(content=audio_bytes, media_type=media_type)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Speech synthesis error: {str(e)}"
        )


@router.post("/ask", response_model=VoiceAskResponse)
async def ask_by_voice(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family"),
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    End-to-End Voice Interaction:
    1. Transcribes incoming spoken audio.
    2. Runs evidence-grounded RAG query against authorized family records.
    3. Synthesizes Australian English spoken audio.
    4. Returns user transcript, answer, citations, and base64 audio in a single call.
    """
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty audio payload.")

    file_suffix = Path(file.filename).suffix or ".wav"
    transcript = await asyncio.to_thread(voice.transcribe_audio_bytes, file_bytes, file_suffix)

    clean_t = transcript.strip().lower().rstrip(".,!?")
    SILENCE_HALLUCINATIONS = {"you", "thank you", "thanks for watching", "subtitles by", "bye", "[music]", "[applause]"}
    if not transcript or len(clean_t) < 2 or clean_t in SILENCE_HALLUCINATIONS:
        return VoiceAskResponse(
            user_transcript="",
            answer="No audible speech detected. Please press the microphone and speak your financial question.",
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

    # Execute RAG query
    rag_result = await rag_engine.execute_rag_query(
        question=transcript,
        family_entity_id=family_entity_id,
        user_roles=user_roles
    )

    # Synthesize Australian speech audio
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
        currency="AUD"
    )
