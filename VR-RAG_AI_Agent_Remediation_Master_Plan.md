# VR-RAG / Aether Sovereign — AI Agent Remediation Master Plan

## Purpose

This document is the master engineering remediation plan for the VR-RAG (Aether Sovereign) application.

Use this document as the implementation contract for an AI coding agent. The agent must inspect the actual repository, verify every issue against the codebase, implement fixes safely, run tests, and report what was changed.

**Do not assume an issue is fixed merely because code was changed. Every fix must be verified with tests or an explicit validation step.**

The source production-readiness audit rated the application **2/10** and recommended **Do Not Deploy** until the critical security, privacy, correctness, reliability, testing, and deployment issues are resolved.

---

# 1. AI AGENT OPERATING RULES

## 1.1 Inspect before modifying

Before changing code:

1. Inspect the complete repository structure.
2. Identify frontend, backend, mobile, database, RAG, authentication, configuration, deployment and test code.
3. Identify the actual technology versions.
4. Identify current authentication and authorization flows.
5. Identify all API endpoints.
6. Identify all database/vector-store access paths.
7. Identify all external providers.
8. Identify all environment variables and hardcoded configuration.
9. Identify existing tests and determine which are actually runnable.
10. Create a baseline report before making changes.

Do not blindly rewrite the application.

## 1.2 Preserve working functionality

Do not remove valid functionality simply to make tests pass.

When refactoring:

- preserve existing APIs where practical;
- document intentional breaking changes;
- avoid unnecessary framework migrations;
- avoid replacing working business logic without understanding it;
- keep tenant boundaries intact throughout every change.

## 1.3 Security comes before UI polish

Fix in this general order:

1. Authentication
2. Tenant isolation
3. Authorization/RBAC
4. Privacy/data-flow correctness
5. Financial/RAG correctness
6. Upload and API security
7. Error handling and reliability
8. Database architecture
9. Testing
10. Observability
11. Deployment
12. Frontend/mobile cleanup
13. Code quality

Do not spend the majority of the effort on visual improvements while P0 security issues remain.

---

# 2. TARGET ARCHITECTURE

The target architecture should be approximately:

```text
User
  |
  v
Web / Mobile Frontend
  |
  v
Authentication
  |
  v
FastAPI API Boundary
  |
  +---- Authentication / Session Validation
  |
  +---- Authorization / RBAC
  |
  +---- Tenant / Family Resolution
  |
  +---- Document ACL Validation
  |
  +---- Rate Limiting
  |
  v
PostgreSQL — System of Record
  |
  +---- Users
  +---- Families / Entities
  +---- Memberships
  +---- Roles
  +---- Documents
  +---- Document ACLs
  +---- Document Versions
  +---- Chunks / Metadata
  +---- Audit Logs
  +---- Jobs
  |
  v
RAG / Retrieval Layer
  |
  +---- Authorized metadata filter
  +---- Retrieval
  +---- Evidence validation
  |
  v
Pinecone — Vector Search Layer
  |
  v
LLM Provider Adapter
  |
  v
Validated Answer + Real Citations
  |
  v
Frontend
```

Pinecone must not be treated as the primary transactional application database.

The backend must be the security boundary. The frontend must never determine whether a user is authorized to access another family's data.

---

# 3. COMPLETE REMEDIATION ISSUE LIST

## 1. Authentication

**Priority:** P0

### Problem

Protected APIs can currently be reached without reliable server-side authentication.

### Required fix

- Require authentication for every protected endpoint.
- Validate JWT/session server-side.
- Return `401` for missing/invalid/expired credentials.
- Never trust a client-provided user identity.
- Implement secure login/session handling.
- Implement logout/session invalidation where appropriate.
- Do not allow authentication bypass in production.

### Verification

Create automated tests for:

- no token -> 401;
- invalid token -> 401;
- expired token -> 401;
- valid token -> allowed.

---

## 2. Tenant / Family Isolation

**Priority:** P0

### Problem

The client can influence `family_entity_id` and potentially access another family's information.

### Required fix

The server must derive the authorized family/entity from authenticated identity and memberships.

Never trust:

```text
frontend -> family_entity_id -> database/Pinecone
```

Instead:

```text
JWT/session
  -> user
  -> memberships
  -> authorized family/entity
  -> server-generated retrieval filter
```

### Verification

User A must never be able to retrieve, modify, delete or query User B's family data even when manually changing IDs in requests.

---

## 3. Authorization / RBAC

**Priority:** P0

### Problem

Roles are not reliably enforced server-side.

### Required fix

Implement server-side RBAC for roles such as:

- family_admin
- member
- read_only_adviser

Permissions must be checked on every protected operation.

Frontend visibility is not authorization.

### Verification

Test each role against:

- read;
- upload;
- update;
- delete;
- invite;
- permission changes;
- administrative operations.

---

## 4. Admin Privilege Escalation

**Priority:** P0

### Problem

Unknown/new users may receive excessive privileges.

### Required fix

- Never default unknown users to admin.
- Require explicit membership.
- Validate user existence and membership.
- Fail closed.
- Reject unknown JWT subjects.
- Remove insecure default admin/family behavior.

---

## 5. Privacy Architecture

**Priority:** P0

### Problem

Product privacy claims do not match actual cloud data flows.

Potential external data flows include vector storage, LLM processing, TTS/STT and other providers.

### Required fix

Choose and implement one truthful architecture:

### Option A — Private/local

All sensitive processing remains within the intended private environment.

### Option B — Cloud

Explicitly disclose:

- what data is stored;
- where it is stored;
- what providers process it;
- what audio/text is transmitted;
- retention;
- security controls.

Never claim “local-only” or “no cloud AI” when data leaves the system.

---

## 6. Fake Financial Evidence

**Priority:** P0

### Problem

Frontend contains fake AAPL evidence, fake documents/citations, fake QR/verification states and misleading verified indicators.

### Required fix

Remove all fabricated evidence.

Every displayed citation must originate from:

```text
real document
+
authorized tenant
+
real chunk
+
real page/section/source metadata
```

If evidence does not exist, explicitly state:

```text
Evidence unavailable.
```

Never fabricate evidence.

---

## 7. Financial Accuracy / Currency

**Priority:** P0

### Problem

Currency may be incorrectly forced to AUD.

### Required fix

- Preserve source currency.
- Store currency explicitly.
- Never hardcode AUD.
- Perform actual FX conversion when needed.
- Store FX rate and timestamp.
- Avoid mixing currencies without conversion.
- Validate financial calculations.

---

## 8. LLM Failure Handling

**Priority:** P0

### Problem

LLM/provider failures can be represented as successful grounded responses.

### Required fix

Distinguish:

- successful response;
- no evidence;
- retrieval failure;
- LLM failure;
- timeout;
- provider error;
- malformed provider response.

Use appropriate HTTP errors such as 502/503 where applicable.

Never fabricate an answer after an LLM failure.

---

## 9. Prompt Injection

**Priority:** P0

### Problem

Retrieved documents are untrusted content and can contain instructions intended to manipulate the model.

### Required fix

Treat retrieved content strictly as data.

Implement:

- strong system instructions;
- explicit trust boundaries;
- prompt-injection defenses;
- output validation;
- tenant filtering before retrieval;
- safe document parsing.

---

## 10. Data Poisoning

**Priority:** P0

### Problem

Incorrect or malicious documents can contaminate the knowledge base.

### Required fix

Add:

- ingestion validation;
- source/provenance tracking;
- metadata validation;
- duplicate detection;
- document integrity checks;
- controlled upload permissions;
- audit trail.

---

## 11. Document Upload Security

**Priority:** P0/P1

### Problem

Upload validation and size controls are insufficient.

### Required fix

Implement:

- authentication;
- authorization;
- file-size limits;
- MIME validation;
- magic-byte validation;
- supported-extension validation;
- malware scanning where appropriate;
- filename sanitization;
- temporary-file safety;
- storage quotas;
- per-user/family limits;
- timeout controls.

Do not accept an extension merely because it appears in the filename.

---

## 12. API Rate Limiting

**Priority:** P0/P1

### Problem

Important APIs lack sufficient rate limiting.

### Required fix

Rate-limit:

- login;
- registration;
- query;
- search;
- upload;
- voice;
- expensive LLM operations.

Use appropriate limits per:

- IP;
- authenticated user;
- family/entity;
- endpoint.

Also implement concurrency and request-body limits.

---

## 13. Pinecone Architecture

**Priority:** P1

### Problem

Pinecone is being used as more than a vector search layer.

### Required fix

Use PostgreSQL as the system of record.

Pinecone should primarily contain:

- vectors;
- vector IDs;
- minimal safe retrieval metadata.

Transactional application state belongs in PostgreSQL.

---

## 14. Database / SQLite

**Priority:** P1

### Problem

SQLite configuration/implementation is incomplete and is not an adequate production system of record for the target architecture.

### Required fix

Move production application state to PostgreSQL.

Implement:

- schema;
- migrations;
- connection pooling;
- transactions;
- indexes;
- uniqueness constraints;
- backup/restore.

---

## 15. Document ACLs

**Priority:** P0

### Problem

Document access is not consistently enforced server-side.

### Required fix

Implement document-level ACL checks before:

- retrieval;
- download;
- view;
- update;
- delete;
- re-index;
- sharing.

The RAG query must only retrieve documents the current user is authorized to access.

---

## 16. Sensitive Data Logging

**Priority:** P0/P1

### Problem

Sensitive financial information, including voice transcripts, may be logged.

### Required fix

Do not log:

- passwords;
- tokens;
- API keys;
- financial documents;
- raw voice transcripts;
- sensitive personal information.

Use redacted structured logs.

---

## 17. Error Handling

**Priority:** P1

### Problem

Exceptions can be swallowed and internal implementation details may leak.

### Required fix

Create centralized error handling.

Use:

- safe user-facing error messages;
- internal structured logs;
- request/correlation IDs;
- consistent error codes.

Never expose stack traces, secrets, internal paths or provider credentials.

---

## 18. Dependency Vulnerabilities

**Priority:** P0/P1

### Problem

The frontend and backend contain vulnerable/outdated/unreliable dependencies.

### Required fix

- Audit all dependencies.
- Upgrade security-critical packages.
- Pin versions.
- Maintain lockfiles.
- Remove unused dependencies.
- Run dependency scanning in CI.

Do not deploy with unresolved critical vulnerabilities unless formally assessed and accepted.

---

## 19. Configuration Security

**Priority:** P0/P1

### Problem

Hardcoded LAN IPs, paths, CORS values, default family settings and other configuration exist.

### Required fix

Move environment-specific values into validated configuration.

Examples:

```env
DATABASE_URL=
PINECONE_API_KEY=
PINECONE_INDEX=
LLM_API_KEY=
JWT_SECRET=
CORS_ORIGINS=
UPLOAD_MAX_SIZE=
```

Never commit production secrets.

---

## 20. Production Secrets

**Priority:** P0

### Problem

Dangerous/default secrets may be accepted.

### Required fix

At startup, reject:

- default JWT secrets;
- placeholder API keys;
- weak production secrets;
- missing required secrets.

Use a proper secret manager in production where practical.

---

## 21. API Authorization Coverage

**Priority:** P0

### Problem

Some endpoints do not consistently require authentication and authorization.

### Required fix

Create a complete API inventory.

For every endpoint document:

- authentication requirement;
- role requirement;
- tenant requirement;
- resource ownership;
- rate limit;
- audit requirement.

No protected endpoint should be accidentally public.

---

## 22. Blocking Backend Operations

**Priority:** P1

### Problem

Blocking synchronous work occurs inside async handlers.

### Required fix

Move expensive/blocking work to:

- async APIs;
- background workers;
- job queues;
- thread/process pools where appropriate.

Do not block the FastAPI event loop with long-running document or provider operations.

---

## 23. Ingestion Pipeline

**Priority:** P1

### Problem

Bulk ingestion is synchronous and unreliable.

### Required fix

Implement asynchronous ingestion jobs with:

- job ID;
- status;
- progress;
- retries;
- timeout;
- cancellation;
- error state;
- cleanup;
- idempotency.

---

## 24. Duplicate Registration

**Priority:** P1

### Problem

Concurrent registrations can create duplicate records.

### Required fix

Use:

- database uniqueness constraints;
- transactions;
- idempotent registration logic.

Do not rely only on application-level checks.

---

## 25. Duplicate Uploads

**Priority:** P1

### Problem

Concurrent uploads can create duplicate documents/vectors.

### Required fix

Use:

- content hashes;
- idempotency keys;
- uniqueness constraints;
- transaction-safe indexing.

---

## 26. Partial Uploads / Orphan Vectors

**Priority:** P1

### Problem

Failed uploads can leave incomplete records or orphan vectors.

### Required fix

Implement a controlled lifecycle:

```text
Upload
 -> validate
 -> create pending document
 -> parse
 -> chunk
 -> embed
 -> index
 -> commit
 -> mark complete
```

If any step fails, clean up or mark the job failed and make retry safe.

---

## 27. Embedding / Chunking

**Priority:** P1

### Problem

Embedding input can be truncated or chunking can exceed model limits.

### Required fix

Use token-aware chunking.

Track:

- chunk ID;
- document ID;
- section;
- page;
- offsets;
- token count;
- source metadata.

Do not silently truncate important financial content.

---

## 28. Pinecone Performance

**Priority:** P1

### Problem

Pinecone control-plane calls occur unnecessarily often.

### Required fix

Cache/reuse index configuration.

Avoid repeated control-plane calls during normal query operations.

---

## 29. Frontend GPU Memory

**Priority:** P1

### Problem

Three.js resources can leak GPU memory.

### Required fix

Properly dispose:

- geometries;
- materials;
- textures;
- render targets;
- scenes;
- animation loops;
- WebGL resources.

Verify cleanup on component unmount.

---

## 30. Frontend Bundle Size

**Priority:** P1

### Problem

Heavy Three.js code is eagerly loaded.

### Required fix

Lazy-load expensive visualization modules.

Only load Three.js functionality when required.

---

## 31. Mobile Voice State

**Priority:** P1

### Problem

Stale React closures can cause incorrect voice-query behavior.

### Required fix

Review:

- state dependencies;
- refs;
- async callbacks;
- event listeners;
- cleanup.

Add tests for repeated voice interactions.

---

## 32. Mobile Animation Cleanup

**Priority:** P1

### Problem

`requestAnimationFrame` cleanup is incomplete.

### Required fix

Cancel animation frames and remove listeners when components unmount.

---

## 33. Mobile Network Security

**Priority:** P0/P1

### Problem

Hardcoded LAN IPs and HTTP are used.

### Required fix

Use environment-based API configuration.

Production must use HTTPS.

Do not hardcode local development IPs into release builds.

---

## 34. Frontend Authentication Handling

**Priority:** P0

### Problem

Frontend authentication and 401 handling are incomplete.

### Required fix

Centralize:

- token/session management;
- login state;
- 401 handling;
- session expiration;
- logout;
- retry rules.

Never retry authentication failures indefinitely.

---

## 35. Fake QR / Verification

**Priority:** P0

### Problem

QR and verification UI may represent information that was never verified.

### Required fix

Only display verification status backed by real backend state.

QR codes must encode real validated data.

---

## 36. Financial Disclaimer

**Priority:** P1

### Problem

Relevant financial disclaimers are not consistently displayed.

### Required fix

Add the appropriate disclaimer to relevant financial outputs and ensure it cannot be accidentally hidden in critical contexts.

---

## 37. Request Cancellation

**Priority:** P1

### Problem

Long-running frontend requests cannot always be cancelled.

### Required fix

Use `AbortController` or equivalent cancellation mechanisms.

Cancel requests when:

- user navigates away;
- query is replaced;
- component unmounts;
- user explicitly cancels.

---

## 38. Voice / TTS / STT Reliability

**Priority:** P1

### Problem

External speech services can fail without robust fallback.

### Required fix

Create provider adapters.

Implement:

- timeouts;
- retries where safe;
- response validation;
- fallback;
- user-safe errors;
- privacy disclosure.

---

## 39. External API Validation

**Priority:** P1

### Problem

External provider responses are not consistently validated.

### Required fix

Validate all responses from:

- Pinecone;
- LLM providers;
- STT;
- TTS;
- embedding providers;
- HuggingFace/download services.

Never assume an external response has the expected shape.

---

## 40. Chain-of-Thought Exposure

**Priority:** P0

### Problem

Internal model reasoning can be exposed to clients.

### Required fix

Return only:

- final answer;
- supported evidence;
- citations;
- safe metadata.

Do not expose hidden/private reasoning traces.

---

## 41. File Type Validation

**Priority:** P1

### Problem

Some file extensions can be accepted even when parsing is unsupported.

### Required fix

Either implement reliable parsing or reject unsupported file types before ingestion.

Maintain an explicit supported-format list.

---

## 42. API Pagination

**Priority:** P1

### Problem

Large result collections lack proper pagination.

### Required fix

Implement server-side:

- page size limits;
- cursor pagination where appropriate;
- stable ordering;
- maximum result limits.

Never allow unlimited collection retrieval.

---

## 43. API Versioning

**Priority:** P2

### Problem

API versioning is missing.

### Required fix

Introduce a versioning strategy such as:

```text
/api/v1/...
```

Document compatibility rules.

---

## 44. Observability

**Priority:** P1

### Problem

There are insufficient metrics, tracing and request IDs.

### Required fix

Implement:

- request ID;
- structured logs;
- request latency;
- error rate;
- provider latency;
- ingestion metrics;
- query metrics;
- authentication failures;
- rate-limit events.

Use distributed tracing where appropriate.

---

## 45. Audit Trail

**Priority:** P1

### Problem

Security/business operations lack a reliable audit trail.

### Required fix

Record appropriate events such as:

- login;
- logout;
- failed authentication;
- document upload;
- document access;
- document deletion;
- permission change;
- family membership change;
- sensitive query operations.

Do not store sensitive payloads unnecessarily.

---

## 46. Health Checks

**Priority:** P1

### Problem

Health endpoints do not provide meaningful dependency status.

### Required fix

Separate:

- liveness;
- readiness.

Readiness should validate required dependencies such as:

- PostgreSQL;
- vector service;
- required provider configuration.

Do not expose secrets or environment values through health endpoints.

---

## 47. Testing

**Priority:** P0

### Problem

Critical security/business paths are insufficiently tested.

### Required fix

Build a real automated test suite covering:

- authentication;
- authorization;
- tenant isolation;
- document ACLs;
- uploads;
- RAG retrieval;
- financial correctness;
- error handling;
- provider failures;
- concurrency;
- frontend API behavior.

---

## 48. Cross-Tenant Security Tests

**Priority:** P0

### Problem

There is insufficient proof that one family cannot access another family's data.

### Required fix

Create explicit automated tests:

```text
User A -> Family A -> allowed
User A -> Family B -> denied
User B -> Family A -> denied
Admin A -> Family B -> denied
Read-only A -> upload -> denied
```

Also test manipulated IDs and direct API calls.

---

## 49. Production Deployment

**Priority:** P1

### Problem

There is no complete production deployment story.

### Required fix

Implement:

- Docker;
- production configuration;
- CI/CD;
- HTTPS/TLS;
- secret management;
- migrations;
- health checks;
- rollback;
- resource limits.

---

## 50. Backup / Recovery

**Priority:** P1

### Problem

Production backup/recovery strategy is missing.

### Required fix

Implement:

- automated PostgreSQL backups;
- backup retention;
- encryption;
- restore testing;
- disaster recovery procedure;
- documented RPO/RTO targets.

A backup is not considered valid until restoration has been tested.

---

## 51. CI/CD Security

**Priority:** P1

### Problem

Automated quality/security gates are missing.

### Required fix

CI should run:

```text
install
-> lint
-> type check
-> unit tests
-> integration tests
-> security tests
-> dependency scan
-> build
```

Production deployment should require successful gates.

---

## 52. Dead Code

**Priority:** P2

### Problem

Unused/dead implementation exists.

### Required fix

Remove obsolete code after verifying it is unused.

Do not delete code blindly.

---

## 53. Duplicated Logic

**Priority:** P2

### Problem

Shared functionality is duplicated.

### Required fix

Centralize:

- API clients;
- authentication;
- error handling;
- configuration;
- RAG utilities;
- validation;
- common UI behavior.

---

## 54. Hardcoded Values

**Priority:** P1

### Problem

Magic values and configuration are hardcoded.

### Required fix

Centralize configuration and constants.

No production endpoint should contain hardcoded environment-specific IPs, URLs, secrets or paths.

---

## 55. Documentation

**Priority:** P2

### Problem

Documentation contradicts actual implementation.

### Required fix

Update:

- README;
- architecture documentation;
- environment setup;
- API documentation;
- deployment instructions;
- privacy/data-flow documentation.

Documentation must describe what the application actually does.

---

## 56. Accessibility

**Priority:** P2

### Problem

Frontend accessibility issues exist.

### Required fix

Review:

- keyboard navigation;
- semantic labels;
- focus states;
- contrast;
- screen-reader support;
- form errors;
- interactive controls.

---

## 57. Frontend Architecture

**Priority:** P2

### Problem

Main pages/components are overly monolithic.

### Required fix

Separate:

- presentation;
- API/data fetching;
- state management;
- authentication;
- RAG query logic;
- visualization;
- voice functionality.

Use reusable hooks/services/components.

---

## 58. Production Configuration Validation

**Priority:** P1

### Problem

Required environment variables are not reliably validated.

### Required fix

Fail fast at startup if required configuration is missing or unsafe.

Validate:

- database URL;
- JWT secret;
- provider credentials;
- Pinecone configuration;
- CORS origins;
- upload limits;
- environment mode.

---

# 4. REQUIRED SECURITY TEST MATRIX

The AI agent must create tests for at least the following:

| Test | Expected Result |
|---|---|
| No authentication token | 401 |
| Invalid JWT | 401 |
| Expired JWT | 401 |
| Unknown JWT subject | 401 |
| User A reads Family A | Allowed |
| User A reads Family B | Denied |
| User A modifies Family B | Denied |
| User A deletes Family B document | Denied |
| Member accesses admin endpoint | 403 |
| Read-only adviser uploads | 403 |
| Read-only adviser deletes | 403 |
| Client changes `family_entity_id` | Denied |
| Client changes document ID | Denied |
| Client changes user ID | Denied |
| Upload oversized file | Rejected |
| Unsupported file type | Rejected |
| Malformed provider response | Safe error |
| LLM timeout | 502/503 or safe failure |
| Pinecone failure | Safe failure |
| Duplicate upload | Idempotent/rejected |
| Concurrent registration | No duplicate account |
| Sensitive data in logs | Must not appear |
| Prompt injection document | Treated as untrusted data |
| Fake citation attempt | Must not be accepted |
| Currency mismatch | Must be detected/preserved |

---

# 5. RAG CORRECTNESS REQUIREMENTS

Every RAG response should follow:

```text
Authenticate user
    |
Resolve authorized family/entity
    |
Resolve document ACL
    |
Retrieve only authorized vectors
    |
Retrieve source metadata
    |
Validate evidence
    |
Build grounded prompt
    |
Call LLM
    |
Validate response
    |
Attach real citations
    |
Return safe answer
```

The frontend must never invent:

- documents;
- citations;
- verification;
- financial figures;
- source pages;
- QR verification;
- currency.

---

# 6. DEFINITION OF DONE

The application should not be considered ready merely because it builds.

A remediation item is complete only when:

1. The actual source code was inspected.
2. The root cause was identified.
3. The implementation was corrected.
4. Relevant tests were added/updated.
5. Tests pass.
6. Security implications were reviewed.
7. Existing functionality was regression-tested.
8. Configuration/documentation was updated where necessary.
9. No fake/demo data remains in production paths.
10. The AI agent reports the exact files changed.

---

# 7. REQUIRED AI AGENT WORKFLOW

The AI agent should execute this workflow:

## Phase 1 — Repository Recon

- Inspect all files.
- Map architecture.
- Map API endpoints.
- Map authentication.
- Map database/vector access.
- Map external services.
- Map configuration.
- Map tests.
- Produce baseline findings.

## Phase 2 — P0 Security

Fix:

- Authentication
- Tenant isolation
- Authorization/RBAC
- Admin escalation
- Document ACL
- API authorization
- Production secrets
- Prompt injection/data poisoning

## Phase 3 — Privacy and Financial Correctness

Fix:

- Privacy claims
- Cloud data flows
- Fake evidence
- Fake verification
- Currency handling
- LLM failure handling
- Chain-of-thought exposure

## Phase 4 — Data and API Security

Fix:

- Upload security
- File validation
- Rate limiting
- Pagination
- Error handling
- Sensitive logging
- External provider validation

## Phase 5 — Database and RAG Architecture

Fix:

- PostgreSQL system of record
- Pinecone vector architecture
- Document ACLs
- Chunking
- Metadata
- Ingestion pipeline
- Idempotency
- Orphan cleanup

## Phase 6 — Reliability and Performance

Fix:

- Blocking async operations
- Background jobs
- Provider timeouts
- Retries
- Duplicate races
- Frontend memory leaks
- Mobile lifecycle issues

## Phase 7 — Testing

Implement:

- Unit tests
- Integration tests
- Security tests
- Tenant-isolation tests
- RAG tests
- Upload tests
- Failure-mode tests
- Concurrency tests

## Phase 8 — Observability and Deployment

Implement:

- Logging
- Metrics
- Tracing
- Audit trail
- Health checks
- Docker
- CI/CD
- TLS
- Secret management
- Backups
- Restore testing

## Phase 9 — Final Audit

Re-run the entire 58-item checklist.

For every issue report:

```text
ID:
Status:
Files changed:
Root cause:
Fix:
Tests:
Evidence:
Remaining risk:
```

Allowed statuses:

- OPEN
- IN PROGRESS
- FIXED
- VERIFIED
- BLOCKED
- NOT APPLICABLE

Do not mark an issue VERIFIED without evidence.

---

# 8. FINAL AI AGENT REPORT FORMAT

At the end, produce:

## Executive Summary

- Original readiness score
- New readiness assessment
- Remaining P0 issues
- Remaining P1 issues
- Security status

## Changed Files

| File | Change | Reason |
|---|---|---|

## Issue Status

| ID | Priority | Status | Files | Tests | Notes |
|---|---|---|---|---|---|

## Security Test Results

| Test | Result |
|---|---|

## Remaining Risks

List every unresolved issue.

## Deployment Recommendation

Choose exactly one:

- DO NOT DEPLOY
- READY FOR STAGING
- READY FOR SECURITY REVIEW
- READY FOR PRODUCTION

The agent must justify the decision.

---

# 9. IMPORTANT FINAL INSTRUCTION TO THE AI AGENT

Do not simply make superficial edits to satisfy this document.

Inspect the real application.

Find the actual root causes.

Fix the architecture where necessary.

Do not create fake tests that only test mocks while the real security boundary remains broken.

Do not claim tenant isolation unless there are tests proving cross-tenant access is denied.

Do not claim privacy unless the actual data flows match the documented privacy model.

Do not claim financial grounding unless citations point to real authorized source documents.

Do not claim production readiness until the critical security, correctness, testing and deployment requirements have been verified.

**Treat financial data as highly sensitive. Fail closed whenever authorization, evidence, identity or tenant scope cannot be established.**
