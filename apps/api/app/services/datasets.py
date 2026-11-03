"""
Chartable datasets extracted from the tables inside indexed documents.

Spreadsheets and CSVs are indexed as Markdown tables (`Date | Open | ... ` + `--- | ---` + rows),
split across many chunks. This module stitches those rows back together per document and header,
types the columns (date axis, $ prices, volumes, % changes), and caches the result. Dashboards are
computed from these real rows - the language model only chooses *what* to plot, never the numbers.
"""
import hashlib
import re
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.services import pinecone_service
from app.services.lexical_index import lexical_index

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SEPARATOR = re.compile(r"^\s*\|?\s*:?-{3,}")
MIN_ROWS = 3


@dataclass
class Column:
    key: str  # header text exactly as in the document
    label: str  # human label, e.g. "Daily return"
    unit: str  # "$", "%" or ""
    kind: str  # open | high | low | close | price | volume | change | other
    mostly_zero: bool = False


@dataclass
class Dataset:
    id: str
    document_id: str
    document_name: str
    x_label: str
    x: List[str]
    x_is_date: bool
    columns: List[Column]
    values: Dict[str, List[Optional[float]]]
    family_entity_id: str
    allowed_roles: List[str] = field(default_factory=list)
    # column key -> source dates whose value was impossible (e.g. negative volume) and was dropped
    invalid: Dict[str, List[str]] = field(default_factory=dict)

    def column(self, name: Optional[str]) -> Optional[Column]:
        """Find a column by its header, label or kind (case-insensitive, punctuation-insensitive)."""
        if not name:
            return None
        want = _norm(name)
        for c in self.columns:
            if want in (_norm(c.key), _norm(c.label)):
                return c
        for c in self.columns:
            if want == c.kind or (want and want in _norm(c.key)):
                return c
        return None

    def by_kind(self, kind: str) -> Optional[Column]:
        return next((c for c in self.columns if c.kind == kind), None)

    def catalog_entry(self) -> Dict:
        return {
            "dataset_id": self.id,
            "document": self.document_name,
            "rows": len(self.x),
            "x_axis": f"{self.x_label} ({'dates ' + self.x[0] + ' to ' + self.x[-1] if self.x_is_date else 'categories'})",
            "columns": [
                {"key": c.key, "label": c.label, "unit": c.unit or "none", "kind": c.kind}
                | ({"note": "almost always 0"} if c.mostly_zero else {})
                for c in self.columns
            ],
        }


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def parse_number(cell: str) -> Optional[float]:
    c = cell.strip().replace(",", "").replace("A$", "").replace("$", "").replace("%", "")
    if c.startswith("+"):
        c = c[1:]
    if not c or c in ("-", "—", "n/a", "N/A"):
        return None
    try:
        return float(c)
    except ValueError:
        return None


def describe_column(key: str) -> Column:
    low = key.lower()
    unit = "$" if "$" in key else "%" if "%" in key else ""
    if "volume" in low or "shares" in low:
        kind, unit = "volume", ""
    elif re.search(r"\bopen\b", low):
        kind = "open"
    elif re.search(r"\bhigh\b", low) and "low" not in low:
        kind = "high"
    elif re.search(r"\blow\b", low) and "high" not in low:
        kind = "low"
    elif re.search(r"\b(close|closing)\b", low):
        kind = "close"
    elif any(w in low for w in ("return", "change", "growth", "yield", "rate", "pct", "percent")) or unit == "%":
        kind, unit = "change", "%"
    elif any(w in low for w in ("price", "spread", "balance", "amount", "value", "revenue", "income", "debt", "cost", "fee", "expense", "salary", "spending")):
        kind = "price"
        if not unit:
            unit = "$"
    elif "score" in low or "fico" in low:
        kind = "score"
    elif any(w in low for w in ("age", "count", "num")):
        kind = "count"
    else:
        kind = "other"
    if kind in ("open", "high", "low", "close") and not unit:
        unit = "$"
    label = re.sub(r"\((\$|%)\)|_\$|_%|\$|%", " ", key).replace("_", " ")
    label = re.sub(r"\s+", " ", label).strip()
    label = label[:1].upper() + label[1:].lower() if label else key
    return Column(key=key, label=label, unit=unit, kind=kind)


def iter_markdown_tables(text: str):
    """Yield (header_cells, row_cells_list) for each Markdown table in a chunk."""
    lines = text.splitlines()
    i = 0
    while i < len(lines) - 1:
        if "|" in lines[i] and SEPARATOR.match(lines[i + 1]):
            header = [h.strip() for h in lines[i].strip().strip("|").split("|")]
            rows = []
            j = i + 2
            while j < len(lines) and "|" in lines[j]:
                cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
                if len(cells) == len(header):
                    rows.append(cells)
                j += 1
            yield header, rows
            i = j
        else:
            i += 1


def build_datasets(chunks: List[Dict]) -> List[Dataset]:
    names_by_family: Dict[str, Dict[str, str]] = {}  # name lookups stay within each family (Audit I-20)
    groups: Dict[Tuple[str, Tuple[str, ...]], Dict] = {}
    for c in chunks:
        text = c.get("text", "")
        if "|" not in text or "---" not in text:
            continue
        for header, rows in iter_markdown_tables(text):
            if len(header) < 2 or not rows:
                continue
            key = (c.get("document_id", ""), tuple(header))
            g = groups.setdefault(key, {
                "rows": {},
                "family": c.get("family_entity_id", "default_family"),
                "roles": set(c.get("allowed_roles") or []),
                "name": c.get("original_name") or "",
            })
            for r in rows:
                g["rows"].setdefault(tuple(r), r)

    datasets: List[Dataset] = []
    for (doc_id, header), g in groups.items():
        rows = list(g["rows"].values())
        if len(rows) < MIN_ROWS:
            continue

        col_lower = [h.lower().strip() for h in header]
        has_ymd = "year" in col_lower and "month" in col_lower and "day" in col_lower
        date_col_idx = None
        if not has_ymd:
            for idx, h in enumerate(col_lower):
                if "date" in h:
                    date_col_idx = idx
                    break

        x: List[str] = []
        x_label = header[0]
        x_is_date = False

        if has_ymd:
            y_i = col_lower.index("year")
            m_i = col_lower.index("month")
            d_i = col_lower.index("day")
            valid_rows = []
            synthesized_dates = []
            for r in rows:
                try:
                    y_val = int(parse_number(r[y_i]) or 0)
                    m_val = int(parse_number(r[m_i]) or 0)
                    d_val = int(parse_number(r[d_i]) or 0)
                    if 1900 <= y_val <= 2100 and 1 <= m_val <= 12 and 1 <= d_val <= 31:
                        synthesized_dates.append(f"{y_val:04d}-{m_val:02d}-{d_val:02d}")
                        valid_rows.append(r)
                except Exception:
                    continue
            if len(valid_rows) >= MIN_ROWS and len(valid_rows) >= 0.7 * len(rows):
                paired = sorted(zip(synthesized_dates, valid_rows), key=lambda p: p[0])
                x = [p[0] for p in paired]
                rows = [p[1] for p in paired]
                x_label = "Date"
                x_is_date = True
        elif date_col_idx is not None:
            raw_dates = [r[date_col_idx] for r in rows]
            date_matches = [bool(ISO_DATE.match(d)) for d in raw_dates]
            if sum(date_matches) >= 0.8 * len(rows):
                paired = sorted(
                    [(r[date_col_idx], r) for r in rows if ISO_DATE.match(r[date_col_idx])],
                    key=lambda p: p[0]
                )
                x = [p[0] for p in paired]
                rows = [p[1] for p in paired]
                x_label = header[date_col_idx]
                x_is_date = True

        if not x:
            x_is_date = sum(bool(ISO_DATE.match(r[0])) for r in rows) >= 0.9 * len(rows)
            if x_is_date:
                rows = sorted((r for r in rows if ISO_DATE.match(r[0])), key=lambda r: r[0])
            x_label = header[0]
            x = [r[0] for r in rows]

        columns: List[Column] = []
        values: Dict[str, List[Optional[float]]] = {}
        invalid: Dict[str, List[str]] = {}
        for idx in range(len(header)):
            if not has_ymd and ((x_is_date and idx == date_col_idx) or (not x_is_date and idx == 0)):
                continue
            if has_ymd and idx in (y_i, m_i, d_i):
                continue
            raw = [r[idx] for r in rows]
            parsed = [parse_number(v) for v in raw]
            filled = [v for v in raw if v.strip()]
            numeric = [p for p in parsed if p is not None]
            if not filled or len(numeric) < 0.8 * len(filled) or len(filled) < 0.7 * len(rows):
                continue
            col = describe_column(header[idx])
            col.mostly_zero = sum(1 for p in numeric if p == 0) > 0.97 * len(numeric)
            if col.kind == "volume":
                bad = [x[i] for i, v in enumerate(parsed) if v is not None and v < 0]
                if bad:
                    invalid[col.key] = bad
                    parsed = [None if (v is not None and v < 0) else v for v in parsed]
            columns.append(col)
            values[col.key] = parsed

        if not columns:
            continue
        if g["family"] not in names_by_family:
            names_by_family[g["family"]] = pinecone_service.get_document_names(family_entity_id=g["family"])
        name = names_by_family[g["family"]].get(doc_id) or g["name"] or "Indexed table"
        datasets.append(Dataset(
            id=hashlib.sha1(f"{doc_id}|{'|'.join(header)}".encode()).hexdigest()[:10],
            document_id=doc_id,
            document_name=name,
            x_label=x_label,
            x=x,
            x_is_date=x_is_date,
            columns=columns,
            values=values,
            family_entity_id=g["family"],
            allowed_roles=sorted(g["roles"]),
            invalid=invalid,
        ))

    # The same ledger is often indexed in several formats (csv, xlsx, docx...): keep the richest copy.
    best: Dict[Tuple, Dataset] = {}
    for d in datasets:
        sig = (d.family_entity_id, len(d.x), d.x[0] if d.x else "", d.x[-1] if d.x else "")
        cur = best.get(sig)
        if cur is None or len(d.columns) > len(cur.columns):
            best[sig] = d
    return sorted(best.values(), key=lambda d: (not d.x_is_date, -len(d.x)))


_cache: Dict[str, object] = {"version": -1, "datasets": []}
_lock = threading.Lock()


def get_datasets(family_entity_id: str, user_roles: List[str]) -> List[Dataset]:
    """Datasets the caller may see (same tenant and at least one shared role)."""
    with _lock:
        if _cache["version"] != lexical_index.version:
            _cache["datasets"] = build_datasets(lexical_index.snapshot())
            _cache["version"] = lexical_index.version
        all_sets: List[Dataset] = _cache["datasets"]  # type: ignore[assignment]
    roles = set(user_roles)
    return [
        d for d in all_sets
        if d.family_entity_id == family_entity_id and (not d.allowed_roles or roles.intersection(d.allowed_roles))
    ]
