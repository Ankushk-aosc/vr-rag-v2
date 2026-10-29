# Aether Sovereign (VR-RAG) — Comprehensive Remediation & Features Report

**Reference:** Security & Architecture Audit Remediation (October 2026)  
**System:** Aether Sovereign Financial Pavilion (`VR-RAG`)  
**Target Environment:** Australian Family Office Spatial Intelligence Platform  
**Compliance Standard:** Australian Privacy Principles (APPs, Privacy Act 1988), ASIC RG 244  
**Test Suite Status:** 85/85 Pytest Unit & Integration Tests Passing (100% Pass Rate)

---

## 1. Executive Summary

Following a comprehensive security, architecture, and regulatory audit of the VR-RAG platform, all identified vulnerabilities, prototype mock fallbacks, client-controlled tenancy gaps, and cross-border data leakage risks have been remediated across 7 sequential engineering phases.

The platform has been transformed from an open-endpoint prototype into a production-ready, multi-tenant sovereign financial pavilion with fail-closed security, constant-time authentication, numeric hallucination detection, prompt-injection defense, and complete storage cascade erasure.

---

## 2. New Modules & Architecture Components Added

The following dedicated, modular components were engineered to adhere to strict single-responsibility principles without code cramming (<600 lines per module):

1. **`apps/api/app/middleware/rate_limiter.py`**:
   - In-memory thread-safe sliding-window rate limiter.
   - Enforces configurable request thresholds per client IP or token prefix across sensitive auth (`/api/auth/login`, 20 req/min), LLM synthesis (`/api/query`, 30 req/min), and voice transcription endpoints (`/api/voice`, 20 req/min).
   - Returns structured `HTTP 429 Too Many Requests` with RFC-compliant `Retry-After` headers.

2. **`apps/api/app/services/prompt_guard.py`**:
   - Defense against prompt injection and jailbreak attempts within indexed document text.
   - Escapes structural XML evidence tags (`</evidence>`), neutralizing attacker attempts to break out of context delimiters.
   - Strips fake system instructions (`System:`, `Assistant:`, `[INST]`, `<<SYS>>`) from document chunks prior to LLM injection.
   - Sanitizes and truncates conversation turn history to eliminate context-overflow exploits.

3. **`apps/api/app/services/grounding.py`**:
   - Comprehensive factual and numerical grounding verification engine.
   - Regex-based extraction of Australian currency amounts, percentages, and ISO financial dates.
   - Validates that inline citations `[n]` correspond to retrieved evidence passages.
   - Verifies all numeric figures in generated answers against underlying source chunks, calculating claim accuracy and flagging hallucinated financial numbers (`grounded=False`).

4. **`apps/api/app/services/upload_security.py`**:
   - Multi-stage upload validation barrier.
   - Path traversal prevention via strict filename sanitization and 120-character truncation.
   - Magic-byte verification validating MIME types (`application/pdf`, `application/vnd.openxmlformats-...`, `text/csv`, `text/plain`).
   - Decompression bomb protection for OOXML files (`.docx`, `.xlsx`), enforcing a maximum 50:1 compression ratio and 150MB uncompressed limit.
   - 25MB file size cap for voice audio uploads.

5. **`apps/api/app/services/table_reader.py`**:
   - Isolated tabular extraction service for large financial CSV and Excel sheets.
   - Streaming row retrieval preventing high-memory buffering.

6. **`apps/web/src/lib/auth.ts`**:
   - Frontend authentication and token management service.
   - Manages JWT storage, active family entity context, and automatic Bearer header injection across Web API calls.

---

## 3. Features Implemented by Phase

### Phase 1: Mandatory Authentication & Server-Side Tenancy
- **Audit Findings Remediated:** `S1`, `S2`, `S4`, `R1`, `U1`.
- **Enforced JWT Authentication:** All data, query, voice, and document endpoints now mandate `Depends(auth.get_current_user)`. Unauthenticated access strictly returns `HTTP 401 Unauthorized`.
- **Server-Side Tenancy Isolation:** Client-supplied tenancy headers and body fields are rejected. The user's active tenant entity (`family_entity_id`) is resolved directly from cryptographically signed JWT claims and verified against the SQLite database.
- **Role-Based Access Control (RBAC):** Users must hold active membership in the target entity. Cross-tenant access attempts are rejected with `HTTP 403 Forbidden`.
- **Web & Mobile Integration:** Both Next.js web client and Expo mobile client inject `Authorization: Bearer <token>` on all requests.

### Phase 2: Lifecycle Endpoints & Database Transaction Safety
- **Audit Findings Remediated:** `S9`, `S7`, `F1`, `F2`, `R5`.
- **Multi-Tenant Safe SQLite Hashing:** Replaced dangerous global `UNIQUE(file_hash)` with `UNIQUE(family_entity_id, file_hash)`. Uploading identical files across different family offices preserves separate, independent records.
- **Non-Destructive Ingestion:** Eliminated `INSERT OR REPLACE` in SQLite; replaced with explicit `INSERT` and hash pre-checks, preventing accidental metadata overwriting.
- **Sovereign Deletion Cascade (`DELETE /api/documents/{document_id}`):** Deleting a document removes SQLite metadata, deletes cloud vector chunks in Pinecone, purges postings from the BM25 index, and creates an immutable audit trail entry (`DOCUMENT_DELETED`).
- **Session Revocation (`POST /api/auth/logout`):** Token revocation table checks JWT ID (`jti`) on every request, allowing immediate invalidation of compromised credentials.
- **Account Self-Service:** Added `POST /api/auth/password-reset` and `DELETE /api/auth/account`.

### Phase 3: Information Leakage & Secret Hardening
- **Audit Findings Remediated:** `S3`, `S5`, `S6`, `S10`, `S11`, `S16`.
- **Fail-Fast Secret Validation:** Server refuses to start up if `ENVIRONMENT != "development"` and `JWT_SECRET_KEY` is a default placeholder or shorter than 32 characters.
- **Constant-Time Password Verification:** Implemented constant-time dummy password hashing on non-existent user lookups, completely eliminating timing enumeration side-channels.
- **PBKDF2 Iteration Upgrade:** Upgraded password hashing work factor to 600,000 iterations (OWASP standard) while retaining backward compatibility for legacy hashes.
- **Audit Trail Tenant Scoping:** Scoped `/api/auth/audit` strictly by the authorized family entity. Regular members can only inspect their own user actions; only `family_admin` can inspect entity-wide audit records.
- **Log Masking:** Failed authentication attempts mask email addresses (e.g., `v***t@familyoffice.com`) to prevent credentials leakage in server logs.
- **Pinecone Code Hardening:** Removed dead `users_registry` vectors and eliminated wildcard `"*"` search queries.

### Phase 4: RAG Pipeline, Grounding & Injection Defense
- **Audit Findings Remediated:** `R3`, `R4`, `R6`, `R7`, `R8`, `R10`.
- **Tenant-Partitioned BM25 Keyword Search:** BM25 lexical index is strictly partitioned by `family_entity_id` in memory and cached in isolated tenant files (`data/lexical/lexical_{family_id}.json`). Cross-tenant keyword queries return 0 results.
- **Grounding Verification:** Integrated `grounding.verify_grounding` into query generation. Numeric claims in responses are validated against retrieved source chunks; ungrounded statements are flagged.
- **Fail-Closed Vector Embeddings:** Removed fallback that generated fake random SHA-based embeddings on missing models. Missing models now fail closed with clear, actionable configuration errors.
- **Calibrated Hybrid Retrieval Scoring:** Replaced disproportionate exact-date retrieval boost (`+1.0`) with a balanced boost (`+0.05`), ensuring semantic relevance is not eclipsed. Added SHA-256 passage deduplication.

### Phase 5: Upload Security, Rate Limiting & Resource Protection
- **Audit Findings Remediated:** `S8`, `F3`, `F4`, `F5`, `F6`, `S12`, `S14`.
- **Rate Limiting Middleware:** Enforced per-IP and per-token sliding window rate limits on auth, query, and voice endpoints.
- **Safe Memory Extraction:** Configured `openpyxl.load_workbook(..., read_only=True, data_only=True)` wrapped in strict `try/finally` blocks to guarantee file handles and temporary files are unlinked on disk.
- **Hard Resource Limits:** PDF extraction capped at 200 pages; CSV tables capped at 50,000 rows. Legacy `.doc` and `.xls` binaries are rejected cleanly.
- **Global Structured Error Handler:** FastAPI error handler intercepts unhandled exceptions, logs full stack traces internally with UUID correlation IDs, and returns sanitized, generic error responses without leaking file paths or database schemas.
- **Voice Log Sanitization:** `/api/voice/client-log` requires authentication, applies rate limiting, and strips newline characters (`\r`, `\n`) to prevent log-injection forging.

### Phase 6: Frontend & Mobile Real Data & UI Hardening
- **Audit Findings Remediated:** `U2`, `U3`, `U4`, `U5`, `D1`, `D2`.
- **Purge of Fake Mock Data:** Removed `DEFAULT_SPATIAL_DOCS` mock AAPL documents from `docTextureHelper.ts` and `SpatialWorld.ts`. Empty accounts display an authentic empty vault without phantom cards.
- **Decoupled Demo Phrases:** Replaced hardcoded Apple AAPL prompts across suggestion chips, voice prompts, and input placeholders with domain-authentic Australian financial terminology (ASX, superannuation, franking credits, ATO).
- **Dynamic Mobile Networking:** Replaced hardcoded LAN IP (`192.168.1.127`) in `apps/mobile/src/services/api.ts` with `process.env.EXPO_PUBLIC_API_URL` and standard platform loopbacks.
- **Sensitive QR Removal:** Removed tracked `expo_qr.png` and `expo_qr.txt` from repository and added `expo_qr.*` to `.gitignore`.
- **Markdown Security:** Restricted markdown link rendering in `apps/web/src/components/Markdown.tsx` to strict `https://` protocols with `rel="noopener noreferrer"`. Dangerous schemes (`javascript:`, `data:`) render as inert plain text.
- **Transparent Privacy Disclosures (APP 8):** Updated `README.md` and `docs/runbook.md` to transparently disclose external cloud data flows (Pinecone in US `us-east-1`, Groq LLM API, Microsoft Edge-TTS) in compliance with Australian Privacy Principle 8.

### Phase 7: End-to-End Security Isolation Verification
- **Audit Findings Remediated:** `O3`, Automated Verification Matrix.
- **Comprehensive Matrix Suite:** Created `apps/api/tests/test_phase7_end_to_end_security_matrix.py` verifying:
  1. `test_anonymous_access_denied`: 401 across all sensitive endpoints.
  2. `test_cross_tenant_query_isolation`: 403 on cross-tenant querying.
  3. `test_cross_tenant_document_leak`: 403 on metadata, table, and delete attempts.
  4. `test_duplicate_upload_non_destructive`: Safe multi-tenant file hashing.
  5. `test_document_deletion_cascade`: Clean deletion across SQLite, Pinecone, and BM25.
  6. `test_numeric_grounding_verification`: Hallucinated number detection.
  7. `test_rate_limiting`: 429 enforcement with `Retry-After`.

---

## 4. Test Verification Summary

```
Total Test Suites: 7 dedicated remediation suites + existing regression suites
Total Tests Executed: 85
Total Tests Passed: 85
Failures / Errors: 0 (100% Pass Rate)
Duration: 48.46s

Web TypeScript Compiler (apps/web): 0 Errors
Mobile TypeScript Compiler (apps/mobile): 0 Errors
```
