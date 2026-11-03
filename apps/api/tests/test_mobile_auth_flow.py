"""
I-12 regression (static checks; the mobile app has no JS test runner): the Expo app must sign in
before calling the API, send the bearer token on every authenticated call, return to sign-in on any
401, take its family entities from the user's memberships, and never persist the token on device.
"""
import re
from pathlib import Path

MOBILE = Path(__file__).resolve().parents[3] / "apps" / "mobile"


def _read(rel: str) -> str:
    return (MOBILE / rel).read_text(encoding="utf-8")


def _sources():
    yield MOBILE / "App.tsx"
    yield from (MOBILE / "src").rglob("*.ts*")


def test_app_is_gated_by_sign_in():
    app = _read("App.tsx")
    assert re.search(r"if \(!session\) \{\s*return \(", app)
    assert "<LoginScreen" in app
    # the workspace (header, chat, vault) is only rendered after the gate
    assert app.index("if (!session)") < app.index("<Header")


def test_every_api_call_sends_the_token_and_checks_401():
    api = _read("src/services/api.ts")
    calls = re.findall(r"fetch\(`\$\{activeBaseUrl\}(/api/[^`$]*)", api)
    assert calls, "no API calls found"
    for block in re.split(r"\nexport async function ", api)[1:]:
        name = block.split("(", 1)[0]
        if name in ("loginUser",):
            continue
        assert "getAuthHeaders(" in block, f"{name} does not send the bearer token"
        if name != "logoutUser":
            assert "ensureOk(res" in block, f"{name} does not route errors through ensureOk"
    ensure = api[api.index("async function ensureOk"):]
    assert "res.status === 401" in ensure[:600] and "unauthorizedHandler?.()" in ensure[:600]


def test_unauthorized_handler_returns_to_sign_in_and_clears_data():
    app = _read("App.tsx")
    body = app[app.index("setUnauthorizedHandler(() => {"):]
    body = body[:body.index("});")]
    assert "setSession(null)" in body and "resetWorkspace()" in body


def test_logout_revokes_token_server_side():
    api = _read("src/services/api.ts")
    assert "/api/auth/logout" in api
    assert "onLogout={handleLogout}" in _read("App.tsx")


def test_entities_come_from_memberships_not_hardcoded_ids():
    for path in _sources():
        text = path.read_text(encoding="utf-8")
        assert "default_family" not in text, path
        assert "Smith Family Trust" not in text and "personal_portfolio" not in text, path
    header = _read("src/components/Header.tsx")
    assert "memberships.map(" in header
    app = _read("App.tsx")
    assert "setSelectedEntity(next.user.memberships[0].family_entity_id)" in app


def test_token_is_never_persisted_on_device():
    for path in _sources():
        text = path.read_text(encoding="utf-8")
        for store in ("AsyncStorage", "SecureStore", "localStorage", "MMKV"):
            assert store not in text, f"{path} persists data via {store}"
