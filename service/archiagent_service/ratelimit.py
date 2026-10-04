"""Request rate limiting, in Redis.

Caddy would need a third-party module and therefore a custom image, and the
limit worth having is per-API-key — which only the application knows. Redis is
already in the stack for the job queue, so this costs no new infrastructure.

A fixed window, not a token bucket: it is three Redis commands, it is obvious
what it does under inspection, and the worst case is that a caller gets up to
2x the limit across a window boundary. For abuse control that is fine; for
anything finer the right answer is a quota, not a smaller window.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from redis import Redis


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    remaining: int
    retry_after_s: int


def client_bucket(authorization: str | None, client_ip: str) -> str:
    """Which budget this request spends from.

    Authenticated callers are bucketed by their key, so two tenants behind one
    NAT do not share a budget and one tenant cannot get a fresh budget by
    changing IP. Only a hash prefix goes in the key: Redis key names appear in
    logs, SLOWLOG and MONITOR output, and a bearer token must not.

    Everything else is bucketed by IP, which is what limits key guessing.
    """
    if authorization and authorization.strip():
        digest = hashlib.sha256(authorization.strip().encode()).hexdigest()
        return f"key:{digest[:32]}"
    return f"ip:{client_ip}"


class RateLimiter:
    def __init__(self, redis: Redis, *, limit: int, window_s: int, prefix: str = "ratelimit"):
        self._redis = redis
        self._limit = limit
        self._window_s = window_s
        self._prefix = prefix

    def check(self, bucket: str) -> Verdict:
        """Counts this request and says whether to serve it."""
        key = f"{self._prefix}:{bucket}"
        pipe = self._redis.pipeline()
        pipe.incr(key)
        # Only set the TTL on the first request of a window; refreshing it on
        # every request would make a steady stream of traffic immortal and the
        # window would never roll over.
        pipe.ttl(key)
        count, ttl = pipe.execute()

        if ttl is None or ttl < 0:
            self._redis.expire(key, self._window_s)
            ttl = self._window_s

        if count > self._limit:
            return Verdict(allowed=False, remaining=0, retry_after_s=max(int(ttl), 1))
        return Verdict(allowed=True, remaining=self._limit - int(count), retry_after_s=0)
