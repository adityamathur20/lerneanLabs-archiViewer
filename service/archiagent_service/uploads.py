"""Upload validation. Everything here runs BEFORE a job is queued."""
from pathlib import PurePosixPath

from fastapi import HTTPException

# What archiagent can ingest. A DWG is converted to DXF by Tier 1 (the ODA File
# Converter) before the pipeline sees it.
ALLOWED_SUFFIXES = {".dxf", ".dwg", ".pdf"}


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
