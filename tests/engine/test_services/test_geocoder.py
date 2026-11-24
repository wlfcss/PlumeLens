"""Tests for engine.services.geocoder — GPS fuzzing, coord validation & reverse chain."""

from __future__ import annotations

import pytest
from engine.services import geocoder
from engine.services.geocoder import (
    GeocodeResult,
    _fuzz_for_network,
    _is_valid_coord,
)


@pytest.fixture(autouse=True)
def _clear_geocoder_cache() -> None:
    geocoder._cache.clear()


def test_fuzz_rounds_to_three_decimals() -> None:
    assert _fuzz_for_network(31.2345678, 121.5432101) == (31.235, 121.543)
    assert _fuzz_for_network(45.123456, 100.987654) == (45.123, 100.988)


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


async def test_reverse_falls_back_through_chain_and_caches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def broken_provider(lat: float, lon: float, lang: str) -> GeocodeResult | None:
        calls.append("broken")
        raise RuntimeError("transient network error")

    async def empty_provider(lat: float, lon: float, lang: str) -> GeocodeResult | None:
        calls.append("empty")
        return None

    async def ok_provider(lat: float, lon: float, lang: str) -> GeocodeResult | None:
        calls.append("ok")
        return GeocodeResult(
            display_name="江苏省 南京市 玄武区", source="offline", lat=lat, lon=lon
        )

    monkeypatch.setattr(geocoder, "_CHAIN", (broken_provider, empty_provider, ok_provider))

    first = await geocoder.reverse(32.06025, 118.79687)
    assert first is not None
    assert first["display_name"] == "江苏省 南京市 玄武区"
    assert calls == ["broken", "empty", "ok"]

    # 同一 110m bucket 命中缓存，不再调用任何 provider
    second = await geocoder.reverse(32.06021, 118.79681)
    assert second == first
    assert calls == ["broken", "empty", "ok"]


async def test_reverse_negative_caches_and_rejects_invalid_coords(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def always_none(lat: float, lon: float, lang: str) -> GeocodeResult | None:
        nonlocal calls
        calls += 1
        return None

    monkeypatch.setattr(geocoder, "_CHAIN", (always_none,))

    # 无效坐标短路，不调 provider
    assert await geocoder.reverse(0.0, 0.0) is None
    assert await geocoder.reverse(float("nan"), 120.0) is None
    assert calls == 0

    # 有效坐标全链失败 → 负缓存
    assert await geocoder.reverse(31.23, 121.47) is None
    assert await geocoder.reverse(31.23, 121.47) is None
    assert calls == 1
