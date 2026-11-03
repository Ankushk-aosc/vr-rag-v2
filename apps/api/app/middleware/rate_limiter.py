"""
In-Memory Sliding Window Rate Limiter.
Resolves Audit ID: S8.

Enforces per-client request limits across sensitive authentication, LLM, and voice endpoints.
"""
import time
import threading
from collections import defaultdict
from typing import Dict, List, Optional
import jwt
from fastapi import HTTPException, Request, status

from app.config import settings
from app.services.auth import ALGORITHM


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


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _verified_subject(auth_header: Optional[str]) -> Optional[str]:
    """Returns the user id of a validly signed bearer token, else None (Audit I-03)."""
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    try:
        payload = jwt.decode(auth_header[7:].strip(), settings.APP_SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    return str(sub) if sub else None


def rate_limit(max_requests: int = 60, window_seconds: int = 60, per: str = "user"):
    """
    FastAPI Dependency to rate-limit endpoints.

    per="user": keyed by the verified token subject, falling back to client IP for missing,
                forged or expired tokens (so rotating fake tokens cannot mint fresh buckets).
    per="ip":   keyed by client IP only; used for unauthenticated routes such as login/register,
                where any Authorization header is attacker-controlled.
    """
    if per not in ("user", "ip"):
        raise ValueError(f"Unknown rate limit scope '{per}'")

    async def dependency(request: Request):
        subject = _verified_subject(request.headers.get("Authorization")) if per == "user" else None
        client_id = f"user:{subject}" if subject else f"ip:{_client_ip(request)}"

        route_path = request.url.path
        rate_key = f"{client_id}:{route_path}"
        limiter.check(rate_key, max_requests=max_requests, window_seconds=window_seconds)

    return dependency

