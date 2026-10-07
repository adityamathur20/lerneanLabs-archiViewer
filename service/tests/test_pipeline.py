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
        {"scale_from_wall": ["0", "0", "120", "0", "10ft"], "height_ft": 10.0, "walls": ["WALLS"]},
    )

    assert command[:3] == ["/venv/bin/python", "-m", "archiagent"]
    assert "--dxfFilePath" in command and "/work/source.dxf" in command
    assert "--outputDir" in command and "/work" in command
    span = command.index("--scale-from-wall")
    assert command[span + 1:span + 6] == ["0", "0", "120", "0", "10ft"]
    assert command[command.index("--height") + 1] == "10.0"
    assert command[command.index("--walls") + 1] == "WALLS"


def test_command_omits_flags_that_were_not_requested():
    command = build_command(Path("/p"), Path("/w/s.dxf"), Path("/w"), {})
    assert "--scale-from-wall" not in command
    assert "--trust-extracted-scale" not in command
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
