"""The subprocess boundary around the archiagent CLI.

The service NEVER imports archiagent. The CLI's documented exit codes are the
API's error taxonomy: 0 success, 1 pipeline/export/acceptance failure,
2 LLM unavailable, 3 bad usage.
"""
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


def build_command(python: Path, source: Path, out_dir: Path, options: dict) -> list[str]:
    # Exactly one of --dxfFilePath / --pdfFilePath is accepted.
    flag = "--pdfFilePath" if source.suffix.lower() == ".pdf" else "--dxfFilePath"
    command = [str(python), "-m", "archiagent", flag, str(source), "--outputDir", str(out_dir)]
    if (units := options.get("units_per_foot")) is not None:
        command += ["--units-per-foot", str(units)]
    if (height := options.get("height_ft")) is not None:
        command += ["--height", str(height)]
    if walls := options.get("walls"):
        command += ["--walls", *walls]
    return command


def run_cli(source: Path, out_dir: Path, options: dict, timeout_s: int = 3000) -> CliResult:
    settings = get_settings()
    command = build_command(settings.archiagent_python, source, out_dir, options)
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
