"""
Evaluation Report Generator.

Formats metrics into:
1. Markdown summary report with Gate Status, Metrics Table, and Worst 10 Failing Cases.
2. CLI formatted table for immediate console feedback.
"""
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def format_cli_table(results_summary: Dict[str, Any]) -> str:
    """Formats metrics as an aligned terminal ASCII table."""
    gates = results_summary["gates"]
    agg = results_summary["aggregated_metrics"]
    gate_passed = results_summary["gate_passed"]

    lines = [
        "",
        "=" * 72,
        "                      EVALUATION HARNESS RESULTS",
        "=" * 72,
        f"Total Test Cases: {results_summary['total_cases']}",
        f"Overall Gate Status: {'PASSED [OK]' if gate_passed else 'FAILED [X]'}",
        "-" * 72,
        f"{'Gate Metric':<25} | {'Threshold':<12} | {'Achieved':<12} | {'Status':<8}",
        "-" * 72,
    ]

    for name, g in gates.items():
        status = "PASS" if g["passed"] else "FAIL"
        lines.append(f"{name:<25} | {g['threshold']:<12} | {str(g['value']):<12} | {status:<8}")

    lines.extend([
        "-" * 72,
        "Additional Metrics:",
        f"  Recall@4:             {agg['recall@4']}",
        f"  MRR:                  {agg['mrr']}",
        f"  nDCG@8:               {agg['ndcg@8']}",
        f"  Citation Recall:      {agg['citation_recall']}",
        f"  Faithfulness:         {agg['faithfulness']}",
        f"  Latency p50 / p95:    {agg['p50_latency_ms']} ms / {agg['p95_latency_ms']} ms",
        f"  Total Tokens:         {agg['total_tokens']}",
        f"  Total Query Cost:     ${agg['total_cost_usd']:.6f} USD (read from llm_usage)",
        "=" * 72,
        "",
    ])
    return "\n".join(lines)


def generate_markdown_report(
    results_summary: Dict[str, Any],
    case_results: List[Dict[str, Any]],
    output_path: Optional[Path] = None,
) -> str:
    """Generates a GitHub-flavored Markdown evaluation report."""
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    gates = results_summary["gates"]
    agg = results_summary["aggregated_metrics"]
    passed = results_summary["gate_passed"]

    # Identify worst failing cases
    failing_cases = [
        c for c in case_results
        if c.get("metrics", {}).get("canary_leak", 0) > 0
        or c.get("metrics", {}).get("injection_success", 0) > 0
        or c.get("metrics", {}).get("acl_leak", 0) > 0
        or c.get("metrics", {}).get("numeric_accuracy", 1.0) < 1.0
        or c.get("metrics", {}).get("citation_precision", 1.0) < 0.9
        or c.get("metrics", {}).get("abstention_accuracy", 1.0) < 1.0
    ]

    # Sort worst cases: safety violations first, then lowest numeric accuracy
    def sort_key(c):
        m = c.get("metrics", {})
        safety_penalty = (m.get("canary_leak", 0) + m.get("injection_success", 0) + m.get("acl_leak", 0)) * -10
        return safety_penalty + m.get("numeric_accuracy", 1.0)

    failing_cases.sort(key=sort_key)
    worst_10 = failing_cases[:10]

    md_lines = [
        "# RAG Evaluation Report",
        "",
        f"- **Generated:** {now_str}",
        f"- **Total Cases Evaluated:** {results_summary['total_cases']}",
        f"- **Overall Evaluation Gate:** {'🟢 **PASSED**' if passed else '🔴 **FAILED**'}",
        "",
        "## 1. Quality & Safety Gates",
        "",
        "| Quality Gate | Condition | Actual Value | Gate Status |",
        "| :--- | :--- | :--- | :--- |",
    ]

    for name, g in gates.items():
        status_badge = "✅ PASS" if g["passed"] else "❌ FAIL"
        md_lines.append(f"| `{name}` | `{g['threshold']}` | **{g['value']}** | {status_badge} |")

    md_lines.extend([
        "",
        "## 2. Performance & Cost Summary",
        "",
        "| Metric | Value | Notes |",
        "| :--- | :--- | :--- |",
        f"| **Recall@4** | `{agg['recall@4']}` | Top-4 chunk retrieval coverage |",
        f"| **Recall@8** | `{agg['recall@8']}` | Top-8 chunk retrieval coverage |",
        f"| **MRR** | `{agg['mrr']}` | Mean Reciprocal Rank |",
        f"| **nDCG@8** | `{agg['ndcg@8']}` | Normalized Discounted Cumulative Gain |",
        f"| **Citation Precision** | `{agg['citation_precision']}` | Relevance of cited source chunks |",
        f"| **Citation Recall** | `{agg['citation_recall']}` | Expected source coverage |",
        f"| **Numeric Accuracy** | `{agg['numeric_accuracy']}` | Decimal & unit-aware verification |",
        f"| **Abstention Accuracy** | `{agg['abstention_accuracy']}` | Proper refusal on unanswerable/ACL queries |",
        f"| **Faithfulness** | `{agg['faithfulness']}` | Grounded claim ratio |",
        f"| **Latency (p50)** | `{agg['p50_latency_ms']} ms` | Median query latency |",
        f"| **Latency (p95)** | `{agg['p95_latency_ms']} ms` | 95th percentile query latency |",
        f"| **Total Tokens** | `{agg['total_tokens']}` | Across all evaluated queries |",
        f"| **Total Cost** | `${agg['total_cost_usd']:.6f} USD` | Exact sum recorded in `llm_usage` |",
        f"| **Avg Cost / Query** | `${agg['mean_cost_usd']:.6f} USD` | Exact average from `llm_usage` |",
        "",
        f"## 3. Failure Diagnostics ({len(failing_cases)} total failing, top {len(worst_10)} displayed)",
        "",
    ])

    if not worst_10:
        md_lines.append("🎉 **No failing cases observed. All evaluation assertions passed!**\n")
    else:
        for idx, case in enumerate(worst_10, 1):
            c_id = case.get("id", f"case_{idx}")
            q = case.get("question", "")
            ans = case.get("answer", "")
            m = case.get("metrics", {})
            retrieved = case.get("retrieved_chunks", [])
            md_lines.extend([
                f"### Case #{idx}: `{c_id}` ({case.get('type', 'generic')})",
                f"- **Question:** {q}",
                f"- **Role:** `{case.get('role', 'member')}` | **Tenant:** `{case.get('tenant', '')}`",
                f"- **Metrics:** Numeric Acc: `{m.get('numeric_accuracy')}`, Cit Precision: `{m.get('citation_precision')}`, Canary: `{m.get('canary_leak')}`, Inject: `{m.get('injection_success')}`",
                f"- **Answer Produced:**",
                f"> {ans[:400]}...",
                "- **Retrieved Chunks:**",
            ])
            for ch in retrieved[:3]:
                meta = ch.get("metadata", {})
                src = meta.get("source") or ch.get("source") or "unknown"
                txt = (ch.get("text") or ch.get("chunk_text") or "")[:150]
                md_lines.append(f"  - `[{src}]` {txt.strip()}...")
            md_lines.append("")

    report_content = "\n".join(md_lines)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report_content, encoding="utf-8")

    return report_content

