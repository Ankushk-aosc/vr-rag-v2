# Australian Financial Domain & Regulatory Rules

## 1. Regulatory Jurisdiction: Australia (Cth)
- Legal framework: Privacy Act 1988 (Cth) and Australian Privacy Principles (APPs).
- ASIC RG 244: System must enforce prominent disclaimers that responses are factual information extracted from authorized documents and do not constitute personal financial product advice.
- Financial Year Boundary: 1 July to 30 June.
- Currency: Australian Dollar (AUD, $). Formatting: `$1,234.56 AUD`.

## 2. Privacy-Safe Cloud Vector Architecture
- Under APP 8 (Cross-Border Disclosure), raw financial texts (tax returns, account numbers, names, BSBs) must NOT be stored in cloud vector metadata.
- Pinecone vector index stores ONLY anonymized vector embeddings and chunk ID references.
- Raw document text, tables, user accounts, and family entity relations remain strictly local in SQLite (`data/app.db`).

## 3. Read-Only Safety Boundary
- The application is strictly read-only.
- No write-capable tools, banking transactional APIs, or account modification capabilities are permitted.
- Factual grounding: If a user asks a question whose answer is not verified by uploaded documents, the system must explicitly state: "Unable to verify from authorized documents." Never guess or fabricate answers.

## 4. Supported Australian Document Types
- ATO (Australian Taxation Office) Notices of Assessment, Individual Tax Returns, PAYG Summaries, BAS.
- Superannuation Statements (APRA-regulated & SMSF annual reports).
- Australian 4-Pillar Bank Statements (CBA, Westpac, ANZ, NAB, Macquarie) with BSB validation.
- Share Registry Statements (CHESS holding statements & dividend statements).
