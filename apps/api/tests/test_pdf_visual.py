"""
Visual understanding of PDF pages (services/pdf_visual.py, document_ingest, visual-extract endpoint).

PDFs are generated with PyMuPDF; the vision model is a recording fake so each test can assert what was
(or was not) sent to it and that only legible, sufficiently confident values survive.
"""
import io
import json
import re
import uuid
import zlib
from pathlib import Path

import numpy as np
import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import session as db_session
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.providers import factory
from app.providers.llm.fake import FakeLLM
from app.services import embeddings, extractor, local_vector_index, pdf_visual
from app.services.storage import storage_service

DIM = settings.EMBEDDING_DIMENSION
CASH_RATE = [("Q1 2026", 4.35), ("Q2 2026", 4.10), ("Q3 2026", 3.85), ("Q4 2026", 3.60)]


# ----------------------------------------------------------------- PDF builders

def _chart_page(page, title="Graph 3.1: Cash Rate Target"):
    page.insert_text((60, 70), title, fontsize=16)
    page.insert_text((60, 90), "Per cent", fontsize=10)
    base, scale = 600, 90
    page.draw_line((100, base), (520, base))
    page.draw_line((100, base), (100, 150))
    for tick in range(6):  # gridlines + ticks: many vector drawings, like a real chart
        y = base - tick * scale
        page.draw_line((96, y), (520, y), color=(0.85, 0.85, 0.85))
        page.insert_text((70, y + 4), str(tick), fontsize=9)
    for i, (q, v) in enumerate(CASH_RATE):
        x = 120 + i * 95
        for k in range(4):  # stacked segments, each a separate drawing
            h = v * scale / 4
            page.draw_rect(fitz.Rect(x, base - (k + 1) * h, x + 55, base - k * h), fill=(0.1, 0.3, 0.6))
        page.insert_text((x + 5, base + 16), q, fontsize=9)
    page.insert_text((60, 650), "Source: RBA (synthetic test data)", fontsize=8)


def make_pdf(path: Path, kinds):
    doc = fitz.open()
    for kind in kinds:
        page = doc.new_page(width=595, height=842)
        if kind == "text":
            page.insert_text((60, 80), "Statement on Monetary Policy. The Board decided to lower the cash rate target. " * 3, fontsize=10)
        elif kind == "chart":
            _chart_page(page)
        elif kind == "scanned":
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 300, 200), 0)
            pix.set_rect(pix.irect, (240, 240, 240))
            page.insert_image(fitz.Rect(50, 50, 545, 380), pixmap=pix)
        elif kind == "table":
            rows = [["Quarter", "Cash rate"]] + [[q, f"{v:.2f}"] for q, v in CASH_RATE]
            for r, row in enumerate(rows):
                for c, cell in enumerate(row):
                    rect = fitz.Rect(60 + c * 150, 100 + r * 25, 210 + c * 150, 125 + r * 25)
                    page.draw_rect(rect)
                    page.insert_text((rect.x0 + 5, rect.y0 + 17), cell, fontsize=10)
        elif kind == "blank":
            pass
    doc.save(str(path))
    doc.close()
    return path


# ----------------------------------------------------------------- fake vision model

class FakeVision(FakeLLM):
    def __init__(self, payload=None, fail=False):
        super().__init__()
        self.payload, self.fail, self.images = payload, fail, 0

    async def chat(self, messages, **kwargs):
        content = messages[-1]["content"]
        self.images += sum(1 for part in content if isinstance(part, dict) and part.get("type") == "image_url")
        if self.fail:
            raise RuntimeError("vision provider unavailable")
        self.script = [json.dumps(self.payload) if not isinstance(self.payload, str) else self.payload]
        return await super().chat(messages, **kwargs)


def readable_payload(conf=0.9):
    return {"charts": [{
        "title": "Graph 3.1: Cash Rate Target", "subtitle": "", "x_axis": {"label": "Quarter", "unit": ""},
        "y_axis": {"label": "Cash rate", "unit": "per cent"}, "legend": ["Cash rate target"],
        "series": [{"name": "Cash rate", "points": [{"x": q, "y": v, "confidence": conf} for q, v in CASH_RATE]}],
        "annotations": [], "footnotes": [], "source": "RBA"}], "tables": []}


def unreadable_payload():
    return {"charts": [{
        "title": "Graph 4.2: Household Debt", "subtitle": "Ratio to income", "x_axis": {"label": "Year", "unit": ""},
        "y_axis": {"label": "Ratio", "unit": "per cent"}, "legend": [],
        "series": [{"name": "Debt", "points": [{"x": "2025", "y": None, "confidence": 0.2},
                                                  {"x": "2026", "y": "about 190", "confidence": 0.9},
                                                  {"x": "2024", "y": 187.4, "confidence": 0.3}]}],
        "annotations": [], "footnotes": ["Seasonally adjusted"], "source": "ABS"}], "tables": []}


def _pages(path):
    return extractor.extract_document(path, "application/pdf")


def _enrich(path, llm):
    import asyncio
    pages = _pages(path)
    summary = asyncio.run(pdf_visual.enrich_pages(path, pages, llm=llm))
    return pages, summary


# ----------------------------------------------------------------- unit level

def test_1_text_only_pdf_is_not_sent_to_vision(tmp_path):
    llm = FakeVision(readable_payload())
    pages, summary = _enrich(make_pdf(tmp_path / "t.pdf", ["text"]), llm)
    assert summary["candidates"] == 0 and llm.images == 0
    assert "Visual content" not in pages[0].text


def test_2_chart_pdf_values_become_page_text_table_and_metrics(tmp_path):
    llm = FakeVision(readable_payload())
    pages, summary = _enrich(make_pdf(tmp_path / "c.pdf", ["text", "chart"]), llm)
    assert llm.images == 1 and summary["readable_charts"] == 1
    chart_page = pages[1]
    assert "Chart on page 2: Graph 3.1: Cash Rate Target" in chart_page.text
    assert "approximate" in chart_page.text and "Y axis: Cash rate (per cent)" in chart_page.text
    assert any("Q3 2026 | 3.85" in t for t in chart_page.tables)
    assert {(m["page_number"], m["period"], m["value"]) for m in summary["metrics"]} == {(2, q, v) for q, v in CASH_RATE}
    assert all(m["unit"] == "per cent" and m["confidence"] == 0.9 for m in summary["metrics"])


def test_3_scanned_page_is_rendered_for_vision(tmp_path):
    llm = FakeVision({"charts": [], "tables": [{"title": "Valuation", "columns": ["Item", "Value"],
                                                "rows": [["Land", "1,200,000"], ["Building", "800,000"]]}]})
    pages, summary = _enrich(make_pdf(tmp_path / "s.pdf", ["scanned"]), llm)
    assert pdf_visual.visual_candidates(tmp_path / "s.pdf") == [(1, "scanned_or_image")]
    assert llm.images == 1 and "Table on page 1: Valuation" in pages[0].text


def test_4_text_tables_stay_text_and_are_not_sent_to_vision(tmp_path):
    """A born-digital table already has its values in the text layer: keep them, no vision call."""
    path = make_pdf(tmp_path / "tab.pdf", ["table"])
    llm = FakeVision(readable_payload())
    pages, summary = _enrich(path, llm)
    assert summary["candidates"] == 0 and llm.images == 0
    assert "Q3 2026" in pages[0].text and "3.85" in pages[0].text


def test_4b_tables_read_from_a_page_image_become_markdown_tables(tmp_path):
    llm = FakeVision({"charts": [], "tables": [{"title": "Rates", "columns": ["Quarter", "Cash rate"],
                                                "rows": [[q, str(v)] for q, v in CASH_RATE]}]})
    pages, summary = _enrich(make_pdf(tmp_path / "img.pdf", ["scanned"]), llm)
    assert any("Quarter | Cash rate" in t and "Q4 2026 | 3.6" in t for t in pages[0].tables)


def test_5_page_with_no_extractable_text_is_handled(tmp_path):
    path = make_pdf(tmp_path / "b.pdf", ["blank", "text"])
    pages, summary = _enrich(path, FakeVision({"charts": [], "tables": []}))
    assert pages[0].text == "" and summary["failed_pages"] == []


def test_6_unreadable_chart_is_identified_without_values(tmp_path):
    pages, summary = _enrich(make_pdf(tmp_path / "u.pdf", ["chart"]), FakeVision(unreadable_payload()))
    text = pages[0].text
    assert "Graph 4.2: Household Debt" in text and pdf_visual.UNREADABLE_SENTENCE in text
    assert summary["unreadable_charts"] == 1 and summary["metrics"] == [] and pages[0].tables == []


def test_7_vision_failure_marks_page_and_keeps_text(tmp_path):
    pages, summary = _enrich(make_pdf(tmp_path / "f.pdf", ["chart"]), FakeVision(fail=True))
    assert summary["failed_pages"] == [1] and pdf_visual.NOT_ANALYSED_SENTENCE in pages[0].text
    assert "Graph 3.1" in pages[0].text  # the PDF's own text is still there
    pages2, summary2 = _enrich(make_pdf(tmp_path / "g.pdf", ["chart"]), FakeVision("this is not json"))
    assert summary2["failed_pages"] == [1]


def test_vision_unavailable_never_invents(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "fake")
    assert pdf_visual.get_vision_llm() is None
    pages, summary = _enrich(make_pdf(tmp_path / "n.pdf", ["chart"]), None)
    assert summary["skipped_pages"] == [1] and pdf_visual.NOT_ANALYSED_SENTENCE in pages[0].text


def test_local_privacy_mode_only_uses_private_vision(monkeypatch):
    monkeypatch.setattr(settings, "PRIVACY_MODE", "local")
    monkeypatch.setattr(settings, "LLM_PROVIDER", "groq")
    assert pdf_visual.get_vision_llm() is None  # page images never go to a cloud model in local mode


def test_9_no_hallucinated_values_survive_validation():
    result = pdf_visual.normalise(unreadable_payload())
    chart = result["charts"][0]
    # null, non-numeric text and low-confidence numbers are all dropped
    assert chart["values_readable"] is False and chart["series"] == []
    mixed = pdf_visual.normalise({"charts": [{"title": "T", "series": [{"name": "S", "points": [
        {"x": "A", "y": 1.5, "confidence": 0.95}, {"x": "B", "y": 2.0, "confidence": 0.4}, {"x": "C", "y": True, "confidence": 1}]}]}]})
    assert [p["x"] for p in mixed["charts"][0]["series"][0]["points"]] == ["A"]


# ----------------------------------------------------------------- end to end through the API

def _bow(text):
    vec = np.zeros(DIM, dtype=np.float32)
    for tok in re.findall(r"[a-z0-9.]+", text.lower()):
        vec[zlib.crc32(tok.encode()) % DIM] += 1.0
    return vec.tolist()


class EchoLLM(FakeLLM):
    def __init__(self):
        super().__init__()
        self.prompts = []

    async def stream(self, messages):
        prompt = "\n".join(str(m.get("content", "")) for m in messages)
        self.prompts.append(prompt)
        yield "Answer from evidence [1]."


@pytest.fixture
def api(tmp_path, monkeypatch, local_mode):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "visual.db"))
    monkeypatch.setattr(db_session, "_engine", None)
    monkeypatch.setattr(db_session, "_sessionmaker", None)
    monkeypatch.setattr(settings, "LLM_PROVIDER", "fake")
    monkeypatch.setattr(storage_service, "local_dir", tmp_path / "uploads")
    (tmp_path / "uploads").mkdir()
    monkeypatch.setattr(embeddings, "embed_texts", lambda texts, **_: [_bow(t) for t in texts])
    monkeypatch.setattr(embeddings, "embed_query", lambda q, **_: _bow(q))
    local_vector_index._cache.clear()
    sqlite.init_db()
    limiter.reset()
    vision = FakeVision(readable_payload())
    monkeypatch.setattr(pdf_visual, "get_vision_llm", lambda: vision)
    answer_llm = EchoLLM()
    monkeypatch.setattr(factory, "get_llm", lambda *a, **k: answer_llm)
    fetches = []
    real_fetch = storage_service.fetch_to_temp
    monkeypatch.setattr(storage_service, "fetch_to_temp", lambda *a: fetches.append(a) or real_fetch(*a))

    def user(name):
        c = TestClient(app)
        r = c.post("/api/auth/register", json={"email": f"{name}-{uuid.uuid4().hex[:5]}@t.test", "password": "StrongPassword123!",
                                              "full_name": f"{name} User", "family_entity_name": f"{name} Trust"})
        assert r.status_code == 201
        c.headers.update({"Authorization": f"Bearer {r.json()['access_token']}"})
        return c

    return {"a": user("A"), "b": user("B"), "vision": vision, "llm": answer_llm, "fetches": fetches, "tmp": tmp_path}


def _upload(client, path):
    res = client.post("/api/documents/upload", files={"file": (path.name, path.read_bytes(), "application/pdf")})
    assert res.status_code == 201, res.text
    return res.json()["document"]


def test_8_upload_indexes_chart_values_with_page_citation(api):
    doc = _upload(api["a"], make_pdf(api["tmp"] / "rba_chart_pack.pdf", ["text", "chart", "text"]))
    assert api["vision"].images == 1
    assert doc["visual_extraction"]["readable_charts"] == 1
    res = api["a"].post("/api/query", json={"question": "What was the Cash Rate Target in Q3 2026 in Graph 3.1?"})
    assert res.status_code == 200, res.text
    cites = res.json()["citations"]
    assert any(c["document_id"] == doc["id"] and c["page_number"] == 2 for c in cites)
    assert "Q3 2026 | 3.85" in api["llm"].prompts[-1]  # the visually read value reached the model, from page 2


def test_dashboard_from_chart_cites_pages_and_flags_visual_values(api):
    _upload(api["a"], make_pdf(api["tmp"] / "rates.pdf", ["chart"]))
    res = api["a"].post("/api/dashboards", json={"question": "Build a dashboard of the cash rate by quarter"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["source"]["pages"] == [1] and body["source"]["from_visual"] is True
    assert any("read from chart images" in n for n in body["notes"])


def test_reanalysing_an_existing_document(api, monkeypatch):
    monkeypatch.setattr(pdf_visual, "get_vision_llm", lambda: None)  # uploaded before vision was available
    doc = _upload(api["a"], make_pdf(api["tmp"] / "old.pdf", ["chart"]))
    assert doc["visual_extraction"]["skipped_pages"] == [1]
    vision = FakeVision(readable_payload())
    monkeypatch.setattr(pdf_visual, "get_vision_llm", lambda: vision)
    res = api["a"].post(f"/api/documents/{doc['id']}/visual-extract")
    assert res.status_code == 200, res.text
    assert res.json()["readable_charts"] == 1 and vision.images == 1
    chunks = [c for c in sqlite.get_chunks_by_ids(sqlite.get_chunk_ids_for_document(doc["id"], doc["family_entity_id"]))]
    assert any("Q2 2026 | 4.1" in c["content"] and c["page_number"] == 1 for c in chunks)


def test_10_cross_tenant_document_never_reaches_vision_or_llm(api, monkeypatch):
    doc_b = _upload(api["b"], make_pdf(api["tmp"] / "beta_confidential.pdf", ["chart"]))
    vision = FakeVision(readable_payload())
    monkeypatch.setattr(pdf_visual, "get_vision_llm", lambda: vision)
    api["fetches"].clear()
    res = api["a"].post(f"/api/documents/{doc_b['id']}/visual-extract")
    assert res.status_code == 403 and res.json() == {"detail": "Access denied."}
    assert vision.images == 0 and api["fetches"] == []  # denied before the file was read or a model called
    q = api["a"].post("/api/query", json={"question": "What was the Cash Rate Target in Q3 2026 in Graph 3.1?"})
    assert q.status_code == 200
    assert all(c["document_id"] != doc_b["id"] for c in q.json()["citations"])
    assert all("beta_confidential" not in p for p in api["llm"].prompts)


def test_adviser_cannot_trigger_visual_processing(api):
    doc = _upload(api["a"], make_pdf(api["tmp"] / "a.pdf", ["chart"]))
    inv = api["a"].post("/api/auth/invites", json={"family_entity_id": doc["family_entity_id"], "role": "read_only_adviser"})
    adv = TestClient(app)
    r = adv.post("/api/auth/register", json={"email": f"adv-{uuid.uuid4().hex[:5]}@t.test", "password": "StrongPassword123!",
                                            "full_name": "Adv", "invite_token": inv.json()["invite_token"]})
    adv.headers.update({"Authorization": f"Bearer {r.json()['access_token']}"})
    before = api["vision"].images
    assert adv.post(f"/api/documents/{doc['id']}/visual-extract").status_code == 403
    assert api["vision"].images == before
