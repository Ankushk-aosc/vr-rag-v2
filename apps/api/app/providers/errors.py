"""
Provider Exception Hierarchy.
Ensures network and provider errors wrap details safely without exposing API keys or secrets.
"""

class ProviderError(Exception):
    """Base exception for all provider errors."""
    pass


class ProviderNotConfigured(ProviderError):
    """Raised when a requested provider is missing required configuration or keys."""
    pass


class ProviderCallError(ProviderError):
    """Raised when a remote provider call fails (HTTP 4xx/5xx, timeouts, network issues)."""
    pass
