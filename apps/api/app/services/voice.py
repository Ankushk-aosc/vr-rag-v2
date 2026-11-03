import asyncio
import io
import logging
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional
from app.config import settings

logger = logging.getLogger(__name__)

_whisper_model = None
_whisper_failed: Optional[str] = None
_whisper_lock = threading.Lock()
# Groq returns 403 when Whisper is disabled for the org; skip it for a while instead of paying the round-trip
_groq_stt_blocked_until = 0.0
_groq_stt_last_error: Optional[str] = None

# Biases Whisper toward the vocabulary these documents use
STT_VOCAB_PROMPT = (
    "Financial question about Australian equities, ASX, portfolio holdings, superannuation, "
    "franking credits, ATO, tax statements, family trust balances, dividends, capital gains, "
    "closing price, opening price, trading volume, AUD balances, FY2024, and accounting ledgers."
)

SILENCE_HALLUCINATIONS = {
    "you", "thank you", "thanks for watching", "thank you for watching", "subtitles by",
    "bye", "[music]", "[applause]", "[blank_audio]", "(silence)", "okay",
}

# Australian English voice options
DEFAULT_AUSTRALIAN_VOICE = "en-AU-NatashaNeural"  # Natural Australian female voice
ALTERNATIVE_AUSTRALIAN_VOICE = "en-AU-WilliamNeural"  # Natural Australian male voice


def get_whisper_model():
    global _whisper_model, _whisper_failed
    if _whisper_model is not None:
        return _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            try:
                from faster_whisper import WhisperModel
                logger.info("Initializing faster-whisper %s model...", settings.WHISPER_MODEL_SIZE)
                # One thread per physical core. Using every logical (hyper-threaded) core made
                # transcription 3-8x slower whenever the browser was also busy on the same machine.
                threads = settings.WHISPER_CPU_THREADS or max(1, (os.cpu_count() or 2) // 2)
                _whisper_model = WhisperModel(
                    model_size_or_path=settings.WHISPER_MODEL_SIZE or "base.en",
                    device=settings.WHISPER_DEVICE or "cpu",
                    compute_type="int8",
                    cpu_threads=threads,
                )
                _whisper_failed = None
            except Exception as e:
                _whisper_failed = str(e)
                raise
    return _whisper_model


def _silent_wav(seconds: float = 0.5, rate: int = 16000) -> bytes:
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()


def warm_up_stt() -> None:
    """
    Prepare speech-to-text before the first voice turn: find out whether Groq Whisper is usable
    (a blocked model otherwise costs a ~1.3 s failed round-trip on the user's first utterance),
    then load the local Whisper model and run one tiny inference so its first real call is fast.
    """
    transcribe_with_groq(_silent_wav(), ".wav")
    try:
        model = get_whisper_model()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(_silent_wav(1.0))
            path = Path(f.name)
        try:
            # vad_filter=True also loads the Silero VAD model the real requests use
            list(model.transcribe(str(path), language="en", beam_size=1, vad_filter=True)[0])
        finally:
            path.unlink(missing_ok=True)
        logger.info("Local Whisper ready.")
    except Exception as e:
        logger.warning("Local Whisper unavailable: %s", e)


def stt_status() -> dict:
    """Fixed state words only: raw error text stays in the server log (Audit I-23)."""
    if settings.is_local_mode:
        groq = "disabled (local privacy mode)"
    elif not settings.GROQ_API_KEY or settings.GROQ_API_KEY.startswith("your-"):
        groq = "not configured"
    elif time.time() < _groq_stt_blocked_until or _groq_stt_last_error:
        groq = "unavailable"
    else:
        groq = "available"
    if _whisper_model is not None:
        local = "loaded"
    elif _whisper_failed:
        local = "failed"
    else:
        local = "not loaded yet"
    return {"groq_whisper": groq, "local_whisper": local}


def is_probable_hallucination(transcript: str) -> bool:
    clean = transcript.strip().lower().rstrip(".,!? ")
    return not clean or len(clean) < 2 or clean in SILENCE_HALLUCINATIONS


def clean_text_for_speech(text: str) -> str:
    """Strip markdown formatting, URLs, and code blocks for fluid Australian voice delivery."""
    # Remove multi-line code blocks
    text = re.sub(r"```[\s\S]*?```", "", text)
    # Strip backticks from inline code while preserving content (e.g. `$13,750` -> $13,750)
    text = re.sub(r"`(.*?)`", r"\1", text)
    # Convert markdown links [Label](url) to just Label
    text = re.sub(r"\[(.*?)\]\(.*?\)", r"\1", text)
    # Drop Markdown table rows and citation markers like [1] or [2][3]
    text = "\n".join(line for line in text.splitlines() if not line.strip().startswith("|"))
    text = re.sub(r"(\[\d+\])+", "", text)
    # Remove markdown headers and emphasis
    text = re.sub(r"[#*_~]", "", text)
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Normalize excessive whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\s+([.,!?;:])", r"\1", text)


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
    """Transcribe speech using Groq cloud Whisper. Returns None when unavailable (caller falls back)."""
    global _groq_stt_blocked_until, _groq_stt_last_error
    if settings.is_local_mode:
        return None  # audio never leaves the deployment in local mode (Audit I-09)
    if not settings.GROQ_API_KEY or settings.GROQ_API_KEY.startswith("your-"):
        return None
    if time.time() < _groq_stt_blocked_until:
        return None
    try:
        from groq import Groq
        client = Groq(api_key=settings.GROQ_API_KEY)
        res = client.audio.transcriptions.create(
            file=(f"audio{suffix}", audio_bytes),
            model=settings.GROQ_STT_MODEL or "whisper-large-v3-turbo",
            response_format="json",
            language="en",
            prompt=STT_VOCAB_PROMPT,
        )
        _groq_stt_last_error = None
        return (res.text or "").strip() if res else ""
    except Exception as e:
        err = str(e)
        if "model_permission_blocked_org" in err or "403" in err or "model_terms_required" in err:
            _groq_stt_blocked_until = time.time() + 600
            _groq_stt_last_error = (
                f"blocked for this Groq org - enable {settings.GROQ_STT_MODEL} at "
                "https://console.groq.com/settings/limits"
            )
        else:
            _groq_stt_blocked_until = time.time() + 30
            _groq_stt_last_error = err[:200]
        logger.warning("Groq STT unavailable (%s). Falling back to local Whisper.", err[:200])
    return None


def transcribe_audio_file(audio_path: Path) -> str:
    """Transcribe an audio file using local faster-whisper with Voice Activity Detection."""
    model = get_whisper_model()
    segments, info = model.transcribe(
        str(audio_path),
        # Greedy decoding: same transcript quality on short spoken questions, and beam search (5)
        # caused erratic 9-13 s stalls on CPU (median 1.0 s / max 1.7 s greedy vs max 12.7 s beam).
        beam_size=1,
        temperature=0.0,
        language="en",
        condition_on_previous_text=False,
        initial_prompt=STT_VOCAB_PROMPT,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
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
    if cloud_transcript is not None:
        return cloud_transcript

    # 2. Local fallback using faster-whisper
    with tempfile.NamedTemporaryFile(suffix=detected_suffix, delete=False) as temp_audio:
        temp_path = Path(temp_audio.name)
        temp_audio.write(audio_bytes)
        temp_audio.flush()

    try:
        t0 = time.perf_counter()
        text = transcribe_audio_file(temp_path)
        logger.info("Local Whisper transcribed %d bytes in %.2fs: %r", len(audio_bytes), time.perf_counter() - t0, text[:80])
        return text
    except Exception as e:
        logger.error("Audio transcription error: %s", e)
        return ""
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


async def synthesize_speech(text: str, voice: Optional[str] = None) -> bytes:
    """Synthesize speech with Australian English neural voice, falling back to local Windows SAPI5.
    In local privacy mode only the on-device engine is used: edge-tts sends the answer text to Microsoft."""
    if settings.is_local_mode:
        try:
            return await asyncio.to_thread(synthesize_speech_pyttsx3, text)
        except Exception as e:
            logger.warning(f"Local pyttsx3 speech synthesis failed: {e}")
            return b""
    try:
        # edge-tts talks to a Microsoft websocket; never let a stalled connection hang the request
        audio = await asyncio.wait_for(
            synthesize_speech_edge(text, voice or settings.TTS_VOICE or DEFAULT_AUSTRALIAN_VOICE), timeout=15
        )
        if audio and len(audio) > 100:
            return audio
    except Exception as e:
        logger.warning(f"edge-tts unavailable, falling back to local SAPI5: {e}")

    try:
        return await asyncio.to_thread(synthesize_speech_pyttsx3, text)
    except Exception as e:
        logger.warning(f"Local pyttsx3 speech synthesis failed: {e}")
        return b""
