import pytest
from fastapi import HTTPException

from archiagent_service.uploads import ALLOWED_SUFFIXES, validate_upload

MAX = 200 * 1024 * 1024


def test_accepts_the_formats_this_service_can_process_today():
    """DWG is admitted again in Phase 4: Tier 1 converts it with the ODA File
    Converter before the pipeline sees it."""
    assert ALLOWED_SUFFIXES == {".dxf", ".dwg", ".pdf"}
    assert validate_upload("plan.dxf", 1000, MAX) == ".dxf"
    assert validate_upload("PLAN.DXF", 1000, MAX) == ".dxf"


# Review Focus #3
def test_rejects_a_format_the_pipeline_cannot_read():
    with pytest.raises(HTTPException) as caught:
        validate_upload("plan.rvt", 1000, MAX)
    assert caught.value.status_code == 400


def test_rejects_an_oversized_upload_before_anything_is_queued():
    with pytest.raises(HTTPException) as caught:
        validate_upload("plan.dxf", MAX + 1, MAX)
    assert caught.value.status_code == 413


def test_rejects_a_path_disguised_as_a_filename():
    # The filename becomes part of an S3 key; a traversal here would write
    # outside the tenant's prefix.
    with pytest.raises(HTTPException):
        validate_upload("../../etc/passwd.dxf", 1000, MAX)


def test_rejects_a_windows_path_too():
    with pytest.raises(HTTPException):
        validate_upload(r"C:\\plans\\plan.dxf", 1000, MAX)


def test_rejects_an_empty_upload():
    with pytest.raises(HTTPException) as caught:
        validate_upload("plan.dxf", 0, MAX)
    assert caught.value.status_code == 400


def test_rejects_a_file_with_no_extension():
    with pytest.raises(HTTPException) as caught:
        validate_upload("plan", 1000, MAX)
    assert caught.value.status_code == 400
