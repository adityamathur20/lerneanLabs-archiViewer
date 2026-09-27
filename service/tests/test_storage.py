import uuid

import pytest


@pytest.fixture
def prefix():
    return f"test-{uuid.uuid4().hex[:8]}"


def test_put_then_get_round_trips(s3, prefix):
    s3.put(f"{prefix}/hello.txt", b"hello")
    assert s3.get(f"{prefix}/hello.txt") == b"hello"


def test_exists_is_false_for_a_missing_key(s3, prefix):
    assert s3.exists(f"{prefix}/nope.txt") is False


def test_presigned_get_url_serves_the_object(s3, prefix):
    """The API must never proxy artifact bytes (spec §7.3); a 400 MB IFC has to
    go straight from object storage to the client."""
    import urllib.request

    s3.put(f"{prefix}/plan.ifc", b"ISO-10303-21;")
    url = s3.presign_get(f"{prefix}/plan.ifc")
    with urllib.request.urlopen(url) as response:
        assert response.read() == b"ISO-10303-21;"


def test_list_prefix_returns_only_that_prefix(s3, prefix):
    s3.put(f"{prefix}/a.txt", b"a")
    s3.put(f"{prefix}/b.txt", b"b")
    s3.put(f"other-{prefix}/c.txt", b"c")
    assert sorted(s3.list_prefix(f"{prefix}/")) == [f"{prefix}/a.txt", f"{prefix}/b.txt"]


def test_delete_prefix_removes_the_whole_job(s3, prefix):
    s3.put(f"{prefix}/a.txt", b"a")
    s3.put(f"{prefix}/b.txt", b"b")
    assert s3.delete_prefix(f"{prefix}/") == 2
    assert s3.list_prefix(f"{prefix}/") == []
