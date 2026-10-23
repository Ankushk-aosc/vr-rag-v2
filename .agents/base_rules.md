# Base Permanent Development Rules

## 1. Git Safety
- NEVER execute `git push` without explicit user permission.
- Always review working tree diffs before proposing commits.
- Never discard uncommitted work.

## 2. Code Organization & Modularity ("No Code Cramming")
- Individual files and pages MUST NOT exceed 500–600 lines.
- Dedicated files for functions, complex utilities, and feature components.
- Separate frontend, backend API, business logic, data access, and integrations.

## 3. Production-Ready Code & Real Data
- No mock data, fake metrics, or fabricated API responses in production paths.
- In-memory test fixtures are strictly confined to `tests/` directories.
- Always use real data models with proper types and validation schemas (Pydantic / Zod).

## 4. Security & Privacy
- Never hardcode API keys, secrets, private keys, or credentials.
- All secrets loaded from environment variables (`.env`).
- Validate all user input and file uploads on the server side.
- Enforce pre-retrieval access control before vector queries.

## 5. Dual-Layer Explanations
- Always provide both Simple Explanation (plain English) and Technical Explanation (precise data flows & mechanics) for architectural changes and problem resolutions.
