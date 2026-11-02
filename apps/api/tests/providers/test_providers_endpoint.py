import json
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
from app.services import auth

client = TestClient(app)


def test_providers_endpoint_anonymous_denied():
    res = client.get("/api/providers")
    assert res.status_code == 401


def test_providers_endpoint_member_denied():
    mock_member = {
        "id": "member_user_id",
        "email": "member@sterlingfamily.com.au",
        "memberships": [{"family_entity_id": "fam_alpha", "role": "family_member"}]
    }
    token = auth.create_access_token({"sub": "member_user_id", "email": "member@sterlingfamily.com.au"})
    headers = {"Authorization": f"Bearer {token}"}

    with patch("app.services.auth.get_current_user_optional", return_value=mock_member):
        res = client.get("/api/providers", headers=headers)
        assert res.status_code == 403
        assert "Access denied" in res.json()["detail"]


def test_providers_endpoint_admin_authorized_no_secrets():
    mock_admin = {
        "id": "admin_user_id",
        "email": "admin@sterlingfamily.com.au",
        "memberships": [{"family_entity_id": "fam_alpha", "role": "family_admin"}]
    }
    token = auth.create_access_token({"sub": "admin_user_id", "email": "admin@sterlingfamily.com.au"})
    headers = {"Authorization": f"Bearer {token}"}

    # Set dummy secret to verify it is NEVER leaked in response
    dummy_secret = "super_classified_groq_key_9999"

    with patch("app.services.auth.get_current_user_optional", return_value=mock_admin), \
         patch("app.config.settings.GROQ_API_KEY", dummy_secret), \
         patch("app.config.settings.LLM_API_KEY", dummy_secret):

        res = client.get("/api/providers", headers=headers)
        assert res.status_code == 200
        data = res.json()

        # Check required structure
        assert "llm" in data
        assert "embedder" in data
        assert "vector_store" in data
        assert "stt" in data
        assert "tts" in data

        # CRITICAL SECURITY CHECK: No secret values anywhere in serialized response body
        raw_text = json.dumps(data)
        assert dummy_secret not in raw_text
        assert "api_key" not in raw_text.lower()
        assert "secret" not in raw_text.lower()
