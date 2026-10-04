"""Rate limiting, in Redis, because the API is on the public internet.

Caddy cannot do this without a third-party module and a custom image, and the
limit worth having is per-API-key — which only the application knows.
"""
import pytest
from redis import Redis

from archiagent_service.config import get_settings
from archiagent_service.ratelimit import RateLimiter, client_bucket


@pytest.fixture
def redis_client():
    settings = get_settings()
    client = Redis.from_url(settings.redis_url)
    try:
        client.ping()
    except Exception:
        pytest.skip("redis not reachable — run `docker compose up -d` in service/")
    for key in client.scan_iter("ratelimit:test:*"):
        client.delete(key)
    return client


def test_requests_under_the_limit_are_allowed(redis_client):
    limiter = RateLimiter(redis_client, limit=3, window_s=60, prefix="ratelimit:test")
    assert [limiter.check("alice").allowed for _ in range(3)] == [True, True, True]


def test_the_request_over_the_limit_is_refused(redis_client):
    limiter = RateLimiter(redis_client, limit=2, window_s=60, prefix="ratelimit:test")
    limiter.check("bob")
    limiter.check("bob")
    verdict = limiter.check("bob")
    assert verdict.allowed is False
    assert verdict.retry_after_s > 0


def test_buckets_are_independent(redis_client):
    limiter = RateLimiter(redis_client, limit=1, window_s=60, prefix="ratelimit:test")
    assert limiter.check("carol").allowed is True
    assert limiter.check("carol").allowed is False
    # A different caller must not inherit carol's exhausted bucket.
    assert limiter.check("dave").allowed is True


def test_the_window_expires(redis_client):
    limiter = RateLimiter(redis_client, limit=1, window_s=1, prefix="ratelimit:test")
    assert limiter.check("erin").allowed is True
    assert limiter.check("erin").allowed is False
    import time

    time.sleep(1.2)
    assert limiter.check("erin").allowed is True, "the window must expire, not latch"


def test_an_authenticated_caller_is_bucketed_by_key_not_by_ip():
    """Two tenants behind one NAT must not share a budget, and one tenant
    rotating IPs must not get a fresh budget each time."""
    assert client_bucket("Bearer ak_one", "1.2.3.4") == client_bucket("Bearer ak_one", "9.9.9.9")
    assert client_bucket("Bearer ak_one", "1.2.3.4") != client_bucket("Bearer ak_two", "1.2.3.4")


def test_the_bucket_never_contains_the_raw_key():
    """Redis keys show up in logs, SLOWLOG and MONITOR output."""
    bucket = client_bucket("Bearer ak_supersecret", "1.2.3.4")
    assert "ak_supersecret" not in bucket


def test_an_unauthenticated_caller_is_bucketed_by_ip():
    # This is the bucket that limits key guessing.
    assert client_bucket(None, "1.2.3.4") == client_bucket("", "1.2.3.4")
    assert client_bucket(None, "1.2.3.4") != client_bucket(None, "5.6.7.8")


# --- wired into the app ------------------------------------------------------

import pytest
from fastapi.testclient import TestClient

from archiagent_service import auth
from archiagent_service.api import create_app


@pytest.fixture
def limited_client(pg_session, monkeypatch, redis_client):
    monkeypatch.setenv("ARCHIAGENT_SERVICE_RATE_LIMIT_PER_MINUTE", "3")
    monkeypatch.setenv("ARCHIAGENT_SERVICE_RATE_LIMIT_ANON_PER_MINUTE", "2")
    get_settings.cache_clear()
    for key in redis_client.scan_iter("ratelimit:*"):
        redis_client.delete(key)
    app = create_app()
    app.dependency_overrides[auth.db_session] = lambda: pg_session
    yield TestClient(app)
    get_settings.cache_clear()


def test_an_unauthenticated_flood_is_refused_with_429(limited_client):
    # This is the bucket that stops anonymous key guessing.
    codes = [limited_client.get("/v1/jobs").status_code for _ in range(4)]
    assert codes[:2] == [401, 401], codes
    assert codes[-1] == 429, codes


def test_a_429_tells_the_caller_when_to_come_back(limited_client):
    for _ in range(3):
        limited_client.get("/v1/jobs")
    response = limited_client.get("/v1/jobs")
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) > 0


def test_healthz_is_never_rate_limited(limited_client):
    # An uptime check must not be able to lock itself out.
    assert [limited_client.get("/healthz").status_code for _ in range(8)] == [200] * 8


def test_a_preflight_is_never_rate_limited(limited_client):
    """A 429 on an OPTIONS request carries no CORS headers, so the browser
    reports a CORS failure and the viewer breaks in a way nothing explains."""
    for _ in range(6):
        response = limited_client.options(
            "/v1/jobs",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        assert response.status_code != 429, "preflight must bypass the limiter"
