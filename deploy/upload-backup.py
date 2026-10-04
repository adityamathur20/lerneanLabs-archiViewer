"""Puts one already-written dump into the object store.

A separate file, not an inline `python -c`, because the dump is copied into the
container as a FILE and never passed as an argument: a real dump is megabytes
and argv is capped (ARG_MAX), so base64-on-the-command-line would fail with
"Argument list too long" exactly when there is finally data worth keeping.
"""
import os
import pathlib
import sys

from archiagent_service.storage import get_store

name = os.environ.get("BACKUP_NAME") or sys.exit("BACKUP_NAME is required")
path = pathlib.Path(f"/tmp/{name}")
if not path.is_file():
    sys.exit(f"{path} was not copied into the container")

get_store().put_file(f"_backups/{name}", path)
print(f"uploaded _backups/{name} ({path.stat().st_size} bytes)")
