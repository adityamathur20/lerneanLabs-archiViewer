"""A two-plan sheet as plain ASCII DXF, so the service tests need no CAD library."""


def _line(a, b, layer):
    return f"0\nLINE\n8\n{layer}\n10\n{a[0]}\n20\n{a[1]}\n30\n0.0\n11\n{b[0]}\n21\n{b[1]}\n31\n0.0\n"


def _text(s, at, height):
    return f"0\nTEXT\n8\nTEXT\n10\n{at[0]}\n20\n{at[1]}\n30\n0.0\n40\n{height}\n1\n{s}\n"


def plan(x, y, w=720, h=480):
    """Two faces 9 in apart round each wall (inches), so walls pair up."""
    out = []
    for a, b in (((x, y), (x + w, y)), ((x + w, y), (x + w, y + h)),
                 ((x + w, y + h), (x, y + h)), ((x, y + h), (x, y))):
        (x1, y1), (x2, y2) = a, b
        for d in (-4.5, 4.5):
            s, e = ((x1, y1 + d), (x2, y2 + d)) if y1 == y2 else ((x1 + d, y1), (x2 + d, y2))
            out.append(_line(s, e, "WALL"))
    for k in (1, 2, 3):
        px = x + k * w / 4
        for d in (-4.5, 4.5):
            out.append(_line((px + d, y), (px + d, y + h), "WALL"))
    return "".join(out)


def two_floor_sheet() -> bytes:
    body = (plan(0, 0) + plan(1200, 0)
            + _line((-600, -1500), (3000, -1500), "DIM") + _line((-600, 2500), (3000, 2500), "DIM")
            + _text("GROUND FLOOR PLAN", (300, -60), 24) + _text("FIRST FLOOR PLAN", (1500, -60), 24))
    layers = "".join(f"0\nLAYER\n2\n{n}\n70\n0\n62\n7\n6\nCONTINUOUS\n" for n in ("WALL", "DIM", "TEXT"))
    return ("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n1\n0\nENDSEC\n"
            f"0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n3\n{layers}0\nENDTAB\n0\nENDSEC\n"
            f"0\nSECTION\n2\nENTITIES\n{body}0\nENDSEC\n0\nEOF\n").encode()
