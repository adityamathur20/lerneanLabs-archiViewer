"""Keeps the newest KEEP dumps under _backups/ and deletes the rest.

The object-store copy shares the VPS disk with every artifact, so an unpruned
_backups/ eventually fills the volume the service needs to work.
"""
import os

from archiagent_service.storage import get_store

keep = int(os.environ.get("KEEP", "14"))
store = get_store()
# Keys are pg-<UTC timestamp>.sql.gz, so lexicographic order is chronological.
dumps = sorted(k for k in store.list_prefix("_backups/") if k.endswith(".sql.gz"))
stale = dumps[:-keep] if len(dumps) > keep else []

for key in stale:
    store.delete_prefix(key)
print(f"_backups/: {len(dumps)} present, {len(stale)} pruned, keeping newest {keep}")
