"""Golden evaluation cases, grouped by category. Order matters: it is the order of golden.jsonl."""
from evals.golden_cases import dates_comparison_abstain_acl, lookup_multidoc_tables, security_followup_scanned

CASES = lookup_multidoc_tables.CASES + dates_comparison_abstain_acl.CASES + security_followup_scanned.CASES
