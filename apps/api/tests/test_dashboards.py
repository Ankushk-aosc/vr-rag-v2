import asyncio

import pytest

from app.services import dashboards, datasets


def _chunk(doc, rows, family="fam", roles=("family_member",), header="Date | Open | High | Low | Close | Volume | Daily_Return_%"):
    lines = [f"### Sheet (rows)", header, " | ".join(["---"] * len(header.split("|")))]
    lines += [" | ".join(str(c) for c in r) for r in rows]
    return {"chunk_id": f"{doc}-{rows[0][0]}", "document_id": doc, "family_entity_id": family,
            "allowed_roles": list(roles), "original_name": f"{doc}.csv", "text": "\n".join(lines)}


ROWS = [
    ("2020-03-31", 60.0, 61.0, 59.0, 61.33, 197002000, 1.0),
    ("2020-04-01", 59.45, 59.99, 57.68, 58.11, 176218400, -2.27),
    ("2020-04-02", 57.97, 59.13, 57.14, 59.08, 165934000, 1.91),
    ("2020-04-03", 58.56, 59.26, 57.64, 58.23, -129880000, -0.57),  # corrupt (negative) volume
    ("2020-04-06", 60.12, 61.50, 60.0, 60.75, 201310000, 4.33),
]


@pytest.fixture(autouse=True)
def no_doc_names(monkeypatch):
    monkeypatch.setattr(datasets.pinecone_service, "get_document_names", lambda family_entity_id, force=False: {})


def build(chunks):
    return datasets.build_datasets(chunks)


def test_tables_split_across_chunks_are_stitched_and_typed():
    ds = build([_chunk("doc1", ROWS[:2]), _chunk("doc1", ROWS[2:])])
    assert len(ds) == 1
    d = ds[0]
    assert d.x == [r[0] for r in ROWS] and d.x_is_date
    assert d.column("close").unit == "$" and d.by_kind("volume").key == "Volume"
    assert d.column("Daily_Return_%").kind == "change" and d.column("Daily_Return_%").unit == "%"
    assert d.values["Close"][1] == 58.11


def test_negative_volume_is_dropped_and_reported():
    d = build([_chunk("doc1", ROWS)])[0]
    assert d.values["Volume"][3] is None
    assert d.invalid["Volume"] == ["2020-04-03"]


def test_same_ledger_in_two_formats_is_deduplicated():
    ds = build([_chunk("csv", ROWS), _chunk("docx", ROWS, header="Date | Open ($) | High ($) | Low ($) | Close ($) | Volume")])
    assert len(ds) == 1 and len(ds[0].columns) == 6  # the richer copy wins


def test_tenant_and_role_isolation(monkeypatch):
    monkeypatch.setattr(datasets.lexical_index, "snapshot", lambda: [_chunk("doc1", ROWS, family="fam", roles=("family_admin",))])
    monkeypatch.setattr(datasets.lexical_index, "version", 999)
    datasets._cache["version"] = -1
    assert len(datasets.get_datasets("fam", ["family_admin"])) == 1
    assert datasets.get_datasets("other_family", ["family_admin"]) == []
    assert datasets.get_datasets("fam", ["read_only_adviser"]) == []


def test_bucketing_and_partial_periods():
    assert dashboards.bucket_key("2020-04-01", "month") == "2020-04"
    assert dashboards.bucket_key("2020-04-01", "quarter") == "2020 Q2"
    assert dashboards.bucket_key("2020-04-01", "week") == "2020-03-30"  # Monday of that week
    assert dashboards.partial_buckets("1980-12-12", "2026-10-22", "year") == (True, True)
    assert dashboards.partial_buckets("2008-01-02", "2008-12-31", "year") == (False, False)


def test_focus_on_non_trading_day_uses_previous_day_and_says_so():
    d = build([_chunk("doc1", ROWS)])[0]
    plan = dashboards.default_plan("closing price on 4 April 2020", "", d)
    out = dashboards.resolve(plan, "closing price on 4 April 2020", [d], "default")
    close = next(k for k in out["kpis"] if k["label"] == "Close")
    assert close["display"] == "$58.23"
    assert "previous trading day" in close["sub"]
    assert any("No trading data on 2020-04-04" in n for n in out["notes"])
    assert any("negative volume" in n for n in out["notes"])
    assert out["charts"][0]["type"] == "candlestick" and out["charts"][0]["highlight"] == "2020-04-03"


def test_values_come_from_rows_not_from_the_plan():
    d = build([_chunk("doc1", ROWS)])[0]
    plan = {"dataset_id": d.id, "focus": "2020-04-01", "granularity": "day",
            "kpis": [{"label": "Close on 1 Apr 2020", "column": "Close", "stat": "at_focus"}],
            "charts": [{"type": "line", "title": "Close", "columns": ["Close", "NotAColumn"]}]}
    out = dashboards.resolve(plan, "q", [d], "ai")
    assert out["kpis"][0]["display"] == "$58.11" and out["kpis"][0]["label"] == "Close"
    assert out["charts"][0]["series"][0]["values"][:2] == [61.33, 58.11]
    assert len(out["charts"][0]["series"]) == 1  # unknown column dropped


def test_mixed_units_never_share_a_chart():
    d = build([_chunk("doc1", ROWS)])[0]
    plan = {"dataset_id": d.id, "charts": [{"type": "line", "title": "x", "columns": ["Close", "Volume"]}]}
    out = dashboards.resolve(plan, "q", [d], "ai")
    assert [s["column"] for s in out["charts"][0]["series"]] == ["Close"]


def test_dashboard_intent_detection():
    assert dashboards.is_dashboard_request("create a graph")
    assert dashboards.is_dashboard_request("Can you show me a chart of AAPL volume in 2008?")
    assert not dashboards.is_dashboard_request("What was the closing price on 1 April 2020?")
    assert not dashboards.has_own_topic("please create a dashboard for this")
    assert dashboards.has_own_topic("chart AAPL trading volume in 2008")


def test_build_dashboard_falls_back_without_llm(monkeypatch):
    d = build([_chunk("doc1", ROWS)])[0]
    monkeypatch.setattr(dashboards, "get_datasets", lambda fam, roles: [d])

    async def no_plan(*a, **k):
        return None

    monkeypatch.setattr(dashboards, "llm_plan", no_plan)
    out = asyncio.run(dashboards.build_dashboard("AAPL on 2020-04-01", "", "fam", ["family_member"]))
    assert out["plan_source"] == "default"
    assert out["kpis"][0]["display"] == "$58.11"


def test_summary_rows_are_not_aggregated_twice():
    """A sheet's own 'Total' row must not be summed with the rows it already totals."""
    from app.services.datasets import build_datasets

    text = (
        "| Asset_Class | Value_AUD |\n| --- | --- |\n"
        "| Australian Equities | 100 |\n| International Equities | 50 |\n| Fixed Income | 25 |\n"
        "| Cash | 25 |\n| Total Portfolio | 200 |\n"
    )
    chunks = [{"document_id": "d1", "text": text, "is_table": True, "allowed_roles": ["family_member"], "original_name": "p.xlsx"}]
    datasets = build_datasets(chunks)
    assert datasets, "expected one dataset"
    ds = datasets[0]
    assert "Total Portfolio" not in ds.x
    value_col = next(c for c in ds.columns if c.key == "Value_AUD")
    assert sum(v for v in ds.values[value_col.key] if v is not None) == 200
