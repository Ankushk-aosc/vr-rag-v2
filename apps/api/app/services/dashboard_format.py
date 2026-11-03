"""
Number/date formatting and time bucketing for dashboards (split from dashboards.py, Audit I-22).
"""
from datetime import date, timedelta
from typing import List, Optional, Tuple

from app.services.datasets import Column

MAX_POINTS = 260


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
