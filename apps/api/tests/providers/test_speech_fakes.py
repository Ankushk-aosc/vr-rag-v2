import pytest
from app.providers.speech.fake import FakeSTT, FakeTTS


@pytest.mark.asyncio
async def test_fake_stt_deterministic():
    stt = FakeSTT("My Australian financial question")
    assert stt.is_configured() is True
    assert stt.info.requires_key is False

    transcription = await stt.transcribe(b"fake_audio_stream", mime="audio/webm")
    assert transcription.text == "My Australian financial question"
    assert transcription.lang == "en"
    assert transcription.confidence == 1.0


@pytest.mark.asyncio
async def test_fake_tts_deterministic():
    tts = FakeTTS(b"RIFF_FAKE_AUDIO_SAMPLE")
    assert tts.is_configured() is True
    assert tts.info.requires_key is False

    audio_bytes = await tts.synthesize("Welcome to Aether Sovereign", voice="en-AU-NatashaNeural")
    assert audio_bytes == b"RIFF_FAKE_AUDIO_SAMPLE"
