"""Upload validation. Everything here runs BEFORE a job is queued."""
from pathlib import PurePosixPath

from fastapi import HTTPException

# What this service can actually process today. DWG needs the ODA conversion
# step, which is Phase 4: accepting it now would queue a job that fails minutes
# later inside the CLI with an ezdxf parse error.
ALLOWED_SUFFIXES = {".dxf", ".pdf"}
NOT_YET_SUPPORTED = {".dwg": "DWG conversion arrives in Phase 4; export DXF for now"}


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
    if suffix in NOT_YET_SUPPORTED:
        raise HTTPException(status_code=400, detail=NOT_YET_SUPPORTED[suffix])
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
