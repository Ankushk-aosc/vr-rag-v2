"""
In-Memory Sliding Window Rate Limiter.
Resolves Audit ID: S8.

Enforces per-client request limits across sensitive authentication, LLM, and voice endpoints.
"""
import time
import threading
from collections import defaultdict
from typing import Dict, List, Optional
from fastapi import HTTPException, Request, status


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # key -> list of request timestamps (epoch floats)
        self._requests: Dict[str, List[float]] = defaultdict(list)
        self._last_cleanup = time.time()

    def _cleanup_stale(self, now: float, max_window: float = 300.0) -> None:
        """Periodically prune expired timestamps to prevent unbounded memory growth."""
        if now - self._last_cleanup < 60.0:
            return
        self._last_cleanup = now
        stale_cutoff = now - max_window
        keys_to_remove = []
        for key, timestamps in self._requests.items():
            self._requests[key] = [t for t in timestamps if t > stale_cutoff]
            if not self._requests[key]:
                keys_to_remove.append(key)
        for key in keys_to_remove:
            self._requests.pop(key, None)

    def check(
        self,
        key: str,
        max_requests: int,
        window_seconds: int = 60
    ) -> None:
        now = time.time()
        with self._lock:
            self._cleanup_stale(now, float(window_seconds))
            timestamps = self._requests[key]
            window_cutoff = now - window_seconds
            # Keep only timestamps within the current window
            valid_timestamps = [t for t in timestamps if t > window_cutoff]
            self._requests[key] = valid_timestamps

            if len(valid_timestamps) >= max_requests:
                oldest_in_window = valid_timestamps[0]
                retry_after = max(1, int(oldest_in_window + window_seconds - now))
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"Rate limit exceeded. Allowed: {max_requests} per {window_seconds}s.",
                    headers={"Retry-After": str(retry_after)}
                )

            self._requests[key].append(now)

    def reset(self) -> None:
        """Reset all rate limiter state (useful for test runs)."""
        with self._lock:
            self._requests.clear()


limiter = SlidingWindowRateLimiter()


def rate_limit(max_requests: int = 60, window_seconds: int = 60):
    """
    FastAPI Dependency to rate-limit endpoints.
    Keyed by client IP or Authorization bearer token.
    """
    async def dependency(request: Request):
        # Derive client identity
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            # Use token prefix as client identifier for authenticated users
            client_id = f"token:{auth_header[:32]}"
        else:
            client_ip = request.client.host if request.client else "unknown"
            client_id = f"ip:{client_ip}"

        route_path = request.url.path
        rate_key = f"{client_id}:{route_path}"
        limiter.check(rate_key, max_requests=max_requests, window_seconds=window_seconds)

    return dependency

