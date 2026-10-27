from app.services import rag_engine, voice
from app.services.lexical_index import LexicalIndex, extract_dates, tokenize


def test_extract_dates_handles_spoken_and_typed_formats():
    assert extract_dates("AAPL close on 2020-04-01") == ["2020-04-01"]
    assert extract_dates("closing price on 1st of April 2020") == ["2020-04-01"]
    assert extract_dates("what about April 2, 2020?") == ["2020-04-02"]
    # Australian day-first convention
    assert extract_dates("volume on 03/04/2020") == ["2020-04-03"]
    assert extract_dates("no dates here") == []


def test_tokenize_keeps_iso_dates_and_normalises_numbers():
    tokens = tokenize("What was the volume of 11,558 rows on 2020-04-01?")
    assert "2020-04-01" in tokens
    assert "11558" in tokens
    assert "the" not in tokens


def _index():
    idx = LexicalIndex()
    idx.load_chunks([
        {"chunk_id": "a", "document_id": "d1", "page_number": 1, "family_entity_id": "fam",
         "allowed_roles": ["family_member"], "text": "2020-04-01\t59.45\t58.11\t176218400"},
        {"chunk_id": "b", "document_id": "d1", "page_number": 2, "family_entity_id": "fam",
         "allowed_roles": ["family_member"], "text": "2021-06-01\t125.0\t124.3\t67000000"},
        {"chunk_id": "c", "document_id": "d2", "page_number": 1, "family_entity_id": "other",
         "allowed_roles": ["family_member"], "text": "2020-04-01 belongs to another family"},
    ])
    return idx


def test_lexical_search_finds_exact_date_and_respects_tenant():
    results = _index().search("close on 2020-04-01", "fam", ["family_member"])
    assert [r["chunk_id"] for r in results] == ["a"]


def test_lexical_search_respects_roles():
    assert _index().search("2020-04-01", "fam", ["read_only_adviser"]) == []


def test_fusion_boosts_exact_date_over_semantic_rank():
    semantic = [
        {"chunk_id": "summary", "score": 0.62, "text": "Archive overview and statistical summary of the dataset",
         "metadata": {"document_id": "d1", "page_number": 1}},
    ]
    lexical = [{"chunk_id": "row", "document_id": "d2", "page_number": 3,
                "text": "2020-04-01\t59.45\t59.99\t57.68\t58.11\t176218400", "lexical_score": 9.0}]
    fused = rag_engine._fuse(semantic, lexical, ["2020-04-01"], top_k=2)
    assert fused[0]["chunk_id"] == "row"


def test_focus_text_keeps_header_and_target_row():
    rows = "\n".join(f"2020-03-{d:02d}\t1\t2\t3" for d in range(1, 31))
    text = "Date\tOpen\tHigh\tClose\n" + rows + "\n2020-04-01\t59.45\t59.99\t58.11\n" + rows
    focused = rag_engine._focus_text(text, ["2020-04-01"], 400)
    assert focused.startswith("Date\tOpen")
    assert "2020-04-01\t59.45" in focused
    assert len(focused) <= 420


def test_parse_structured_answer_from_markdown():
    md = (
        "On 2020-04-01 AAPL closed at **$58.11** [2].\n\n"
        "### Key figures\n\n| Metric | Value | Period | Source |\n|---|---|---|---|\n"
        "| Close | $58.11 | 2020-04-01 | [2] |\n\n"
        "### Details\n- Opened at $59.45 [2].\n\n### Considerations\n- Prices are unadjusted [1]."
    )
    s = rag_engine.parse_structured_answer(md)
    assert s["summary"].startswith("On 2020-04-01 AAPL closed at $58.11")
    assert s["metrics"][0]["label"] == "Close" and s["metrics"][0]["value"] == "$58.11"
    assert s["key_findings"] == ["Opened at $59.45 [2]."]
    assert s["risk_factors"] == ["Prices are unadjusted [1]."]


def test_speech_cleaning_drops_tables_and_citations():
    cleaned = voice.clean_text_for_speech("Closed at **$58.11** [2][3].\n| Metric | Value |\n| Close | $58.11 |")
    assert cleaned == "Closed at $58.11."


def test_silence_hallucinations_are_filtered():
    assert voice.is_probable_hallucination("Thank you.")
    assert voice.is_probable_hallucination("  ")
    assert not voice.is_probable_hallucination("What was the close on April 1?")
