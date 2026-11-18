"""Hints from file names when the image itself carries no metadata.

Microscope software and people name files like "oe_-_40x_0005_RFP.tiff" or
"DAPI_20x_well3.tif": the objective magnification and the fluorophore are right there.
They are used only where the file's own metadata is missing.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_MAG = re.compile(r"(?<![0-9a-zA-Z.])(\d{1,3}(?:\.\d+)?)\s*[xX×](?![a-zA-Z0-9])")

# token → (channel name, colour)
_FLUORS: dict[str, tuple[str, list[int]]] = {}
for names, color in (
    (("dapi", "hoechst", "bfp"), [0, 0, 255]),
    (("gfp", "egfp", "fitc", "af488", "alexa488", "a488", "cy2"), [0, 255, 0]),
    (("yfp", "venus"), [255, 255, 0]),
    (("rfp", "mcherry", "tritc", "cy3", "af568", "af594", "alexa594", "txred", "texasred", "dsred", "pi"), [255, 0, 0]),
    (("cy5", "af647", "alexa647", "farred", "cy7"), [255, 0, 255]),
    (("bf", "brightfield", "tl", "phase", "dic"), [255, 255, 255]),
):
    for n in names:
        _FLUORS[n] = (n.upper() if len(n) <= 5 else n.capitalize(), color)


def magnification_from_name(name: str) -> float | None:
    for match in _MAG.finditer(Path(name).stem):
        value = float(match.group(1))
        if 1 <= value <= 200:
            return value
    return None


def fluor_from_name(name: str) -> tuple[str, list[int]] | None:
    tokens = [t.lower() for t in re.split(r"[^A-Za-z0-9]+", Path(name).stem) if t]
    for token in reversed(tokens):  # channel suffixes usually come last
        if token in _FLUORS:
            return _FLUORS[token]
    return None


def enrich(rec: dict[str, Any]) -> dict[str, Any]:
    """Fill a missing magnification / a generic single channel from the file name (in place)."""
    name = str(rec.get("name") or "")
    if not rec.get("magnification"):
        mag = magnification_from_name(name)
        if mag:
            rec["magnification"] = mag
            rec["magnification_source"] = "filename"
    channels = rec.get("channels") or []
    if len(channels) == 1 and not rec.get("is_rgb"):
        ch = channels[0]
        generic_name = str(ch.get("name") or "").lower() in ("", "channel 1", "c0", "ch0", "channel0")
        generic_color = not ch.get("color") or list(ch["color"]) == [255, 255, 255]
        hint = fluor_from_name(name) if generic_name or generic_color else None
        if hint:
            if generic_name:
                ch["name"] = hint[0]
            if generic_color:
                ch["color"] = list(hint[1])
    return rec
