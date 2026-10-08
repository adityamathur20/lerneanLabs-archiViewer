"""StartRequest validation. Pure pydantic: no database, so it always runs."""
import pytest
from pydantic import ValidationError

from archiagent_service.api import StartRequest


def test_units_per_foot_is_refused_by_name_with_the_replacement():
    with pytest.raises(ValidationError) as caught:
        StartRequest(units_per_foot=12)
    message = str(caught.value)
    assert "units_per_foot is no longer accepted" in message
    assert "trust_extracted_scale" in message and "scale_from_wall" in message


def test_a_null_units_per_foot_is_harmless_and_never_stored():
    """The viewer used to send null for an empty field."""
    assert StartRequest(units_per_foot=None).model_dump(exclude_none=True) == {}


def test_scale_options_are_stored_as_the_worker_reads_them():
    body = StartRequest(
        trust_extracted_scale=True,
        scale_from_wall=[{"x1": 0, "y1": 0, "x2": 120, "y2": 0, "length": "10ft"}],
    )
    assert body.model_dump(exclude_none=True) == {
        "trust_extracted_scale": True,
        "scale_from_wall": [{"x1": 0.0, "y1": 0.0, "x2": 120.0, "y2": 0.0, "length": "10ft"}],
    }


@pytest.mark.parametrize("length", ["--rules", "-10", "", "ten feet", "1" * 33, "10", "12.5"])
def test_a_wall_length_that_could_become_a_flag_or_junk_is_refused(length):
    with pytest.raises(ValidationError):
        StartRequest(scale_from_wall=[{"x1": 0, "y1": 0, "x2": 1, "y2": 0, "length": length}])


@pytest.mark.parametrize("length", ["10ft", "10'-6\"", "3.05m", "3050mm", "120in", "10' 6\"", "10'-6½\"", "10'-6 1/2\""])
def test_every_length_format_archiagent_documents_is_accepted(length):
    StartRequest(scale_from_wall=[{"x1": 0, "y1": 0, "x2": 1, "y2": 0, "length": length}])


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_non_finite_coordinates_are_refused(bad):
    with pytest.raises(ValidationError):
        StartRequest(scale_from_wall=[{"x1": bad, "y1": 0, "x2": 1, "y2": 0, "length": "10"}])


def test_unknown_wall_fields_and_too_many_walls_are_refused():
    with pytest.raises(ValidationError):
        StartRequest(scale_from_wall=[{"x1": 0, "y1": 0, "x2": 1, "y2": 0, "length": "1", "z": 0}])
    wall = {"x1": 0, "y1": 0, "x2": 1, "y2": 0, "length": "1"}
    with pytest.raises(ValidationError):
        StartRequest(scale_from_wall=[wall] * 9)
