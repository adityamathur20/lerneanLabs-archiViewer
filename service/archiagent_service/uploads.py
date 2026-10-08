"""Upload validation. Everything here runs BEFORE a job is queued."""
import subprocess
from functools import lru_cache
from pathlib import PurePosixPath

from fastapi import HTTPException

from archiagent_service.config import get_settings

# What archiagent can ingest. A DWG is converted to DXF by Tier 1 (the ODA File
# Converter, installed in the worker image) before the pipeline sees it.
ALLOWED_SUFFIXES = {".dxf", ".dwg", ".pdf"}


@lru_cache
def dwg_supported() -> bool:
    """Whether the worker can actually convert a DWG.

    Asked of Tier 1 rather than guessed, so a worker with no converter refuses
    the upload immediately instead of queueing a job that fails minutes later
    with a generic error. Cached: it is a filesystem probe on a fixed path.
    """
    settings = get_settings()
    if settings.dwg_enabled is not None:
        return settings.dwg_enabled
    try:
        completed = subprocess.run(
            [str(settings.archiagent_python), "-c",
             "from archiagent.ingest.dwg import converter_available;"
             "print('yes' if converter_available() else 'no')"],
            cwd=settings.archiagent_cwd, capture_output=True, text=True, timeout=30,
        )
        return completed.stdout.strip() == "yes"
    except (OSError, subprocess.SubprocessError):
        return False


def validate_upload(filename: str, size: int, max_bytes: int) -> str:
    """Returns the lowercased suffix, or raises.

    The client's content-type is not consulted: it is trivially forged, and the
    worker validates by parsing anyway.
    """
    # The filename becomes part of an S3 key. Anything that looks like a path —
    # POSIX or Windows — could write outside the tenant's prefix.
    if not filename or filename != filename.strip():
        raise HTTPException(status_code=400, detail="filename must not be empty or padded")
    if "/" in filename or "\\" in filename or PurePosixPath(filename).name != filename:
        raise HTTPException(status_code=400, detail="filename must not contain a path")

    suffix = PurePosixPath(filename).suffix.lower()
    if suffix == ".dwg" and not dwg_supported():
        raise HTTPException(
            status_code=400,
            detail="this deployment cannot convert DWG (no ODA File Converter on "
                   "the worker); export DXF from your CAD software and upload that instead",
        )
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported format {suffix or '(none)'}; accepted: {sorted(ALLOWED_SUFFIXES)}",
        )
    if size <= 0:
        raise HTTPException(status_code=400, detail="upload is empty")
    if size > max_bytes:
        raise HTTPException(status_code=413, detail=f"upload exceeds {max_bytes} bytes")
    return suffix
