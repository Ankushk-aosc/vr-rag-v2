import pytest
from app.services import voice


def test_clean_text_for_speech():
    raw_markdown = """
    ### Tax Year 2024 Summary
    Your taxable income is **$125,000 AUD**.
    * Superannuation Guarantee: `$13,750`
    * Medicare Levy: `$2,500`
    
    ```python
    def calc(): pass
    ```
    Please consult [ATO Portal](https://ato.gov.au).
    """

    cleaned = voice.clean_text_for_speech(raw_markdown)

    assert "###" not in cleaned
    assert "**" not in cleaned
    assert "```" not in cleaned
    assert "Your taxable income is $125,000 AUD." in cleaned
    assert "Superannuation Guarantee: $13,750" in cleaned
    assert "Medicare Levy: $2,500" in cleaned
    assert "ATO Portal" in cleaned
    assert "https://" not in cleaned


@pytest.mark.asyncio
async def test_speech_synthesis_generates_audio():
    sample_text = "G'day. Your Australian superannuation balance is currently $142,500 AUD."
    audio_bytes = await voice.synthesize_speech(sample_text)

    # Must return valid audio byte payload
    assert audio_bytes is not None
    assert len(audio_bytes) > 200
