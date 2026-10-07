"""Scale options for the end-to-end tests.

archiAgent refuses a DXF whose scale is not established, so a real run needs
either an asserted wall or permission to trust the drawing's own dimensions.
Set ARCHIAGENT_SCALE_FROM_WALL="X1 Y1 X2 Y2 LENGTH" for a fixture with no
usable dimensions; otherwise the drawing's dimensions are trusted.
"""
import os


def scale_options() -> dict:
    wall = os.environ.get("ARCHIAGENT_SCALE_FROM_WALL")
    if not wall:
        return {"trust_extracted_scale": True}
    x1, y1, x2, y2, length = wall.split(maxsplit=4)
    return {"scale_from_wall": [
        {"x1": float(x1), "y1": float(y1), "x2": float(x2), "y2": float(y2), "length": length}
    ]}
