"""
I-26 regression (static checks, like the phase-6 frontend tests): the web client must not hand user
audio or text to browser-vendor clouds unless the API reports PRIVACY_MODE=cloud, and must not load
fonts from Google at runtime.
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WEB = REPO_ROOT / "apps" / "web" / "src"


def _read(rel: str) -> str:
    return (WEB / rel).read_text(encoding="utf-8")


def _function_body(src: str, signature: str) -> str:
    start = src.index(signature)
    depth, i = 0, src.index("{", start)
    for j in range(i, len(src)):
        depth += {"{": 1, "}": -1}.get(src[j], 0)
        if depth == 0:
            return src[i:j + 1]
    raise AssertionError(f"unterminated body for {signature}")


# The voice engine class is split across these files (Audit I-22); the privacy checks cover all of them
VOICE_ENGINE_FILES = ("voiceConfig.ts", "VoiceEngineCore.ts", "VoiceRecognition.ts", "VoiceEngine.ts")


def _voice_engine() -> str:
    return "\n".join(_read(f"lib/voice/{name}") for name in VOICE_ENGINE_FILES)


def test_privacy_mode_defaults_to_locked():
    store = _read("lib/voice/voiceStore.ts")
    assert 'privacyMode: "unknown"' in store
    assert re.search(r'cloudSpeechAllowed\(\)[^{]*\{\s*return snapshot\.privacyMode === "cloud";', store)


def test_browser_recognition_is_gated_at_the_single_chokepoint():
    engine = _voice_engine()
    body = _function_body(engine, "export function getRecognitionCtor()")
    assert "if (!cloudSpeechAllowed()) return null;" in body
    # Nothing may construct a recogniser except through getRecognitionCtor
    outside = engine.replace(body, "")
    assert not re.search(r"new\s+\(?\s*(window\.)?(webkit)?SpeechRecognition", outside)
    assert outside.count("w.SpeechRecognition") == 0


def test_standby_and_wake_word_need_cloud_mode():
    engine = _voice_engine()
    standby = _function_body(engine, "async startStandby(): Promise<void>")
    assert "if (!cloudSpeechAllowed())" in standby
    end = _function_body(engine, 'endConversation(reason = "user", forceStop = false): void')
    assert "this.wakeWordEnabled && cloudSpeechAllowed() && !forceStop" in end

    setup = _read("lib/useVoiceEngineSetup.ts")
    assert 'if (mode === "cloud") engine.startStandby()' in setup
    # standby must not be started before the API has answered
    assert setup.count("engine.startStandby()") == 1


def test_browser_tts_uses_only_on_device_voices_outside_cloud_mode():
    engine = _voice_engine()
    body = _function_body(engine, "protected speakWithBrowser(text: string, gen: number): Promise<void>")
    assert "cloudSpeechAllowed() || v.localService" in body
    assert body.index("if (!voice && !cloudSpeechAllowed())") < body.index("new SpeechSynthesisUtterance")


def test_privacy_mode_fetch_fails_closed():
    api = _read("lib/api.ts")
    body = _function_body(api, "export async function fetchPrivacyMode(")
    assert 'data.privacy_mode === "cloud" ? "cloud"' in body
    assert 'return "unknown";' in body  # non-OK response and network errors


def test_no_runtime_google_fonts():
    for path in WEB.rglob("*"):
        if path.suffix in {".css", ".ts", ".tsx"}:
            text = path.read_text(encoding="utf-8")
            assert "fonts.googleapis.com" not in text, path
            assert "fonts.gstatic.com" not in text, path
    layout = _read("app/layout.tsx")
    assert 'from "next/font/google"' in layout  # self-hosted at build time
