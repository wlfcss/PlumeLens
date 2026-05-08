"""Tests for engine.services.geocoder — GPS fuzzing (M21) + coord validation."""

from __future__ import annotations

from engine.services.geocoder import (
    _NETWORK_GPS_PRECISION,
    _fuzz_for_network,
    _is_valid_coord,
)


def test_fuzz_rounds_to_three_decimals() -> None:
    assert _fuzz_for_network(31.2345678, 121.5432101) == (31.235, 121.543)


def test_fuzz_keeps_three_decimal_precision() -> None:
    assert _NETWORK_GPS_PRECISION == 3
    # 11m precision sanity: 0.001° ≈ 111 m at equator,经纬度
    flat, _ = _fuzz_for_network(45.123456, 100.987654)
    assert abs(flat - 45.123) < 1e-6


def test_fuzz_handles_negative_coords() -> None:
    assert _fuzz_for_network(-33.8567, 151.2153) == (-33.857, 151.215)


def test_valid_coord_accepts_normal() -> None:
    assert _is_valid_coord(31.0, 121.0)


def test_valid_coord_rejects_null_island() -> None:
    # (0,0) 是 EXIF DMS 全 0 的损坏占位,不应当作有效 GPS
    assert not _is_valid_coord(0.0, 0.0)
    assert not _is_valid_coord(0.0001, 0.0001)


def test_valid_coord_rejects_oob() -> None:
    assert not _is_valid_coord(91.0, 0.0)
    assert not _is_valid_coord(0.0, 181.0)


def test_valid_coord_rejects_nan() -> None:
    assert not _is_valid_coord(float("nan"), 0.0)
    assert not _is_valid_coord(0.0, float("inf"))
