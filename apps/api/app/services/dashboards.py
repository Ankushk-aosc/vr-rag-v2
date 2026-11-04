"""
Question → dashboard.

1. Pick the data: tables extracted from the user's own documents (see datasets.py).
2. Plan: the LLM returns a small JSON plan (dataset, columns, window, focus date, chart types).
   It never supplies numbers. If it is unavailable or returns nonsense, a deterministic plan
   derived from the question is used instead.
3. Resolve: the plan is validated against the real columns and every value is computed from the
   source rows (bucketing by day/week/month/quarter/year when the window is long).

Chart forms follow the data's job: KPI tiles for single values, a line for a trend, candlesticks
for daily price ranges around a date, bars for volume, diverging bars for signed % changes.
Different units never share a chart (no dual axes).
"""
import asyncio
import bisect
import json
import logging
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from app.config import settings
from app.services import rag_engine
from app.services.datasets import Column, Dataset, get_datasets
# Formatting, bucketing and the default plan live in sibling modules (Audit I-22); re-exported here
from app.services.dashboard_format import (  # noqa: F401
    MAX_POINTS, aggregate, auto_granularity, bucket_key, default_agg, fmt_value, nice_date, partial_buckets,
)
from app.services.dashboard_plan import _clip_iso, default_plan  # noqa: F401

logger = logging.getLogger(__name__)

CHART_TYPES = ("line", "area", "bar", "candlestick", "diverging_bar")
GRANULARITIES = ("day", "week", "month", "quarter", "year")
MAX_CHARTS = 4
MAX_KPIS = 4

PLAN_SYSTEM = """You design dynamic financial dashboards. Reply with ONE JSON object only.
You choose WHAT to plot based directly on the user's question; the server computes every number from the dataset, so never output numbers.
Rules:
- Form strictly follows the user's intent:
  * When comparing metrics (e.g. Open vs Close, High vs Low): create a multi-column "line" or "area" chart with the requested columns!
  * When asking about returns, gains, losses, profits, or % changes: create a "diverging_bar" chart for returns, plus a "line" or "area" chart!
  * When asking about trading activity, liquidity, volume, shares: create a "bar" chart for volume!
  * When asking about price range, volatility, spread, OHLC, or a specific date/event: create a "candlestick" or range "area" chart!
  * When asking general questions, summaries, or greetings: synthesize an executive overview with 3-4 diverse complementary charts: 1) Price Trend ("area"), 2) Trading Volume ("bar"), 3) Daily Returns ("diverging_bar"), 4) Price Range / Volatility ("line").
- Each chart shows ONE unit ($ or % or count). Never mix price ($) and volume (shares) in one chart.
- At most 4 charts and 4 kpis.
- Window: a question about one day -> about 3 months around it with focus = that day;
  about a year or range -> that period; general questions -> full history or recent relevant period.
Schema:
{"title": str (<=60 chars), "subtitle": str (<=110 chars), "dataset_id": str,
 "x_start": "YYYY-MM-DD"|null, "x_end": "YYYY-MM-DD"|null, "focus": "YYYY-MM-DD"|null,
 "granularity": "auto"|"day"|"week"|"month"|"quarter"|"year",
 "kpis": [{"label": str, "column": str, "stat": "at_focus"|"last"|"first"|"max"|"min"|"mean"|"sum"|"change_pct"}],
 "charts": [{"type": "line"|"area"|"bar"|"candlestick"|"diverging_bar", "title": str,
             "columns": [str], "agg": "auto"|"last"|"first"|"mean"|"sum"|"max"|"min"}]}"""

DASHBOARD_INTENT = re.compile(
    r"\b(create|make|build|show|generate|draw|plot|give|render|visuali[sz]e|display|open)\b.{0,40}"
    r"\b(graphs?|charts?|dashboards?|visuals?|visuali[sz]ations?|plots?)\b",
    re.IGNORECASE,
)
_GENERIC_WORDS = re.compile(
    r"\b(please|can|could|you|me|a|an|the|for|of|this|that|it|create|make|build|show|generate|draw|plot|"
    r"give|render|visuali[sz]e|display|open|graphs?|charts?|dashboards?|visuals?|visuali[sz]ations?|plots?|"
    r"now|also|and|some|3d|vr|in)\b",
    re.IGNORECASE,
)


def is_dashboard_request(text: str) -> bool:
    return bool(DASHBOARD_INTENT.search(text))


def has_own_topic(text: str) -> bool:
    """'create a graph' -> False (refers to the previous answer); 'chart AAPL volume in 2008' -> True."""
    rest = _GENERIC_WORDS.sub(" ", text)
    return len(re.findall(r"[a-z0-9]{3,}", rest.lower())) >= 2


async def llm_plan(question: str, answer: str, catalog: List[Dict], fallback: Dict) -> Optional[Dict]:
    client = rag_engine.get_groq_client()
    if not client:
        return None
    user = (
        f"Catalog: {json.dumps(catalog)}\n\nQuestion: {question}\n\n"
        f"Answer already given to the user: {answer[:700]}\n\n"
        f"A reasonable default plan (improve it to match the question's exact nuance): {json.dumps(fallback)}"
    )
    for reasoning_effort in ("none", None):
        try:
            kwargs: Dict[str, Any] = {
                "model": settings.GROQ_MODEL,
                "messages": [{"role": "system", "content": PLAN_SYSTEM}, {"role": "user", "content": user}],
                "temperature": 0.1,
                "max_completion_tokens": 800,
                "response_format": {"type": "json_object"},
            }
            if reasoning_effort is not None:
                kwargs["reasoning_effort"] = reasoning_effort
            resp = await asyncio.wait_for(client.chat.completions.create(**kwargs), timeout=15)
            content = resp.choices[0].message.content or "{}"
            parsed = json.loads(content)
            if parsed and isinstance(parsed, dict) and parsed.get("charts"):
                return parsed
        except Exception as e:
            if "reasoning_effort" in str(e).lower() and reasoning_effort is not None:
                continue
            logger.warning("Dashboard plan from LLM failed, using default plan: %s", str(e)[:200])
            break
    return None


# ---------------------------------------------------------------------------- resolution

def _window(ds: Dataset, start: Optional[str], end: Optional[str]) -> Tuple[int, int]:
    if not ds.x_is_date:
        return 0, min(len(ds.x), 60)
    lo = bisect.bisect_left(ds.x, start) if start else 0
    hi = bisect.bisect_right(ds.x, end) if end else len(ds.x)
    if hi - lo < 2:
        return 0, len(ds.x)
    return lo, hi


def _focus_index(ds: Dataset, focus: Optional[str]) -> Tuple[Optional[int], Optional[str]]:
    """Exact row for the focus date, or the last trading day before it."""
    if not focus or not ds.x_is_date:
        return None, None
    i = bisect.bisect_right(ds.x, focus) - 1
    if i < 0:
        return 0, f"No data on or before {focus}; showing the first available day {ds.x[0]}."
    if ds.x[i] != focus:
        return i, f"No trading data on {focus}; showing the previous trading day {ds.x[i]}."
    return i, None


_DATE_IN_LABEL = re.compile(
    r"\s+(on|for|at)\s+(\d{1,2}\s+\w{3,9}\s+\d{4}|\d{4}-\d{2}-\d{2})\s*$", re.IGNORECASE)


def _kpi(ds: Dataset, spec: Dict, lo: int, hi: int, focus_i: Optional[int], focus: Optional[str],
         gran: str) -> Optional[Dict]:
    col = ds.column(spec.get("column"))
    if not col:
        return None
    vals = ds.values[col.key]
    stat = spec.get("stat", "last")
    label = str(spec.get("label") or col.label)[:48]
    window = [(i, vals[i]) for i in range(lo, hi) if vals[i] is not None]
    if not window:
        return None
    if stat == "at_focus" and focus_i is not None and vals[focus_i] is not None:
        # the date lives in the sub-line, so it is always the date the value actually comes from
        label = _DATE_IN_LABEL.sub("", label)
        v, sub = vals[focus_i], nice_date(ds.x[focus_i])
        if focus and ds.x[focus_i] != focus:
            sub += f" (previous trading day; no data on {nice_date(focus)})"
    elif stat == "first":
        v, sub = window[0][1], nice_date(ds.x[window[0][0]])
    elif stat in ("max", "min"):
        pick = max if stat == "max" else min
        if gran != "day" and ds.x_is_date:
            # on an aggregated view "highest" means the highest bucket (e.g. the highest-volume year);
            # partial first/last periods are not comparable with full ones, so they are left out
            labels, bucketed = _series(ds, col, lo, hi, gran, default_agg(col))
            pairs = [(lbl, b) for lbl, b in zip(labels, bucketed) if b is not None]
            head_partial, tail_partial = partial_buckets(ds.x[lo], ds.x[hi - 1], gran)
            full = pairs[1 if head_partial else 0: len(pairs) - (1 if tail_partial else 0)] or pairs
            lbl, v = pick(full, key=lambda p: p[1])
            sub = f"in {lbl}" + (" (total)" if default_agg(col) == "sum" else "")
            if len(full) < len(pairs):
                sub += f", full {gran}s only"
        else:
            i, v = pick(window, key=lambda p: p[1])
            sub = f"on {nice_date(ds.x[i])}"
    elif stat == "mean":
        v = sum(p[1] for p in window) / len(window)
        sub = f"daily average over {len(window):,} days" if ds.x_is_date else f"average of {len(window):,} rows"
    elif stat == "sum":
        v, sub = sum(p[1] for p in window), f"total of {len(window):,} rows"
    elif stat == "change_pct":
        first, last = window[0][1], window[-1][1]
        if not first:
            return None
        pct = (last - first) / abs(first) * 100
        return {"label": label, "value": pct, "display": f"{pct:+.1f}%",
                "sub": f"{fmt_value(first, col)} → {fmt_value(last, col)}", "unit": "%", "tone": "up" if pct >= 0 else "down"}
    else:
        v, sub = window[-1][1], nice_date(ds.x[window[-1][0]])
    tone = ("up" if v >= 0 else "down") if col.unit == "%" else None
    return {"label": label, "value": v, "display": fmt_value(v, col), "sub": sub, "unit": col.unit, "tone": tone}


def _series(ds: Dataset, col: Column, lo: int, hi: int, gran: str, how: str) -> Tuple[List[str], List[Optional[float]]]:
    if gran == "day" or not ds.x_is_date:
        return ds.x[lo:hi], ds.values[col.key][lo:hi]
    labels: List[str] = []
    out: List[Optional[float]] = []
    bucket: List[float] = []
    cur = None
    for i in range(lo, hi):
        k = bucket_key(ds.x[i], gran)
        if k != cur and cur is not None:
            labels.append(cur)
            out.append(aggregate(bucket, how))
            bucket = []
        cur = k
        bucket.append(ds.values[col.key][i])
    if cur is not None:
        labels.append(cur)
        out.append(aggregate(bucket, how))
    return labels, out


def resolve(plan: Dict, question: str, datasets: List[Dataset], plan_source: str) -> Dict[str, Any]:
    ds = next((d for d in datasets if d.id == plan.get("dataset_id")), datasets[0])
    notes: List[str] = []
    focus = _clip_iso(plan.get("focus"))
    start, end = _clip_iso(plan.get("x_start")), _clip_iso(plan.get("x_end"))
    focus_i, note = _focus_index(ds, focus)
    if note:
        notes.append(note)
    lo, hi = _window(ds, start, end)
    if focus_i is not None and not (lo <= focus_i < hi):
        lo, hi = max(0, focus_i - 30), min(len(ds.x), focus_i + 31)
    gran = plan.get("granularity") if plan.get("granularity") in GRANULARITIES else "auto"
    if gran == "auto" or (gran == "day" and hi - lo > MAX_POINTS * 1.6):
        gran = auto_granularity(hi - lo)
    if not ds.x_is_date:
        gran = "day"

    charts: List[Dict] = []
    for i, spec in enumerate((plan.get("charts") or [])[:MAX_CHARTS]):
        ctype = spec.get("type") if spec.get("type") in CHART_TYPES else "line"
        if ctype == "candlestick":
            cols = {k: ds.by_kind(k) for k in ("open", "high", "low", "close")}
            if not all(cols.values()):
                ctype = "line"
            else:
                x, o = _series(ds, cols["open"], lo, hi, gran, "first")
                _, h = _series(ds, cols["high"], lo, hi, gran, "max")
                _, l = _series(ds, cols["low"], lo, hi, gran, "min")
                _, c = _series(ds, cols["close"], lo, hi, gran, "last")
                charts.append({
                    "id": f"c{i}", "type": "candlestick", "title": str(spec.get("title") or "Price range")[:60],
                    "x": x, "unit": "$", "ohlc": {"open": o, "high": h, "low": l, "close": c},
                    "series": [{"name": cols["close"].label, "column": cols["close"].key, "unit": "$", "values": c}],
                })
                continue
        wanted = [ds.column(cname) for cname in (spec.get("columns") or [])]
        cols = [c for c in wanted if c] or [ds.by_kind("close") or ds.columns[0]]
        unit = cols[0].unit
        cols = [c for c in cols if c.unit == unit][:3]  # one unit per chart
        if ctype == "diverging_bar" and unit != "%":
            ctype = "bar"
        series = []
        x: List[str] = []
        for c in cols:
            how = spec.get("agg") if spec.get("agg") in ("last", "first", "mean", "sum", "max", "min") else default_agg(c)
            x, vals = _series(ds, c, lo, hi, gran, how)
            series.append({"name": c.label, "column": c.key, "unit": c.unit, "values": vals, "agg": how})
        if not series:
            continue
        charts.append({"id": f"c{i}", "type": ctype, "title": str(spec.get("title") or cols[0].label)[:60],
                       "x": x, "unit": unit, "series": series})

    if not charts:
        fallback = default_plan(question, "", ds)
        return resolve({**fallback, "kpis": plan.get("kpis") or fallback["kpis"]}, question, datasets, "default")

    focus_label = bucket_key(ds.x[focus_i], gran) if focus_i is not None else None
    for ch in charts:
        ch["granularity"] = gran
        ch["highlight"] = focus_label if focus_label in ch["x"] else None

    kpi_specs = (plan.get("kpis") or [])[:MAX_KPIS]
    kpis = [k for k in (_kpi(ds, s, lo, hi, focus_i, focus, gran) for s in kpi_specs) if k]
    used = {s["column"] for ch in charts for s in ch["series"]}
    used |= {c.key for c in (ds.column(s.get("column")) for s in kpi_specs) if c}
    for key, bad_dates in ds.invalid.items():
        in_window = [d for d in bad_dates if ds.x[lo] <= d <= ds.x[hi - 1]]
        if key in used and in_window:
            notes.append(
                f"{len(in_window)} row(s) in the source have an impossible negative {key.lower()} "
                f"(e.g. {in_window[0]}; likely a 32-bit overflow in the original export) and are left out."
            )
    if gran != "day":
        notes.append(f"Values are aggregated per {gran} (prices: last close, volumes: totals, % changes: averages).")
        head_partial, tail_partial = partial_buckets(ds.x[lo], ds.x[hi - 1], gran)
        partial = [b for b, flag in ((bucket_key(ds.x[lo], gran), head_partial),
                                     (bucket_key(ds.x[hi - 1], gran), tail_partial)) if flag]
        if partial:
            notes.append(f"{' and '.join(partial)} {'is a partial ' + gran if len(partial) == 1 else 'are partial ' + gran + 's'} "
                         f"(data runs {ds.x[lo]} to {ds.x[hi - 1]}).")
    return {
        "id": uuid.uuid4().hex[:12],
        "title": str(plan.get("title") or "Dashboard")[:70],
        "subtitle": str(plan.get("subtitle") or "")[:120],
        "question": question,
        "created_at": int(time.time() * 1000),
        "plan_source": plan_source,
        "source": {
            "document_name": ds.document_name,
            "dataset_id": ds.id,
            "rows_used": hi - lo,
            "x_start": ds.x[lo],
            "x_end": ds.x[hi - 1],
            "columns": [c.label for c in ds.columns],
            "document_id": ds.document_id,
            "pages": ds.pages,
            "from_visual": ds.from_visual,
        },
        "kpis": kpis,
        "charts": charts,
        "notes": notes + ([f"Source page{'s' if len(ds.pages) > 1 else ''}: {', '.join(map(str, ds.pages))}."] if ds.pages else [])
        + (["Values were read from chart images by a vision model and are approximate; check the cited pages."]
           if ds.from_visual else []),
    }


# ---------------------------------------------------------------------------- facts fallback

def facts_dashboard(question: str, answer: str) -> Optional[Dict[str, Any]]:
    """No table data: turn the figures already stated in the (grounded) answer into stat tiles."""
    kpis = []
    for line in answer.splitlines():
        cells = [c.strip(" *") for c in line.strip().strip("|").split("|")] if line.strip().startswith("|") else []
        if len(cells) >= 2 and re.search(r"\d", cells[1]) and cells[0].lower() not in ("metric", "item"):
            kpis.append({"label": cells[0][:48], "value": None, "display": cells[1][:24],
                         "sub": cells[2][:40] if len(cells) > 2 else "", "unit": "", "tone": None})
    if not kpis:
        return None
    return {
        "id": uuid.uuid4().hex[:12], "title": "Key figures", "subtitle": question[:120], "question": question,
        "created_at": int(time.time() * 1000), "plan_source": "answer",
        "source": {"document_name": "figures quoted in the answer", "dataset_id": None, "rows_used": len(kpis),
                   "x_start": None, "x_end": None, "columns": []},
        "kpis": kpis[:8], "charts": [],
        "notes": ["No tabular data was found for this question, so only the figures from the answer are shown."],
    }


def select_best_dataset(question: str, answer: str, datasets: List[Dataset]) -> Dataset:
    if not datasets:
        raise LookupError("No datasets available")
    if len(datasets) == 1:
        return datasets[0]
    text = (question + " " + answer).lower()
    best_ds = datasets[0]
    best_score = -1.0
    for ds in datasets:
        score = 0.0
        doc_words = set(re.findall(r"[a-z0-9]+", ds.document_name.lower()))
        for w in doc_words:
            if len(w) >= 3 and w in text:
                score += 3.0
        for c in ds.columns:
            c_words = set(re.findall(r"[a-z0-9]+", c.label.lower()))
            for cw in c_words:
                if len(cw) >= 3 and cw in text:
                    score += 1.5
        years = re.findall(r"\b(19[89]\d|20[0-4]\d)\b", text)
        if years and ds.x_is_date:
            score += 2.0
        if score > best_score:
            best_score = score
            best_ds = ds
    return best_ds


async def build_dashboard(question: str, answer: str, family_entity_id: str, user_roles: List[str],
                          allowed_document_ids=None) -> Dict[str, Any]:
    if allowed_document_ids is None:
        datasets = await asyncio.to_thread(get_datasets, family_entity_id, user_roles)
    else:
        datasets = await asyncio.to_thread(get_datasets, family_entity_id, user_roles, allowed_document_ids)
    if not datasets:
        facts = facts_dashboard(question, answer)
        if facts:
            return facts
        raise LookupError("No tables with numeric data were found in your indexed documents to chart.")
    primary_ds = select_best_dataset(question, answer, datasets)
    ordered_datasets = [primary_ds] + [d for d in datasets if d.id != primary_ds.id]
    fallback = default_plan(question, answer, primary_ds)
    plan = await llm_plan(question, answer, [d.catalog_entry() for d in ordered_datasets[:4]], fallback)
    source = "ai"
    if not plan or not isinstance(plan, dict) or not plan.get("charts"):
        plan, source = fallback, "default"
    try:
        return resolve(plan, question, ordered_datasets, source)
    except Exception as e:
        logger.warning("AI dashboard plan could not be resolved (%s); using default plan", e)
        return resolve(fallback, question, ordered_datasets, "default")
