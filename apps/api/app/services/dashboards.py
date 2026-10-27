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
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

from app.config import settings
from app.services import rag_engine
from app.services.datasets import Column, Dataset, get_datasets
from app.services.lexical_index import extract_dates

logger = logging.getLogger(__name__)

CHART_TYPES = ("line", "area", "bar", "candlestick", "diverging_bar")
GRANULARITIES = ("day", "week", "month", "quarter", "year")
MAX_POINTS = 260
MAX_CHARTS = 4
MAX_KPIS = 4

PLAN_SYSTEM = """You design financial dashboards. Reply with ONE JSON object only.
You choose WHAT to plot; the server computes every number from the dataset, so never output data values.
Rules:
- Use only a dataset_id and column keys that appear in the catalog.
- Form follows the job: kpis for single headline values; "line" for a trend over time;
  "candlestick" for daily open/high/low/close around a specific date; "bar" for volumes or totals;
  "diverging_bar" for signed % changes (gains vs losses).
- Each chart shows ONE unit. Never mix price and volume in one chart. At most 4 charts and 4 kpis.
- Window: a question about one day -> about 3 months around it with focus = that day;
  about a year or range -> that period; general questions -> the full history.
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


# ---------------------------------------------------------------------------- formatting

def compact(v: float) -> str:
    a = abs(v)
    for limit, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= limit:
            return f"{v / limit:.1f}{suffix}"
    return f"{v:,.0f}" if a >= 100 else f"{v:,.2f}"


def fmt_value(v: Optional[float], col: Column) -> str:
    if v is None:
        return "—"
    if col.unit == "$":
        return f"${compact(v)}" if abs(v) >= 1e6 else f"${v:,.2f}"
    if col.unit == "%":
        return f"{v:+.3f}%" if 0 < abs(v) < 0.1 else f"{v:+.2f}%"
    if col.kind == "volume":
        return compact(v)
    return compact(v)


def nice_date(iso: str) -> str:
    """2020-04-01 -> 1 Apr 2020 (portable: no platform-specific strftime flags)."""
    try:
        d = date.fromisoformat(iso)
        return f"{d.day} {d.strftime('%b')} {d.year}"
    except ValueError:
        return iso


# ---------------------------------------------------------------------------- bucketing

def bucket_key(iso: str, granularity: str) -> str:
    if granularity == "day":
        return iso
    if granularity == "month":
        return iso[:7]
    if granularity == "year":
        return iso[:4]
    if granularity == "quarter":
        return f"{iso[:4]} Q{(int(iso[5:7]) - 1) // 3 + 1}"
    y, m, d = (int(p) for p in iso.split("-"))
    monday = date(y, m, d) - timedelta(days=date(y, m, d).weekday())
    return monday.isoformat()


def default_agg(col: Column) -> str:
    return {"open": "first", "high": "max", "low": "min", "close": "last", "price": "last",
            "volume": "sum", "change": "mean"}.get(col.kind, "mean")


def aggregate(vals: List[float], how: str) -> Optional[float]:
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    if how == "first":
        return vals[0]
    if how == "last":
        return vals[-1]
    if how == "max":
        return max(vals)
    if how == "min":
        return min(vals)
    if how == "sum":
        return sum(vals)
    return sum(vals) / len(vals)


def partial_buckets(first_iso: str, last_iso: str, granularity: str) -> Tuple[bool, bool]:
    """Does the window start/end part-way through its first/last bucket (e.g. data starting 12 Dec)?"""
    if granularity == "year":
        return first_iso[5:] > "01-15", last_iso[5:] < "12-15"
    if granularity == "quarter":
        q_start = {1: "01", 2: "04", 3: "07", 4: "10"}
        q_end = {1: "03", 2: "06", 3: "09", 4: "12"}
        fq = (int(first_iso[5:7]) - 1) // 3 + 1
        lq = (int(last_iso[5:7]) - 1) // 3 + 1
        return first_iso[5:] > f"{q_start[fq]}-10", last_iso[5:] < f"{q_end[lq]}-20"
    if granularity == "month":
        return first_iso[8:] > "07", last_iso[8:] < "22"
    return False, False


def auto_granularity(n: int) -> str:
    if n <= MAX_POINTS:
        return "day"
    if n <= MAX_POINTS * 5:
        return "week"
    if n <= MAX_POINTS * 21:
        return "month"
    if n <= MAX_POINTS * 63:
        return "quarter"
    return "year"


# ---------------------------------------------------------------------------- planning

def _clip_iso(s: Optional[str]) -> Optional[str]:
    return s if isinstance(s, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else None


def default_plan(question: str, answer: str, ds: Dataset) -> Dict[str, Any]:
    """Deterministic plan from the question alone (used when the LLM plan is unavailable)."""
    close = ds.by_kind("close") or ds.by_kind("price") or ds.columns[0]
    volume = ds.by_kind("volume")
    change = ds.by_kind("change")
    has_ohlc = all(ds.by_kind(k) for k in ("open", "high", "low", "close"))
    dates = extract_dates(question) or extract_dates(answer)
    years = re.findall(r"\b(19[89]\d|20[0-4]\d)\b", question)
    q = question.lower()
    per_year = bool(re.search(r"\b(which|what|each|every|per|by)\s+year|\byearly\b|\bannual|\bper year\b", q))
    superlative = bool(re.search(
        r"\b(highest|lowest|most|least|max(imum)?|min(imum)?|peak|best|worst|biggest|largest|smallest)\b", q))
    about_volume = "volume" in q or "traded" in q or "shares" in q
    about_change = bool(re.search(r"\breturns?\b|\bvolatil|\bgain|\bloss|\bchange", q))
    plan: Dict[str, Any] = {"dataset_id": ds.id, "granularity": "auto", "kpis": [], "charts": []}

    if ds.x_is_date and not dates and not years and (per_year or superlative):
        # "which year had the highest volume?" -> yearly buckets of the asked measure
        primary = (volume if about_volume else change if about_change else close) or close
        plan.update(title=f"{primary.label} by year", subtitle=f"{ds.x[0][:4]}–{ds.x[-1][:4]}, yearly",
                    x_start=None, x_end=None, focus=None, granularity="year")
        plan["kpis"] = [{"label": f"Highest {primary.label.lower()}", "column": primary.key, "stat": "max"},
                        {"label": f"Lowest {primary.label.lower()}", "column": primary.key, "stat": "min"}]
        plan["charts"].append({"type": "diverging_bar" if primary.unit == "%" else "bar",
                               "title": f"{primary.label} per year", "columns": [primary.key]})
        if primary is not close:
            plan["charts"].append({"type": "line", "title": f"{close.label} price", "columns": [close.key]})
        return plan

    if ds.x_is_date and dates:
        focus = dates[0]
        d = date.fromisoformat(focus)
        plan.update(
            title=f"{ds.document_name.split('_')[0]} around {nice_date(focus)}",
            subtitle=f"Daily trading data from {(d - timedelta(days=45)).isoformat()} to {(d + timedelta(days=45)).isoformat()}",
            x_start=(d - timedelta(days=45)).isoformat(), x_end=(d + timedelta(days=45)).isoformat(),
            focus=focus, granularity="day",
        )
        plan["kpis"] = [{"label": c.label, "column": c.key, "stat": "at_focus"} for c in (close, volume, change) if c]
        plan["charts"].append({"type": "candlestick" if has_ohlc else "line", "title": "Daily price range" if has_ohlc else f"{close.label}", "columns": [close.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading volume", "columns": [volume.key]})
        if change:
            plan["charts"].append({"type": "diverging_bar", "title": f"{change.label} (%)", "columns": [change.key]})
    elif ds.x_is_date and years:
        y0, y1 = min(years), max(years)
        plan.update(title=f"{ds.document_name.split('_')[0]} in {y0}" + (f"–{y1}" if y1 != y0 else ""),
                    subtitle="Weekly view", x_start=f"{y0}-01-01", x_end=f"{y1}-12-31", focus=None, granularity="auto")
        plan["kpis"] = [{"label": f"{close.label} change", "column": close.key, "stat": "change_pct"},
                        {"label": f"Highest {close.label.lower()}", "column": close.key, "stat": "max"}]
        if volume:
            plan["kpis"].append({"label": "Total volume", "column": volume.key, "stat": "sum"})
        plan["charts"].append({"type": "line", "title": f"{close.label} price", "columns": [close.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading volume", "columns": [volume.key]})
    else:
        plan.update(title=f"{ds.document_name.split('_')[0]} full history",
                    subtitle=f"{ds.x[0]} to {ds.x[-1]}" if ds.x_is_date else ds.document_name,
                    x_start=None, x_end=None, focus=None, granularity="auto")
        plan["kpis"] = [{"label": f"Latest {close.label.lower()}", "column": close.key, "stat": "last"},
                        {"label": f"All-time high {close.label.lower()}", "column": close.key, "stat": "max"}]
        if volume:
            plan["kpis"].append({"label": "Average volume per bucket", "column": volume.key, "stat": "mean"})
        plan["charts"].append({"type": "line", "title": f"{close.label} price", "columns": [close.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading volume", "columns": [volume.key]})
    return plan


async def llm_plan(question: str, answer: str, catalog: List[Dict], fallback: Dict) -> Optional[Dict]:
    client = rag_engine.get_groq_client()
    if not client:
        return None
    user = (
        f"Catalog: {json.dumps(catalog)}\n\nQuestion: {question}\n\n"
        f"Answer already given to the user: {answer[:700]}\n\n"
        f"A reasonable default plan (improve it if the question asks for something else): {json.dumps(fallback)}"
    )
    try:
        resp = await asyncio.wait_for(client.chat.completions.create(
            model=settings.GROQ_MODEL,
            messages=[{"role": "system", "content": PLAN_SYSTEM}, {"role": "user", "content": user}],
            temperature=0.1,
            max_completion_tokens=800,
            reasoning_effort="none",
            response_format={"type": "json_object"},
        ), timeout=15)
        return json.loads(resp.choices[0].message.content or "{}")
    except Exception as e:
        logger.warning("Dashboard plan from LLM failed, using default plan: %s", str(e)[:200])
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
        },
        "kpis": kpis,
        "charts": charts,
        "notes": notes,
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


async def build_dashboard(question: str, answer: str, family_entity_id: str, user_roles: List[str]) -> Dict[str, Any]:
    datasets = await asyncio.to_thread(get_datasets, family_entity_id, user_roles)
    if not datasets:
        facts = facts_dashboard(question, answer)
        if facts:
            return facts
        raise LookupError("No tables with numeric data were found in your indexed documents to chart.")
    fallback = default_plan(question, answer, datasets[0])
    plan = await llm_plan(question, answer, [d.catalog_entry() for d in datasets[:4]], fallback)
    source = "ai"
    if not plan or not isinstance(plan, dict) or not plan.get("charts"):
        plan, source = fallback, "default"
    try:
        return resolve(plan, question, datasets, source)
    except Exception as e:
        logger.warning("AI dashboard plan could not be resolved (%s); using default plan", e)
        return resolve(fallback, question, datasets, "default")
