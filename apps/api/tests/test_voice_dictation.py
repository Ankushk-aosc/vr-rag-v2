"""
Push-to-talk dictation (apps/web/src/lib/voice/dictation.ts), run as real TypeScript in Node with
browser APIs faked: permission granted/denied, unsupported formats, empty and valid recordings,
transcription failure/success, authentication failure, cancellation, track cleanup and duplicate
starts. Backend voice checks (empty upload, auth, synthesis failure, voice configuration) follow.
"""
import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import voice

REPO_ROOT = Path(__file__).resolve().parents[3]
LOADER_URI = (REPO_ROOT / "apps" / "web" / "test-loader.mjs").as_uri()

HARNESS = r"""
import { Dictation, pickMimeType, validateRecording, PREFERRED_MIME_TYPES } from './apps/web/src/lib/voice/dictation.ts';
import { ApiError } from './apps/web/src/lib/apiErrors.ts';

const log = [];
const tracks = [];
function fakeStream() {
  const t = { stopped: false, stop() { this.stopped = true; } };
  tracks.push(t);
  return { getTracks: () => [t], getAudioTracks: () => [t] };
}
function makeRecorder({ supported = PREFERRED_MIME_TYPES, bytes = 4000, throwOnCreate = false } = {}) {
  return class FakeRecorder {
    static isTypeSupported(t) { return supported.includes(t); }
    constructor(stream, opts) {
      if (throwOnCreate) throw new Error('nope');
      this.mimeType = opts?.mimeType || 'audio/webm';
      this.state = 'inactive';
      this.created = opts;
      FakeRecorder.last = this;
    }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      if (bytes > 0) this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
      queueMicrotask(() => this.onstop?.());
    }
  };
}
let clock = 0;
function make({ gum, Rec, transcribe } = {}) {
  return new Dictation({
    getUserMedia: gum ?? (async () => fakeStream()),
    MediaRecorder: Rec ?? makeRecorder(),
    transcribe: transcribe ?? (async (blob) => { log.push({ sent: blob.size, type: blob.type }); return '  What is the cash rate?  '; }),
    now: () => clock,
    log: (e, d) => log.push({ e, ...d }),
  });
}
const out = {};
"""


def _run(body: str) -> dict:
    script = HARNESS + body + "\nconsole.log('RESULT ' + JSON.stringify(out));"
    res = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--loader", LOADER_URI, "-e", script],
                         cwd=str(REPO_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        raise AssertionError(f"node failed:\n{res.stderr}\n{res.stdout}")
    line = next(l for l in res.stdout.splitlines() if l.startswith("RESULT "))
    return json.loads(line[len("RESULT "):])


def test_1_permission_granted_records_and_releases_tracks():
    out = _run("""
      const d = make(); clock = 0;
      out.started = await d.start();
      out.stateWhileRecording = d.snapshot.state;
      out.mime = (await import('./apps/web/src/lib/voice/dictation.ts')).PREFERRED_MIME_TYPES[0];
      clock = 2500;
      out.text = await d.stop();
      out.state = d.snapshot.state;
      out.tracksStopped = tracks.every(t => t.stopped);
    """)
    assert out["started"] is True and out["stateWhileRecording"] == "recording"
    assert out["text"] == "What is the cash rate?" and out["state"] == "completed"
    assert out["tracksStopped"] is True


def test_2_permission_denied_is_actionable():
    out = _run("""
      const d = make({ gum: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; } });
      out.started = await d.start();
      out.state = d.snapshot.state; out.message = d.snapshot.message;
    """)
    assert out["started"] is False and out["state"] == "error"
    assert out["message"] == ("Microphone access is blocked. Please allow microphone access in your browser "
                              "settings and try again.")


def test_3_mime_negotiation_and_unsupported_formats():
    out = _run("""
      out.prefersOpus = pickMimeType(makeRecorder());
      out.fallsBack = pickMimeType(makeRecorder({ supported: ['audio/mp4'] }));
      out.browserChooses = pickMimeType(makeRecorder({ supported: [] }));
      out.noRecorder = pickMimeType(undefined);
      const d = make({ Rec: makeRecorder({ supported: ['audio/mp4'] }) }); clock = 0;
      await d.start(); clock = 1500;
      await d.stop();
      out.sentType = log.find(x => x.sent)?.type;
      const broken = make({ Rec: makeRecorder({ throwOnCreate: true }) });
      out.brokenStarted = await broken.start();
      out.brokenMsg = broken.snapshot.message;
      out.brokenTracksStopped = tracks.every(t => t.stopped);
    """)
    assert out["prefersOpus"] == "audio/webm;codecs=opus"
    assert out["fallsBack"] == "audio/mp4" and out["browserChooses"] == "" and out["noRecorder"] is None
    assert out["sentType"] == "audio/mp4"  # the Blob is labelled with the format actually recorded
    assert out["brokenStarted"] is False and "not supported" in out["brokenMsg"] and out["brokenTracksStopped"]


def test_4_empty_and_too_short_recordings_are_never_sent():
    out = _run("""
      const sent = [];
      const d = make({ Rec: makeRecorder({ bytes: 0 }), transcribe: async (b) => { sent.push(b.size); return 'x'; } });
      clock = 0; await d.start(); clock = 3000; await d.stop();
      out.emptyMsg = d.snapshot.message; out.emptyState = d.snapshot.state;
      const short = make({ transcribe: async (b) => { sent.push(b.size); return 'x'; } });
      clock = 0; await short.start(); clock = 100; await short.stop();
      out.shortMsg = short.snapshot.message;
      out.sent = sent;
      out.validOk = validateRecording(new Blob([new Uint8Array(10)], { type: 'audio/webm' }), 1000);
      out.badType = validateRecording(new Blob([new Uint8Array(10)], { type: 'text/plain' }), 1000);
    """)
    assert out["emptyState"] == "error" and "Nothing was recorded" in out["emptyMsg"]
    assert "too short" in out["shortMsg"]
    assert out["sent"] == [] and out["validOk"] is None and "unsupported audio format" in out["badType"]


def test_5_valid_recording_logs_only_safe_diagnostics():
    out = _run("""
      const d = make(); clock = 0; await d.start(); clock = 4200; await d.stop();
      out.diag = log.find(x => x.e === 'dictation-recording');
    """)
    assert out["diag"] == {"e": "dictation-recording", "mimeType": "audio/webm;codecs=opus", "bytes": 4000, "durationMs": 4200}


def test_6_and_8_transcription_failure_and_auth_failure_are_surfaced():
    out = _run("""
      const down = make({ transcribe: async () => { throw new ApiError(503, ''); } });
      clock = 0; await down.start(); clock = 2000; out.downText = await down.stop();
      out.downState = down.snapshot.state; out.downMsg = down.snapshot.message;
      const expired = make({ transcribe: async () => { throw new ApiError(401, 'Authentication required.'); } });
      clock = 0; await expired.start(); clock = 2000; await expired.stop();
      out.authMsg = expired.snapshot.message;
      const silent = make({ transcribe: async () => '' });
      clock = 0; await silent.start(); clock = 2000; await silent.stop();
      out.silentMsg = silent.snapshot.message;
      out.errorLogsHaveNoText = log.filter(x => x.e === 'dictation-transcribe-error').every(x => Object.keys(x).join() === 'e,status');
    """)
    assert out["downText"] == "" and out["downState"] == "error" and "temporarily unavailable" in out["downMsg"]
    assert out["authMsg"] == "Your session has ended. Please sign in again to use voice input."
    assert "No words were recognised" in out["silentMsg"]
    assert out["errorLogsHaveNoText"] is True


def test_7_successful_transcription_is_returned_not_submitted():
    out = _run("""
      const d = make(); clock = 0; await d.start(); clock = 1800;
      out.text = await d.stop(); out.snapshot = d.snapshot;
    """)
    # The caller puts it in the input box; the module has no way to submit a query
    assert out["text"] == "What is the cash rate?" and out["snapshot"]["transcript"] == "What is the cash rate?"


def test_duplicate_start_cancel_and_no_stuck_state():
    out = _run("""
      let resolveGum;
      const d = make({ gum: () => new Promise(r => { resolveGum = r; }) });
      const first = d.start();
      out.second = await d.start();            // duplicate while requesting permission
      d.cancel();                              // user cancels before permission resolves
      resolveGum(fakeStream());
      out.firstResult = await first;
      out.afterCancel = d.snapshot.state;
      out.tracksStopped = tracks.every(t => t.stopped);
      const e = make(); clock = 0; await e.start(); e.cancel();
      out.cancelledState = e.snapshot.state;
      out.restart = await e.start();
    """)
    assert out["second"] is False and out["firstResult"] is False
    assert out["afterCancel"] == "ready" and out["tracksStopped"] is True
    assert out["cancelledState"] == "ready" and out["restart"] is True


def test_unsupported_browser():
    out = _run("""
      const d = new Dictation({ getUserMedia: async () => fakeStream(), MediaRecorder: undefined, transcribe: async () => '' });
      globalThis.MediaRecorder = undefined;
      out.started = await d.start(); out.message = d.snapshot.message;
    """)
    assert out["started"] is False and "not supported in this browser" in out["message"]


# ----------------------------------------------------------------- backend voice endpoints

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "voice.db"))
    sqlite.init_db()
    limiter.reset()
    c = TestClient(app)
    res = c.post("/api/auth/register", json={"email": "voice@t.test", "password": "StrongPassword123!",
                                            "full_name": "Voice", "family_entity_name": "Voice Trust"})
    assert res.status_code == 201
    c.headers.update({"Authorization": f"Bearer {res.json()['access_token']}"})
    return c


def test_transcribe_rejects_empty_and_unauthenticated(client):
    assert client.post("/api/voice/transcribe", files={"file": ("u.webm", b"", "audio/webm")}).status_code == 400
    assert TestClient(app).post("/api/voice/transcribe", files={"file": ("u.webm", b"x" * 2000, "audio/webm")}).status_code == 401


def test_transcribe_success_and_provider_failure(client, monkeypatch):
    monkeypatch.setattr("app.routers.voice.validate_audio_upload", lambda *a, **k: None)
    monkeypatch.setattr(voice, "transcribe_audio_bytes", lambda b, s: "what is the cash rate")
    ok = client.post("/api/voice/transcribe", files={"file": ("u.webm", b"\x1aE\xdf\xa3" + b"0" * 4000, "audio/webm")})
    assert ok.status_code == 200 and ok.json()["transcript"] == "what is the cash rate"

    def boom(b, s):
        raise RuntimeError("provider exploded with key gsk_secret_value")
    monkeypatch.setattr(voice, "transcribe_audio_bytes", boom)
    bad = client.post("/api/voice/transcribe", files={"file": ("u.webm", b"\x1aE\xdf\xa3" + b"0" * 4000, "audio/webm")})
    assert bad.status_code == 503 and "gsk_" not in bad.text and "try again" in bad.json()["detail"]


def test_9_synthesis_failure_is_reported(client, monkeypatch):
    async def nothing(text, v=None):
        return b""
    monkeypatch.setattr(voice, "synthesize_speech", nothing)
    res = client.post("/api/voice/synthesize", json={"text": "Hello"})
    assert res.status_code == 503 and res.json()["detail"] == "Speech synthesis produced no audio."


def test_10_voice_configuration_is_env_driven_and_validated(client, monkeypatch):
    monkeypatch.setattr(settings, "VOICE_ID", "en-AU-WilliamNeural")
    monkeypatch.setattr(settings, "VOICE_OPTIONS", "en-AU-NatashaNeural,en-AU-WilliamNeural")
    monkeypatch.setattr(settings, "PRIVACY_MODE", "cloud")
    body = client.get("/api/voice/voices").json()
    assert body["default"] == "en-AU-WilliamNeural" and body["provider"] == "edge"
    assert body["voices"] == ["en-AU-NatashaNeural", "en-AU-WilliamNeural"]
    used = {}

    async def fake_edge(text, v):
        used["voice"] = v
        return b"ID3" + b"0" * 500
    monkeypatch.setattr(voice, "synthesize_speech_edge", fake_edge)
    assert client.post("/api/voice/synthesize", json={"text": "Hello"}).status_code == 200
    assert used["voice"] == "en-AU-WilliamNeural"           # VOICE_ID, not a hardcoded voice
    assert client.post("/api/voice/synthesize", json={"text": "Hi", "voice": "en-AU-NatashaNeural"}).status_code == 200
    assert used["voice"] == "en-AU-NatashaNeural"
    assert client.post("/api/voice/synthesize", json={"text": "Hi", "voice": "attacker-voice"}).status_code == 422
    monkeypatch.setattr(settings, "PRIVACY_MODE", "local")
    assert client.get("/api/voice/voices").json()["provider"] == "local"  # never edge-tts in local mode
