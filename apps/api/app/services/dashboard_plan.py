"""
Deterministic dashboard plan derived from the question, used when the LLM plan is unavailable
(split from dashboards.py, Audit I-22).
"""
import re
from datetime import date, timedelta
from typing import Any, Dict, Optional

from app.services.dashboard_format import nice_date
from app.services.datasets import Dataset
from app.services.lexical_index import extract_dates


# ---------------------------------------------------------------------------- planning

def _clip_iso(s: Optional[str]) -> Optional[str]:
    return s if isinstance(s, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else None


def default_plan(question: str, answer: str, ds: Dataset) -> Dict[str, Any]:
    """Deterministic plan dynamically adapted to the question intent."""
    close = ds.by_kind("close") or ds.by_kind("price") or ds.columns[0]
    volume = ds.by_kind("volume")
    change = ds.by_kind("change")
    open_col = ds.by_kind("open")
    high_col = ds.by_kind("high")
    low_col = ds.by_kind("low")
    spread_col = ds.column("High_Low_Spread_$") or ds.column("spread") or ds.column("range")
    has_ohlc = all((open_col, high_col, low_col, close))
    dates = extract_dates(question) or extract_dates(answer)
    years = re.findall(r"\b(19[89]\d|20[0-4]\d)\b", question)
    q = question.lower()
    doc_prefix = ds.document_name.split("_")[0]

    per_year = bool(re.search(r"\b(which|what|each|every|per|by)\s+year|\byearly\b|\bannual|\bper year\b", q))
    superlative = bool(re.search(
        r"\b(highest|lowest|most|least|max(imum)?|min(imum)?|peak|best|worst|biggest|largest|smallest)\b", q))
    is_compare = bool(re.search(r"\b(compare|versus|open and close|high and low|high vs low|difference)\b", q)) or (bool(re.search(r"\bvs\b", q)) and not bool(re.search(r"\bgains?\s*vs\s*loss", q)))
    about_change = bool(re.search(r"\breturns?\b|\bgain|\bloss|\bchange|\bprofit|\byield|\bpercent", q))
    about_spread = bool(re.search(r"\b(spread|range|fluctuat|volatil|risk|intraday|band)\b", q))
    about_volume = ("volume" in q or "traded" in q or "shares" in q or "liquidity" in q) and not is_compare
    about_candle = bool(re.search(r"\b(candle|candlestick|ohlc|price action)\b", q))

    plan: Dict[str, Any] = {"dataset_id": ds.id, "granularity": "auto", "kpis": [], "charts": []}

    # 1. Yearly aggregations or superlatives
    if ds.x_is_date and not dates and not years and (per_year or superlative):
        primary = (volume if about_volume else change if about_change else close) or close
        plan.update(title=f"{doc_prefix} {primary.label} by year", subtitle=f"{ds.x[0][:4]}–{ds.x[-1][:4]}, yearly",
                    x_start=None, x_end=None, focus=None, granularity="year")
        plan["kpis"] = [{"label": f"Highest {primary.label.lower()}", "column": primary.key, "stat": "max"},
                        {"label": f"Lowest {primary.label.lower()}", "column": primary.key, "stat": "min"}]
        plan["charts"].append({"type": "diverging_bar" if primary.unit == "%" else "bar",
                               "title": f"{primary.label} per year", "columns": [primary.key]})
        if primary is not close:
            plan["charts"].append({"type": "line", "title": f"{close.label} price", "columns": [close.key]})
        return plan

    # 2. Specific focus date
    if ds.x_is_date and dates:
        focus = dates[0]
        d = date.fromisoformat(focus)
        plan.update(
            title=f"{doc_prefix} around {nice_date(focus)}",
            subtitle=f"Daily trading data from {(d - timedelta(days=45)).isoformat()} to {(d + timedelta(days=45)).isoformat()}",
            x_start=(d - timedelta(days=45)).isoformat(), x_end=(d + timedelta(days=45)).isoformat(),
            focus=focus, granularity="day",
        )
        plan["kpis"] = [{"label": c.label, "column": c.key, "stat": "at_focus"} for c in (close, volume, change) if c]
        plan["charts"].append({"type": "candlestick" if has_ohlc else "line", "title": "Daily price action" if has_ohlc else f"{close.label}", "columns": [close.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading volume", "columns": [volume.key]})
        if change:
            plan["charts"].append({"type": "diverging_bar", "title": f"{change.label} (%)", "columns": [change.key]})
        return plan

    # 3. Year or year range filter
    if ds.x_is_date and years:
        y0, y1 = min(years), max(years)
        plan.update(title=f"{doc_prefix} in {y0}" + (f"–{y1}" if y1 != y0 else ""),
                    subtitle="Weekly view", x_start=f"{y0}-01-01", x_end=f"{y1}-12-31", focus=None, granularity="auto")
        plan["kpis"] = [{"label": f"{close.label} change", "column": close.key, "stat": "change_pct"},
                        {"label": f"Highest {close.label.lower()}", "column": close.key, "stat": "max"}]
        if volume:
            plan["kpis"].append({"label": "Total volume", "column": volume.key, "stat": "sum"})
        if change:
            plan["charts"].append({"type": "diverging_bar", "title": "Gains vs Losses", "columns": [change.key]})
        plan["charts"].append({"type": "line", "title": f"{close.label} price", "columns": [close.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading volume", "columns": [volume.key]})
        return plan

    # 4. Comparison intent: Open vs Close or High vs Low
    if is_compare and open_col and close:
        plan.update(title=f"{doc_prefix} Open vs Close Comparison",
                    subtitle="Multi-series price comparison & trajectory",
                    x_start=None, x_end=None, focus=None, granularity="auto")
        plan["kpis"] = [
            {"label": f"Latest {close.label}", "column": close.key, "stat": "last"},
            {"label": f"Latest {open_col.label}", "column": open_col.key, "stat": "last"},
        ]
        if spread_col:
            plan["kpis"].append({"label": "Max Intraday Spread", "column": spread_col.key, "stat": "max"})
        plan["charts"].append({
            "type": "line",
            "title": "Open vs Close Price Trajectory",
            "columns": [open_col.key, close.key],
        })
        if spread_col:
            plan["charts"].append({"type": "area", "title": "High-Low Price Spread", "columns": [spread_col.key]})
        elif change:
            plan["charts"].append({"type": "diverging_bar", "title": "Daily Returns (%)", "columns": [change.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading Volume", "columns": [volume.key]})
        return plan

    # 5. Returns, gains, losses, % changes
    if about_change and change:
        plan.update(title=f"{doc_prefix} Performance & Daily Returns",
                    subtitle="Signed % changes, gains vs losses, and growth trend",
                    x_start=None, x_end=None, focus=None, granularity="auto")
        plan["kpis"] = [
            {"label": "Best Single-Day Gain", "column": change.key, "stat": "max"},
            {"label": "Largest Single-Day Drop", "column": change.key, "stat": "min"},
            {"label": f"Latest {close.label}", "column": close.key, "stat": "last"},
        ]
        plan["charts"].append({
            "type": "diverging_bar",
            "title": f"{change.label} (Gains vs Losses)",
            "columns": [change.key],
        })
        plan["charts"].append({"type": "area", "title": f"{close.label} Trend", "columns": [close.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading Volume", "columns": [volume.key]})
        return plan

    # 6. Volatility & price range
    if about_spread and (spread_col or has_ohlc):
        plan.update(title=f"{doc_prefix} Volatility & Intraday Spreads",
                    subtitle="High-low price range distribution and volatility",
                    x_start=None, x_end=None, focus=None, granularity="auto")
        if spread_col:
            plan["kpis"] = [
                {"label": "Max Intraday Spread", "column": spread_col.key, "stat": "max"},
                {"label": "Average Spread", "column": spread_col.key, "stat": "mean"},
                {"label": f"Latest {close.label}", "column": close.key, "stat": "last"},
            ]
            plan["charts"].append({"type": "area", "title": "Intraday Price Spread ($)", "columns": [spread_col.key]})
        if has_ohlc:
            plan["charts"].append({"type": "candlestick", "title": "Price Range & OHLC", "columns": [close.key]})
        else:
            plan["charts"].append({"type": "line", "title": f"{close.label} Price", "columns": [close.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading Volume", "columns": [volume.key]})
        return plan

    # 7. Candlestick requested directly
    if about_candle and has_ohlc:
        plan.update(title=f"{doc_prefix} Candlestick Price Action",
                    subtitle="Daily OHLC price ranges and volume",
                    x_start=None, x_end=None, focus=None, granularity="auto")
        plan["kpis"] = [{"label": f"Latest {close.label}", "column": close.key, "stat": "last"},
                        {"label": f"All-time high {close.label}", "column": close.key, "stat": "max"}]
        plan["charts"].append({"type": "candlestick", "title": "OHLC Candlestick Range", "columns": [close.key]})
        if volume:
            plan["charts"].append({"type": "bar", "title": "Trading Volume", "columns": [volume.key]})
        if change:
            plan["charts"].append({"type": "diverging_bar", "title": "Returns (%)", "columns": [change.key]})
        return plan

    # 8. Volume requested
    if about_volume and volume:
        plan.update(title=f"{doc_prefix} Trading Volume & Liquidity",
                    subtitle="Historical volume turnover and price trend",
                    x_start=None, x_end=None, focus=None, granularity="auto")
        plan["kpis"] = [
            {"label": "Peak Traded Volume", "column": volume.key, "stat": "max"},
            {"label": "Average Volume", "column": volume.key, "stat": "mean"},
            {"label": f"Latest {close.label}", "column": close.key, "stat": "last"},
        ]
        plan["charts"].append({"type": "bar", "title": "Historical Trading Volume", "columns": [volume.key]})
        plan["charts"].append({"type": "line", "title": f"{close.label} Price Trajectory", "columns": [close.key]})
        if change:
            plan["charts"].append({"type": "diverging_bar", "title": "Daily Returns (%)", "columns": [change.key]})
        return plan

    # 9. General overview / Greeting / Broad inquiry -> Rich Multi-Chart Executive Suite
    plan.update(title=f"{doc_prefix} Executive Overview",
                subtitle=f"{ds.x[0]} to {ds.x[-1]}" if ds.x_is_date else ds.document_name,
                x_start=None, x_end=None, focus=None, granularity="auto")
    plan["kpis"] = [
        {"label": f"Latest {close.label.lower()}", "column": close.key, "stat": "last"},
        {"label": f"All-time high {close.label.lower()}", "column": close.key, "stat": "max"},
    ]
    if volume:
        plan["kpis"].append({"label": "Average volume", "column": volume.key, "stat": "mean"})
    if change:
        plan["kpis"].append({"label": "Best Single Gain", "column": change.key, "stat": "max"})

    # Dynamic multi-chart executive layout:
    # 1. Price/Amount trend (smooth area)
    plan["charts"].append({"type": "area", "title": f"{close.label} Trend", "columns": [close.key]})
    # 2. Volume or Spend bar chart
    if volume:
        plan["charts"].append({"type": "bar", "title": "Trading Volume Activity", "columns": [volume.key]})
    elif ds.x_is_date:
        plan["charts"].append({"type": "bar", "title": f"Total {close.label} by Period", "columns": [close.key], "agg": "sum"})
    # 3. Performance / Returns or Average Trajectory
    if change:
        plan["charts"].append({"type": "diverging_bar", "title": "Performance: Gains vs Losses", "columns": [change.key]})
    elif ds.x_is_date:
        plan["charts"].append({"type": "line", "title": f"Average {close.label} Trajectory", "columns": [close.key], "agg": "mean"})
        plan["kpis"].append({"label": f"Total {close.label.lower()}", "column": close.key, "stat": "sum"})
        plan["kpis"].append({"label": f"Average {close.label.lower()}", "column": close.key, "stat": "mean"})
    # 4. Spread / Volatility (if available)
    if spread_col:
        plan["charts"].append({"type": "line", "title": "Intraday Price Spread", "columns": [spread_col.key]})

    return plan
