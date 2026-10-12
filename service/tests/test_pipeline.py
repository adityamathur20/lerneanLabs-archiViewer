from pathlib import Path

from archiagent_service.pipeline import build_command, collect_artifacts


def test_command_shells_out_and_never_imports_archiagent():
    """Spec §5.2 and this plan's Global Constraints: the service runs the CLI
    in a subprocess so a crash, an LLM timeout or ifcopenshell's memory growth
    cannot take the API process with it."""
    command = build_command(
        Path("/venv/bin/python"),
        Path("/work/source.dxf"),
        Path("/work"),
        {"trust_extracted_scale": True, "height_ft": 10.0, "walls": ["WALLS"]},
    )

    assert command[:3] == ["/venv/bin/python", "-m", "archiagent"]
    assert "--dxfFilePath" in command and "/work/source.dxf" in command
    assert "--outputDir" in command and "/work" in command
    assert "--trust-extracted-scale" in command
    assert command[command.index("--height") + 1] == "10.0"
    assert command[command.index("--walls") + 1] == "WALLS"


def test_command_omits_flags_that_were_not_requested():
    command = build_command(Path("/p"), Path("/w/s.dxf"), Path("/w"), {})
    assert "--trust-extracted-scale" not in command
    assert "--scale-from-wall" not in command
    assert "--walls" not in command
    assert "--height" not in command


def test_a_pdf_source_uses_the_pdf_flag():
    """archiagent takes exactly one of --dxfFilePath / --pdfFilePath."""
    command = build_command(Path("/p"), Path("/w/s.pdf"), Path("/w"), {})
    assert "--pdfFilePath" in command
    assert "--dxfFilePath" not in command


def test_a_dwg_source_uses_the_dwg_flag():
    """Phase 4: the CLI converts DWG itself, so the service only says which
    flag to use — it never shells out to ODA a second time."""
    command = build_command(Path("/p"), Path("/w/plan.dwg"), Path("/w"), {})
    assert "--dwgFilePath" in command
    assert "--dxfFilePath" not in command


def test_collect_artifacts_finds_what_the_pipeline_wrote(tmp_path):
    (tmp_path / "source.ifc").write_bytes(b"ISO-10303-21;")
    (tmp_path / "source.interpretation.json").write_text("{}")
    (tmp_path / "source.report.json").write_text("{}")
    (tmp_path / "source.overlay.svg").write_text("<svg/>")
    (tmp_path / "scratch.log").write_text("noise")

    names = sorted(p.name for p in collect_artifacts(tmp_path))
    assert names == [
        "source.ifc",
        "source.interpretation.json",
        "source.overlay.svg",
        "source.report.json",
    ]
    assert "scratch.log" not in names


def test_collect_artifacts_never_returns_the_source_itself(tmp_path):
    """The source is already in object storage under its own key; re-uploading
    it as an artifact would double-charge the tenant's storage."""
    (tmp_path / "source.dxf").write_text("0\nSECTION\n")
    (tmp_path / "source.ifc").write_bytes(b"ISO-10303-21;")
    assert [p.name for p in collect_artifacts(tmp_path)] == ["source.ifc"]


def test_an_asserted_wall_becomes_five_scale_from_wall_arguments():
    command = build_command(Path("/p"), Path("/w/s.dxf"), Path("/w"), {"scale_from_wall": [
        {"x1": 0.0, "y1": 0.0, "x2": 120.0, "y2": 0.0, "length": "10'-6\""},
        {"x1": -5.5, "y1": 2.0, "x2": -5.5, "y2": 98.0, "length": "8ft"},
    ]})
    first = command.index("--scale-from-wall")
    assert command[first + 1:first + 6] == ["0.0", "0.0", "120.0", "0.0", "10'-6\""]
    second = command.index("--scale-from-wall", first + 1)
    assert command[second + 1:second + 6] == ["-5.5", "2.0", "-5.5", "98.0", "8ft"]


def test_a_stored_units_per_foot_is_never_forwarded():
    """archiAgent removed --units-per-foot and exits 3 (bad usage) on it. Jobs
    queued before this change may still carry the option."""
    command = build_command(Path("/p"), Path("/w/s.dxf"), Path("/w"), {"units_per_foot": 12})
    assert "--units-per-foot" not in command


# --- declared wall thickness -------------------------------------------------

def test_a_declared_thickness_set_becomes_plain_decimal_arguments():
    command = build_command(Path("/p"), Path("/w/s.dxf"), Path("/w"),
                            {"wall_thickness_in": [4.5, 9.0], "wall_thickness_exhaustive": True})
    at = command.index("--wall-thickness")
    assert command[at + 1:at + 3] == ["4.5", "9.0"]
    assert "--wall-thickness-exhaustive" in command


def test_no_thickness_option_adds_no_thickness_argument():
    command = build_command(Path("/p"), Path("/w/s.dxf"), Path("/w"), {"wall_thickness_exhaustive": False})
    assert not [a for a in command if a.startswith("--wall-thickness")]


def test_a_thickness_value_is_never_written_in_exponent_form():
    # str(1e-05) is "1e-05"; argparse type=float would read it, but "1e-05" next
    # to a flag-looking string is exactly the ambiguity plain decimals avoid.
    command = build_command(Path("/p"), Path("/w/s.dxf"), Path("/w"), {"wall_thickness_in": [0.00001]})
    assert "e" not in command[command.index("--wall-thickness") + 1].lower()


def test_archiagent_itself_parses_the_thickness_arguments_the_service_emits():
    import subprocess
    from archiagent_service.config import get_settings
    command = build_command(get_settings().archiagent_python, Path("/w/s.dxf"), Path("/w"),
                            {"wall_thickness_in": [4.5, 9.0], "wall_thickness_exhaustive": True})
    probe = ("import sys; from archiagent.cli import _parser, _declared_thickness_ft; "
             "a = _parser().parse_args(sys.argv[1:]); print(_declared_thickness_ft(a), a.wall_thickness_exhaustive)")
    done = subprocess.run([command[0], "-c", probe, *command[3:]], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == f"({4.5 / 12}, {9 / 12}) True"
