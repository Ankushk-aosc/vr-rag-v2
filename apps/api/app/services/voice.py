import asyncio
import io
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Optional
from app.config import settings

logger = logging.getLogger(__name__)

_whisper_model = None

# Australian English voice options
DEFAULT_AUSTRALIAN_VOICE = "en-AU-NatashaNeural"  # Natural Australian female voice
ALTERNATIVE_AUSTRALIAN_VOICE = "en-AU-WilliamNeural"  # Natural Australian male voice


def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        logger.info("Initializing faster-whisper base.en model...")
        _whisper_model = WhisperModel(
            model_size_or_path=settings.WHISPER_MODEL_SIZE or "base.en",
            device=settings.WHISPER_DEVICE or "cpu",
            compute_type="int8"
        )
    return _whisper_model


def clean_text_for_speech(text: str) -> str:
    """Strip markdown formatting, URLs, and code blocks for fluid Australian voice delivery."""
    # Remove multi-line code blocks
    text = re.sub(r"```[\s\S]*?```", "", text)
    # Strip backticks from inline code while preserving content (e.g. `$13,750` -> $13,750)
    text = re.sub(r"`(.*?)`", r"\1", text)
    # Convert markdown links [Label](url) to just Label
    text = re.sub(r"\[(.*?)\]\(.*?\)", r"\1", text)
    # Remove markdown headers and emphasis
    text = re.sub(r"[#*_~]", "", text)
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Normalize excessive whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


def detect_audio_suffix(audio_bytes: bytes, fallback_suffix: str = ".wav") -> str:
    """Inspect leading magic bytes to ensure temporary disk file matches container demuxer."""
    if not audio_bytes or len(audio_bytes) < 4:
        return fallback_suffix
    header = audio_bytes[:16]
    if header.startswith(b"\x1aE\xdf\xa3"):
        return ".webm"
    if header.startswith(b"RIFF"):
        return ".wav"
    if header.startswith(b"OggS"):
        return ".ogg"
    if header.startswith(b"ID3") or header.startswith(b"\xff\xfb") or header.startswith(b"\xff\xf3"):
        return ".mp3"
    if b"ftyp" in header:
        return ".m4a"
    if header.startswith(b"fLaC"):
        return ".flac"
    return fallback_suffix


def transcribe_with_groq(audio_bytes: bytes, suffix: str = ".webm") -> Optional[str]:
    """Transcribe speech using Groq cloud Whisper with fast inference."""
    if not settings.GROQ_API_KEY or settings.GROQ_API_KEY.startswith("your-"):
        return None
    try:
        from groq import Groq
        client = Groq(api_key=settings.GROQ_API_KEY)
        fname = f"audio{suffix}"
        res = client.audio.transcriptions.create(
            file=(fname, audio_bytes),
            model=settings.GROQ_STT_MODEL or "whisper-large-v3-turbo",
            response_format="json",
            language="en"
        )
        if res and res.text:
            logger.info("Groq STT transcribed speech successfully.")
            return res.text.strip()
    except Exception as e:
        logger.info(f"Groq STT unavailable or model permission pending ({e}). Falling back to local Whisper.")
    return None


def transcribe_audio_file(audio_path: Path) -> str:
    """Transcribe an audio file using local faster-whisper."""
    model = get_whisper_model()
    segments, info = model.transcribe(
        str(audio_path),
        beam_size=5,
        language="en",
        condition_on_previous_text=False
    )
    transcript = " ".join([segment.text for segment in segments]).strip()
    return transcript


def transcribe_audio_bytes(audio_bytes: bytes, file_suffix: str = ".wav") -> str:
    """
    Transcribe audio bytes using Groq Cloud STT when available,
    falling back seamlessly to local faster-whisper on CPU.
    """
    detected_suffix = detect_audio_suffix(audio_bytes, fallback_suffix=file_suffix)

    # 1. Attempt rapid Groq Cloud STT
    cloud_transcript = transcribe_with_groq(audio_bytes, suffix=detected_suffix)
    if cloud_transcript:
        return cloud_transcript

    # 2. Local fallback using faster-whisper
    with tempfile.NamedTemporaryFile(suffix=detected_suffix, delete=False) as temp_audio:
        temp_path = Path(temp_audio.name)
        temp_audio.write(audio_bytes)
        temp_audio.flush()

    try:
        return transcribe_audio_file(temp_path)
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass


async def synthesize_speech_edge(text: str, voice: str = DEFAULT_AUSTRALIAN_VOICE) -> bytes:
    """Synthesize speech using high-fidelity Australian neural voice via edge-tts."""
    import edge_tts
    clean_text = clean_text_for_speech(text)
    if not clean_text:
        return b""
    communicate = edge_tts.Communicate(clean_text, voice)
    audio_buffer = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_buffer.write(chunk["data"])
    return audio_buffer.getvalue()


def synthesize_speech_pyttsx3(text: str) -> bytes:
    """Fallback local offline text-to-speech using Windows native SAPI5 speech engine."""
    try:
        import pyttsx3
    except ImportError:
        logger.warning("pyttsx3 is not installed. Text-to-speech fallback skipped.")
        return b""
    clean_text = clean_text_for_speech(text)
    engine = pyttsx3.init()
    
    # Try selecting an Australian voice if available on the Windows host
    voices = engine.getProperty("voices")
    for v in voices:
        if "australia" in v.name.lower() or "en-au" in v.id.lower():
            engine.setProperty("voice", v.id)
            break

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
        temp_wav_path = temp_wav.name

    try:
        engine.save_to_file(clean_text, temp_wav_path)
        engine.runAndWait()
        with open(temp_wav_path, "rb") as f:
            return f.read()
    finally:
        if os.path.exists(temp_wav_path):
            try:
                os.remove(temp_wav_path)
            except Exception:
                pass


async def synthesize_speech(text: str) -> bytes:
    """Synthesize speech with Australian English neural voice, falling back to local Windows SAPI5."""
    try:
        audio = await synthesize_speech_edge(text, DEFAULT_AUSTRALIAN_VOICE)
        if audio and len(audio) > 100:
            return audio
    except Exception as e:
        logger.warning(f"edge-tts unavailable, falling back to local SAPI5: {e}")

    try:
        return synthesize_speech_pyttsx3(text)
    except Exception as e:
        logger.warning(f"Local pyttsx3 speech synthesis failed: {e}")
        return b""
