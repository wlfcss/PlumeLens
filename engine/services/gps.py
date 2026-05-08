"""GPS helpers shared by location backfill and archive geo aggregation."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import cast


def _scalar_to_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, object], value)
        numerator = _scalar_to_number(mapping.get("numerator"))
        denominator = _scalar_to_number(mapping.get("denominator"))
        if numerator is None or denominator in (None, 0):
            return None
        return numerator / denominator
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        sequence = cast(Sequence[object], value)
        if len(sequence) != 2:
            return None
        numerator = _scalar_to_number(sequence[0])
        denominator = _scalar_to_number(sequence[1])
        if numerator is None or denominator in (None, 0):
            return None
        return numerator / denominator
    return None


def _gps_part_to_decimal(value: object) -> float | None:
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        sequence = cast(Sequence[object], value)
        if len(sequence) >= 3:
            degree = _scalar_to_number(sequence[0])
            minute = _scalar_to_number(sequence[1])
            second = _scalar_to_number(sequence[2])
            if degree is None or minute is None or second is None:
                return None
            return degree + minute / 60.0 + second / 3600.0
    return _scalar_to_number(cast(object, value))


def _ref_text(ref: object) -> str:
    if isinstance(ref, bytes):
        return ref.decode("ascii", errors="ignore").strip().upper()
    return str(ref).strip().upper()


def gps_coordinate_to_decimal(value: object, ref: object) -> float | None:
    decimal = _gps_part_to_decimal(value)
    if decimal is None:
        return None
    ref_text = _ref_text(ref)
    if ref is None or not ref_text or ref_text == "NONE":
        return None
    if ref_text in {"S", "W"}:
        return -decimal
    if ref_text not in {"N", "E"}:
        return None
    return decimal


def _mapping_value(mapping: Mapping[str, object], *keys: str) -> object | None:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def gps_from_mapping(gps: Mapping[str, object]) -> tuple[float, float] | None:
    lat = gps_coordinate_to_decimal(
        _mapping_value(gps, "GPSLatitude", "2"),
        _mapping_value(gps, "GPSLatitudeRef", "1"),
    )
    lon = gps_coordinate_to_decimal(
        _mapping_value(gps, "GPSLongitude", "4"),
        _mapping_value(gps, "GPSLongitudeRef", "3"),
    )
    if lat is None or lon is None:
        return None
    return lat, lon


def parse_gps_from_exif(exif_json: str | None) -> tuple[float, float] | None:
    if not exif_json:
        return None
    try:
        raw: object = json.loads(exif_json)
    except Exception:
        return None
    if not isinstance(raw, Mapping):
        return None
    exif = cast(Mapping[str, object], raw)
    gps = exif.get("GPSInfo")
    if not isinstance(gps, Mapping):
        return None
    return gps_from_mapping(cast(Mapping[str, object], gps))
