"""Garage publishes no healthcheck, so the client waits instead (spec §4.2)."""
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from archiagent_service.storage import ObjectStore


def _store() -> ObjectStore:
    return ObjectStore(endpoint="http://127.0.0.1:1", bucket="b", access_key="k", secret_key="s")


def test_wait_ready_returns_once_the_store_answers(monkeypatch):
    store = _store()
    calls = {"n": 0}

    def head_bucket(**_):
        calls["n"] += 1
        if calls["n"] < 3:
            raise EndpointConnectionError(endpoint_url="http://127.0.0.1:1")
        return {}

    monkeypatch.setattr(store._client, "head_bucket", head_bucket)
    store.wait_ready(attempts=5, delay=0)
    assert calls["n"] == 3


def test_wait_ready_gives_up_loudly(monkeypatch):
    store = _store()

    def head_bucket(**_):
        raise EndpointConnectionError(endpoint_url="http://127.0.0.1:1")

    monkeypatch.setattr(store._client, "head_bucket", head_bucket)
    with pytest.raises(RuntimeError, match="not reachable"):
        store.wait_ready(attempts=2, delay=0)


def test_wait_ready_accepts_a_missing_bucket_as_reachable(monkeypatch):
    """A 404 proves the store is answering. Creating the bucket is provisioning's
    job, not the application's — a service that creates its own bucket can also
    create the wrong one after a typo'd endpoint and look healthy."""
    store = _store()

    def head_bucket(**_):
        raise ClientError({"Error": {"Code": "404"}}, "HeadBucket")

    monkeypatch.setattr(store._client, "head_bucket", head_bucket)
    store.wait_ready(attempts=1, delay=0)
