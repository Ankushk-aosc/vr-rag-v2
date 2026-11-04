"""
End-to-end cross-tenant RAG security: two families, each with a document holding a unique secret.

The model is replaced by an "echo" model that repeats its entire input back as the answer, the
worst case for a leak: anything that reached the prompt would appear in the HTTP response. Each test
also inspects the exact prompt text, the raw retriever outputs and the citations, and counts
occurrences of the other family's secret, id and filename (must be 0 everywhere).
"""
import re
import uuid
import zlib

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import session as db_session
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.providers import factory
from app.providers.llm.fake import FakeLLM
from app.services import embeddings, local_vector_index
from app.services import rag_engine
from app.services import rag_orchestrator as orch
from app.services.lexical_index import lexical_index
from app.services.storage import storage_service

SECRET_A = "FAMILY_A_SECRET_123"
SECRET_B = "FAMILY_B_SECRET_456"
DIM = settings.EMBEDDING_DIMENSION


def _bag_of_words(text):
    vec = np.zeros(DIM, dtype=np.float32)
    for tok in re.findall(r"[a-z0-9_]+", text.lower()):
        vec[zlib.crc32(tok.encode()) % DIM] += 1.0
    return vec.tolist()


class EchoLLM(FakeLLM):
    """Returns the whole prompt as its answer (streamed or not), and records it."""

    def __init__(self):
        super().__init__()
        self.prompts = []

    def _echo(self, messages):
        prompt = "\n".join(str(m.get("content", "")) for m in messages)
        self.prompts.append(prompt)
        return "ECHO OF CONTEXT:\n" + prompt

    async def stream(self, messages):
        yield self._echo(messages)

    async def chat(self, messages, **kwargs):
        self.script = [self._echo(messages)]
        return await super().chat(messages, **kwargs)


@pytest.fixture
def tenants(tmp_path, monkeypatch, local_mode):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "secrets.db"))
    monkeypatch.setattr(db_session, "_engine", None)
    monkeypatch.setattr(db_session, "_sessionmaker", None)
    monkeypatch.setattr(settings, "LLM_PROVIDER", "fake")
    monkeypatch.setattr(storage_service, "local_dir", tmp_path / "uploads")
    (tmp_path / "uploads").mkdir()
    monkeypatch.setattr(embeddings, "embed_texts", lambda texts, **_: [_bag_of_words(t) for t in texts])
    monkeypatch.setattr(embeddings, "embed_query", lambda q, **_: _bag_of_words(q))
    local_vector_index._cache.clear()
    sqlite.init_db()
    limiter.reset()
    llm = EchoLLM()
    monkeypatch.setattr(factory, "get_llm", lambda *a, **k: llm)
    monkeypatch.setattr(rag_engine, "get_llm", lambda *a, **k: llm)

    # Spies on what each retriever actually returns, before any downstream filtering
    retrieved = {"vector": [], "lexical": []}
    real_vec, real_lex = local_vector_index.query_similar_chunks, lexical_index.search

    def vec_spy(*a, **k):
        hits = real_vec(*a, **k)
        retrieved["vector"].extend(hits)
        return hits

    def lex_spy(*a, **k):
        hits = real_lex(*a, **k)
        retrieved["lexical"].extend(hits)
        return hits

    monkeypatch.setattr(local_vector_index, "query_similar_chunks", vec_spy)
    monkeypatch.setattr(lexical_index, "search", lex_spy)

    client = TestClient(app)
    users = {}
    for fam, name in (("a", "Family A Trust"), ("b", "Family B Holdings")):
        res = client.post("/api/auth/register", json={
            "email": f"user-{fam}-{uuid.uuid4().hex[:6]}@t.test", "password": "StrongPassword123!",
            "full_name": f"User {fam.upper()}", "family_entity_name": name})
        assert res.status_code == 201, res.text
        body = res.json()
        users[fam] = {"headers": {"Authorization": f"Bearer {body['access_token']}"},
                      "family": body["user"]["memberships"][0]["family_entity_id"], "id": body["user"]["id"]}

    def upload(fam, filename, text):
        res = client.post("/api/documents/upload", files={"file": (filename, text.encode(), "text/plain")},
                          headers=users[fam]["headers"])
        assert res.status_code == 201, res.text
        return res.json()["document"]["id"]

    users["a"]["doc"] = upload("a", "family_a_vault.txt", f"The Family A vault code is {SECRET_A}. Trust deed dated 2019.")
    users["b"]["doc"] = upload("b", "family_b_vault.txt", f"The Family B vault code is {SECRET_B}. Yacht registry 2021.")
    # Fresh client per request so no session cookie from registration can stand in for a header
    return {"users": users, "llm": llm, "retrieved": retrieved, "client": lambda: TestClient(app)}


def _leaks(text, other):
    """Count every way the other family's data could appear in some text."""
    return sum(text.count(s) for s in (other["secret"], other["doc"], other["family"], other["filename"]))


def _other(t, fam):
    o = "b" if fam == "a" else "a"
    u = t["users"][o]
    return {"secret": SECRET_B if o == "b" else SECRET_A, "doc": u["doc"], "family": u["family"],
            "filename": f"family_{o}_vault.txt"}


@pytest.mark.parametrize("asker,stream", [("a", False), ("b", False), ("a", True), ("b", True)])
def test_each_family_cannot_obtain_the_others_secret(tenants, asker, stream):
    t = tenants
    other = _other(t, asker)
    question = f"What is {other['secret']}?"
    url = "/api/query/stream" if stream else "/api/query"
    res = t["client"]().post(url, json={"question": question}, headers=t["users"][asker]["headers"])
    assert res.status_code == 200, res.text

    # 1. Retrieval: no chunk of the other family was returned by either retriever
    for kind in ("vector", "lexical"):
        for hit in t["retrieved"][kind]:
            doc_id = hit.get("document_id") or hit.get("metadata", {}).get("document_id")
            assert doc_id != other["doc"], f"{kind} retriever returned the other family's chunk"
    # 2. LLM boundary: the exact prompt holds 0 occurrences outside the user's own question
    assert t["llm"].prompts, "the model should have been called with the asker's own evidence"
    for prompt in t["llm"].prompts:
        evidence = prompt.replace(question, "")
        assert _leaks(evidence, other) == 0, "unauthorized text reached the LLM"
    # 3. Response: the echoed context, citations and metadata carry none of it
    body = res.text.replace(question, "")
    assert _leaks(body, other) == 0, "unauthorized data appeared in the response"
    if not stream:
        assert all(c["document_id"] == t["users"][asker]["doc"] for c in res.json()["citations"])


def test_own_secret_is_retrievable(tenants):
    t = tenants
    res = t["client"]().post("/api/query", json={"question": f"What is {SECRET_A}?"}, headers=t["users"]["a"]["headers"])
    assert res.status_code == 200
    assert t["users"]["a"]["doc"] in {c["document_id"] for c in res.json()["citations"]}
    assert SECRET_A in t["llm"].prompts[-1].replace(f"What is {SECRET_A}?", "")


@pytest.mark.parametrize("method,path,payload", [
    ("post", "/api/query", {"question": "What is FAMILY_B_SECRET_456?"}),
    ("post", "/api/query/stream", {"question": "What is FAMILY_B_SECRET_456?"}),
    ("post", "/api/dashboards", {"question": "chart FAMILY_B_SECRET_456"}),
    ("get", "/api/documents", None),
    ("get", "/api/documents/suggestions", None),
    ("get", "/api/auth/audit", None),
])
def test_browser_supplied_family_id_cannot_select_another_tenant(tenants, method, path, payload):
    t = tenants
    fam_b = t["users"]["b"]["family"]
    c = t["client"]()
    if method == "post":
        res = c.post(path, json={**payload, "family_entity_id": fam_b}, headers=t["users"]["a"]["headers"])
    else:
        res = c.get(path, params={"family_entity_id": fam_b}, headers=t["users"]["a"]["headers"])
    assert res.status_code == 403 and res.json() == {"detail": "Access denied."}
    assert SECRET_B not in res.text and not t["llm"].prompts


def test_upload_targeting_another_tenant_is_denied(tenants):
    t = tenants
    res = t["client"]().post(
        "/api/documents/upload", files={"file": ("x.txt", b"planted", "text/plain")},
        data={"family_entity_id": t["users"]["b"]["family"]}, headers=t["users"]["a"]["headers"])
    assert res.status_code == 403
    assert sqlite.get_documents_by_entity(t["users"]["b"]["family"], "family_admin")[0]["id"] == t["users"]["b"]["doc"]
    assert len(sqlite.get_documents_by_entity(t["users"]["b"]["family"], "family_admin")) == 1


@pytest.mark.parametrize("method,suffix", [("get", ""), ("get", "/table"), ("delete", "")])
def test_foreign_and_unknown_document_ids_are_indistinguishable(tenants, method, suffix):
    t = tenants
    c, h = t["client"](), t["users"]["a"]["headers"]
    foreign = getattr(c, method)(f"/api/documents/{t['users']['b']['doc']}{suffix}", headers=h)
    unknown = getattr(c, method)(f"/api/documents/{uuid.uuid4()}{suffix}", headers=h)
    assert foreign.status_code == unknown.status_code == 403
    assert foreign.json() == unknown.json() == {"detail": "Access denied."}
    assert SECRET_B not in foreign.text
    assert sqlite.get_document_by_id(t["users"]["b"]["doc"]) is not None  # delete did nothing


def test_unauthenticated_requests_are_401(tenants):
    c = tenants["client"]()
    doc_b = tenants["users"]["b"]["doc"]
    for method, path in (("post", "/api/query"), ("get", "/api/documents"), ("get", f"/api/documents/{doc_b}"),
                         ("delete", f"/api/documents/{doc_b}")):
        res = c.post(path, json={"question": "x"}) if method == "post" else getattr(c, method)(path)
        assert res.status_code == 401, path


@pytest.mark.parametrize("pipeline", ["orchestrator", "rag_engine"])
def test_leaky_retrievers_are_filtered_before_the_llm(tenants, monkeypatch, pipeline):
    """Both retrievers are broken on purpose and return Family B's chunk to Family A. The scope check
    sits between retrieval and the context builder, so the model (which would echo it) never sees it."""
    t = tenants
    b = t["users"]["b"]
    leaked_vec = {"chunk_id": f"{b['doc']}_p1_c0", "score": 0.99,
                  "text": f"The Family B vault code is {SECRET_B}.",
                  "metadata": {"document_id": b["doc"], "family_entity_id": b["family"], "page_number": 1,
                               "original_name": "family_b_vault.txt"}}
    leaked_lex = {"chunk_id": f"{b['doc']}_p1_c0", "document_id": b["doc"], "family_entity_id": b["family"],
                  "page_number": 1, "original_name": "family_b_vault.txt", "allowed_roles": ["family_admin"],
                  "text": f"The Family B vault code is {SECRET_B}.", "lexical_score": 99.0}
    module = orch if pipeline == "orchestrator" else rag_engine
    real_sem = module._semantic_search

    async def leaky_sem(*a, **k):
        return [leaked_vec] + await real_sem(*a, **k)

    real_lex = lexical_index.search
    monkeypatch.setattr(module, "_semantic_search", leaky_sem)
    monkeypatch.setattr(lexical_index, "search", lambda *a, **k: [leaked_lex] + real_lex(*a, **k))

    question = "What is the vault code?"
    if pipeline == "orchestrator":
        res = t["client"]().post("/api/query", json={"question": question}, headers=t["users"]["a"]["headers"])
        assert res.status_code == 200, res.text
        body, cites = res.text, res.json()["citations"]
    else:
        import asyncio
        from app.services import authorization
        user = {"id": t["users"]["a"]["id"], "memberships": [{"family_entity_id": t["users"]["a"]["family"], "role": "family_admin"}]}
        scope = authorization.authorize_query(user)
        out = asyncio.run(rag_engine.execute_rag_query(question, scope=scope, user_id=scope.user_id))
        body, cites = str(out), out["citations"]
    assert t["llm"].prompts, "pipeline should reach the model with the asker's own evidence"
    other = _other(t, "a")
    assert sum(_leaks(p, other) for p in t["llm"].prompts) == 0, "leaked chunk reached the LLM"
    assert _leaks(body, other) == 0
    assert all(c["document_id"] != b["doc"] for c in cites)


# ----------------------------------------------------------------- role x permission matrix (API level)

@pytest.fixture
def roles(tenants):
    """Family A admin plus an invited member and adviser."""
    t = tenants
    admin_h = t["users"]["a"]["headers"]
    out = {"family_admin": admin_h}
    for role in ("family_member", "read_only_adviser"):
        inv = t["client"]().post("/api/auth/invites", json={"family_entity_id": t["users"]["a"]["family"], "role": role},
                                 headers=admin_h)
        assert inv.status_code == 201, inv.text
        reg = t["client"]().post("/api/auth/register", json={
            "email": f"{role}-{uuid.uuid4().hex[:6]}@t.test", "password": "StrongPassword123!",
            "full_name": role, "invite_token": inv.json()["invite_token"]})
        assert reg.status_code == 201, reg.text
        out[role] = {"Authorization": f"Bearer {reg.json()['access_token']}"}
    return out


EXPECTED = {  # permission -> roles that may exercise it through the API
    "document.read": {"family_admin", "family_member", "read_only_adviser"},
    "document.upload": {"family_admin", "family_member"},
    "document.delete": {"family_admin"},
    "query.execute": {"family_admin", "family_member", "read_only_adviser"},
    "audit.read": {"family_admin"},
    "invites.manage": {"family_admin"},
}


@pytest.mark.parametrize("role", ["family_admin", "family_member", "read_only_adviser"])
def test_role_permission_matrix_through_the_api(tenants, roles, role):
    t, h = tenants, roles[role]
    fam = t["users"]["a"]["family"]
    c = t["client"]()

    def ok(res, allowed):
        assert (res.status_code < 400) == allowed, (role, res.status_code, res.text[:200])

    ok(c.get(f"/api/documents/{t['users']['a']['doc']}", headers=h), role in EXPECTED["document.read"])
    ok(c.post("/api/query", json={"question": "vault code?"}, headers=h), role in EXPECTED["query.execute"])
    ok(c.post("/api/documents/upload", files={"file": (f"{uuid.uuid4().hex}.txt", f"note {uuid.uuid4()}".encode(), "text/plain")},
              headers=h), role in EXPECTED["document.upload"])
    ok(c.get("/api/auth/audit", params={"family_entity_id": fam}, headers=h), role in EXPECTED["audit.read"])
    ok(c.post("/api/auth/invites", json={"family_entity_id": fam, "role": "family_member"}, headers=h),
       role in EXPECTED["invites.manage"])
    # Delete last, on a throwaway document uploaded by the admin
    victim = c.post("/api/documents/upload", files={"file": (f"{uuid.uuid4().hex}.txt", f"tmp {uuid.uuid4()}".encode(), "text/plain")},
                    headers=roles["family_admin"]).json()["document"]["id"]
    ok(c.delete(f"/api/documents/{victim}", headers=h), role in EXPECTED["document.delete"])
