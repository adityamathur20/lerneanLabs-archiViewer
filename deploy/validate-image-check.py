"""The worker image must be able to run archiAgent's own IFC validation.

A missing EXPRESS-rule dependency does not crash: it downgrades every
conversion to `draft` with "No module named '_pytest'", so the IFC is correct
and the service still reports failure. Caught on the first live deployment.
"""
import importlib.util
import sys

missing = [m for m in ("pytest", "_pytest") if importlib.util.find_spec(m) is None]
if missing:
    sys.exit(f"FAIL: express-rule validation needs {missing}")

import ifcopenshell
import ifcopenshell.validate

logger = ifcopenshell.validate.json_logger()
print(f"OK: ifcopenshell {ifcopenshell.version}, validator and express rules importable")
