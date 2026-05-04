# pyright: basic
"""Reverse geocoding 路由 — 给 UI 调,按 provider chain 解析坐标到地名。"""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel

from engine.services.geocoder import reverse

router = APIRouter(prefix="/geocoding", tags=["geocoding"])


class ReverseGeocodeResponse(BaseModel):
    display_name: str | None  # 人类可读地址,所有 provider 都失败时为 None
    source: str | None        # provider 标识(amap/baidu/tencent/nominatim/offline),
                              # null 时跟 display_name 一起 null
    lat: float
    lon: float


@router.get("/reverse", response_model=ReverseGeocodeResponse)
async def reverse_geocode(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    lang: str = Query("zh-CN", description="accept-language 偏好(主要影响 Nominatim)"),
) -> ReverseGeocodeResponse:
    result = await reverse(lat, lon, lang)
    if result is None:
        return ReverseGeocodeResponse(display_name=None, source=None, lat=lat, lon=lon)
    return ReverseGeocodeResponse(**result)
