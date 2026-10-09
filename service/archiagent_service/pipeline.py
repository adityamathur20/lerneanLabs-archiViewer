"""The subprocess boundary around the archiagent CLI.

The service NEVER imports archiagent. The CLI's documented exit codes are the
API's error taxonomy: 0 success, 1 pipeline/export/acceptance failure,
2 LLM unavailable, 3 bad usage.
"""
import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from archiagent_service.config import get_settings

#: What the pipeline writes that is worth keeping (spec §3). The source is
#: already stored under its own key and is deliberately not re-collected.
ARTIFACT_PATTERNS = ("*.ifc", "*.interpretation.json", "*.report.json", "*.overlay.svg")

EXIT_MEANING = {
    0: "succeeded",
    1: "pipeline or validation failure",
    2: "LLM provider unavailable",
    3: "bad usage",
}


@dataclass(frozen=True)
class CliResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int


def _plain(value: float) -> str:
    """A decimal that can never be read as a flag or written as 1e-05."""
    text = repr(float(value))
    return format(float(value), ".10f").rstrip("0").rstrip(".") if "e" in text.lower() else text


def build_command(python: Path, source: Path, out_dir: Path, options: dict) -> list[str]:
    # Exactly one input flag is accepted. DWG conversion happens inside the
    # CLI (Tier 1), so the service only names the flag.
    flag = {".pdf": "--pdfFilePath", ".dwg": "--dwgFilePath"}.get(
        source.suffix.lower(), "--dxfFilePath"
    )
    command = [str(python), "-m", "archiagent", flag, str(source), "--outputDir", str(out_dir)]
    # `units_per_foot` may still sit in an older job's stored options; the CLI
    # removed --units-per-foot, so it is deliberately not forwarded.
    if options.get("trust_extracted_scale"):
        command.append("--trust-extracted-scale")
    for wall in options.get("scale_from_wall") or ():
        command += ["--scale-from-wall", *(str(wall[k]) for k in ("x1", "y1", "x2", "y2", "length"))]
    if thicknesses := options.get("wall_thickness_in"):
        command += ["--wall-thickness", *(_plain(v) for v in thicknesses)]
        if options.get("wall_thickness_exhaustive"):
            command.append("--wall-thickness-exhaustive")
    if (height := options.get("height_ft")) is not None:
        command += ["--height", str(height)]
    if walls := options.get("walls"):
        command += ["--walls", *walls]
    return command


def build_prepare_command(python: Path, source: Path, out_dir: Path) -> list[str]:
    """`--prepare`: convert a DWG, write plan.scale.json, stop. No model calls."""
    flag = "--dwgFilePath" if source.suffix.lower() == ".dwg" else "--dxfFilePath"
    return [str(python), "-m", "archiagent", flag, str(source), "--outputDir", str(out_dir), "--prepare"]


def run_prepare(source: Path, out_dir: Path, timeout_s: int | None = None) -> CliResult:
    settings = get_settings()
    return _run(build_prepare_command(settings.archiagent_python, source, out_dir),
                settings.prepare_timeout_s if timeout_s is None else timeout_s)


def run_cli(source: Path, out_dir: Path, options: dict, timeout_s: int | None = None) -> CliResult:
    settings = get_settings()
    command = build_command(settings.archiagent_python, source, out_dir, options)
    return _run(command, settings.cli_timeout_s if timeout_s is None else timeout_s)


def _run(command: list[str], timeout_s: int) -> CliResult:
    settings = get_settings()
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command, cwd=settings.archiagent_cwd, capture_output=True, text=True, timeout=timeout_s
        )
        code, out, err = completed.returncode, completed.stdout, completed.stderr
    except subprocess.TimeoutExpired:
        code, out, err = 1, "", f"archiagent timed out after {timeout_s}s"
    return CliResult(code, out, err, int((time.monotonic() - started) * 1000))


def collect_artifacts(out_dir: Path) -> list[Path]:
    found: list[Path] = []
    for pattern in ARTIFACT_PATTERNS:
        found.extend(sorted(out_dir.glob(pattern)))
    return found


def read_acceptance(out_dir: Path) -> str | None:
    """`draft` or `checks-passed`, from the report the pipeline wrote.

    The report carries one status per plan region (`regions[].status`), so a
    job with any draft region is a draft job — the pessimistic reduction is the
    honest one, since a user must not read "checks-passed" while part of the
    model failed validation. Spec §3.2 declares this field; without it a draft
    IFC is reported as a plain success with no signal that anything failed.
    """
    for report in sorted(out_dir.glob("*.report.json")):
        try:
            regions = json.loads(report.read_text()).get("regions", [])
        except (OSError, json.JSONDecodeError):
            continue
        statuses = {r.get("status") for r in regions if isinstance(r, dict)}
        if "draft" in statuses:
            return "draft"
        if statuses:
            return "checks-passed"
    return None


def archiagent_version() -> str | None:
    """Recorded per job so an artifact can be traced to the code that made it."""
    settings = get_settings()
    try:
        completed = subprocess.run(
            [str(settings.archiagent_python), "-c",
             "import importlib.metadata as m; print(m.version('archiagent'))"],
            cwd=settings.archiagent_cwd, capture_output=True, text=True, timeout=30,
        )
        return completed.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None
