import re
from pathlib import Path
import pytest
from app.services.voice import STT_VOCAB_PROMPT
from app.routers.documents import get_document_suggestions

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_voice_prompt_sanitized_against_aapl():
    """U5: Ensure Whisper STT vocab prompt does not contain hardcoded AAPL and features AU financial terms."""
    assert "AAPL" not in STT_VOCAB_PROMPT
    assert "Apple" not in STT_VOCAB_PROMPT
    assert "ASX" in STT_VOCAB_PROMPT
    assert "Australian equities" in STT_VOCAB_PROMPT
    assert "superannuation" in STT_VOCAB_PROMPT
    assert "franking credits" in STT_VOCAB_PROMPT


from unittest.mock import patch

@pytest.mark.asyncio
async def test_document_suggestions_no_aapl_coupling():
    """U5: Ensure suggestions are dynamically derived rather than hardcoded to Apple."""
    docs = [
        {
            "original_name": "Family_Trust_Portfolio_2024.pdf",
            "columns": [],
        }
    ]
    user = {"id": "usr_1", "memberships": [{"family_entity_id": "fam_1"}]}
    with patch("app.routers.documents.pinecone_service.list_documents_from_pinecone", return_value=docs):
        suggestions = await get_document_suggestions(family_entity_id="fam_1", current_user=user)
    assert not any("AAPL" in s for s in suggestions)
    assert any("portfolio" in s.lower() or "family" in s.lower() for s in suggestions)


def test_spatial_docs_purged_from_frontend():
    """U4: Ensure DEFAULT_SPATIAL_DOCS mock data is purged from docTextureHelper and SpatialWorld."""
    doc_texture_file = REPO_ROOT / "apps" / "web" / "src" / "components" / "docTextureHelper.ts"
    spatial_world_file = REPO_ROOT / "apps" / "web" / "src" / "lib" / "spatial" / "SpatialWorld.ts"

    assert doc_texture_file.exists()
    assert spatial_world_file.exists()

    doc_texture_src = doc_texture_file.read_text(encoding="utf-8")
    spatial_world_src = spatial_world_file.read_text(encoding="utf-8")

    assert "DEFAULT_SPATIAL_DOCS" not in doc_texture_src
    assert "DEFAULT_SPATIAL_DOCS" not in spatial_world_src
    assert "AAPL Financial Ledger" not in doc_texture_src


def test_mobile_api_dynamic_host():
    """U3: Ensure mobile API client does not bake in developer LAN IP."""
    api_file = REPO_ROOT / "apps" / "mobile" / "src" / "services" / "api.ts"
    assert api_file.exists()

    api_src = api_file.read_text(encoding="utf-8")
    assert "192.168.1.127" not in api_src
    assert "EXPO_PUBLIC_API_URL" in api_src

    # Also verify expo_qr is gitignored
    gitignore = (REPO_ROOT / "apps" / "mobile" / ".gitignore").read_text(encoding="utf-8")
    assert "expo_qr" in gitignore


def test_markdown_protocol_hardening():
    """U2: Ensure Markdown component validates URL protocol and adds noopener."""
    markdown_file = REPO_ROOT / "apps" / "web" / "src" / "components" / "Markdown.tsx"
    assert markdown_file.exists()

    md_src = markdown_file.read_text(encoding="utf-8")
    assert "https://" in md_src
    assert "noopener noreferrer" in md_src


def test_documentation_discloses_app8():
    """D1, D2, P1: Ensure README and runbook disclose cloud data flows and APP 8 compliance."""
    readme_src = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    runbook_src = (REPO_ROOT / "docs" / "runbook.md").read_text(encoding="utf-8")

    assert "Pinecone" in readme_src
    assert "APP 8" in readme_src or "Australian Privacy Principles" in readme_src
    assert "us-east-1" in readme_src
    assert "Groq" in readme_src

    assert "APP 8" in runbook_src
    assert "us-east-1" in runbook_src
    assert "Groq" in runbook_src
