# pyright: basic
"""羽迹页面聚合 API — 三级地图按省/市/拍摄点聚合鸟种数 + 照片数。

数据流:
- photos.country/province/city/district/place 由 location_backfill 持久化
- 鸟种来自 analysis_results 的 best detection 物种(JSON 字段) ∪ photo_species_overrides
- 这里只做 SQL 聚合,reverse_geocoding 不在请求路径上(已 backfill)

API:
- GET /archive/geo/provinces → 一级中国地图:每个省鸟种数 + 照片数
- GET /archive/geo/cities?province=江苏省 → 二级省地图:每个市鸟种数 + 照片数
- GET /archive/geo/spots?province=...&city=... → 三级市内 marker:每个拍摄点
  (lat/lon, place 名, 鸟种, 照片缩略图)
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from engine.core.database import Database

router = APIRouter(prefix="/archive", tags=["archive"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


def _extract_species_from_result(result_json: str | None) -> str | None:
    """从 analysis_results.result_json 取 best detection 的 species 拉丁名。
    无识别 / 字段缺失返回 None。"""
    if not result_json:
        return None
    try:
        data = json.loads(result_json)
    except Exception:
        return None
    detections = data.get("detections")
    if not isinstance(detections, list) or not detections:
        return None
    # best detection: 取 detections[0](已按分数排序)或 is_best=True 的
    best = next((d for d in detections if d.get("is_best")), detections[0])
    candidates = best.get("species_candidates")
    if isinstance(candidates, list) and candidates:
        latin = candidates[0].get("canonical_sci")
        if latin:
            return str(latin)
    return None


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class GeoProvinceRow(BaseModel):
    province: str
    photo_count: int       # 该省照片总数
    species_count: int     # 该省去重后的鸟种数(拉丁名 distinct)


class GeoCityRow(BaseModel):
    city: str
    photo_count: int
    species_count: int


class GeoSpotPhoto(BaseModel):
    photo_id: str
    file_name: str
    species_latin: str | None
    species_zh: str | None
    thumb_grid: str | None
    grade: str | None
    quality_score: float | None


class GeoSpot(BaseModel):
    """单个拍摄点(GPS round 到 4 位小数 ≈ 11m,同一点的多张照片聚合)。"""
    lat: float
    lon: float
    place: str | None
    photo_count: int
    species_count: int
    photos: list[GeoSpotPhoto]  # 该点所有照片(限制最多 50 张避免响应过大)


class GeoSummary(BaseModel):
    """整体进度:有多少照片有 GPS、多少已 backfill 完成。前端用于显示
    "解析地理位置 120/300..." 进度条。"""
    total_with_gps: int      # 有 GPS 的照片总数
    resolved: int            # country IS NOT NULL 的(已 backfill)
    pending: int             # 有 exif 但未填充
    photos_without_gps: int  # 没 GPS 信息的


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("/geo/summary", response_model=GeoSummary)
async def geo_summary(request: Request) -> GeoSummary:
    """整体地理解析进度 — 羽迹页面顶部进度条用。"""
    db = await _db(request)
    async with db.conn.execute(
        "SELECT "
        "  COUNT(*) AS total, "
        "  SUM(CASE WHEN exif_json IS NOT NULL THEN 1 ELSE 0 END) AS has_exif, "
        "  SUM(CASE WHEN country IS NOT NULL THEN 1 ELSE 0 END) AS resolved "
        "FROM photos",
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return GeoSummary(total_with_gps=0, resolved=0, pending=0, photos_without_gps=0)
    total = int(row["total"] or 0)
    has_exif = int(row["has_exif"] or 0)
    resolved = int(row["resolved"] or 0)
    # GPS 与 EXIF 强相关 — 但不严格(EXIF 可能存在但无 GPS)。这里近似:has_exif 中
    # 减去 已 resolved + 真无 GPS 的(我们不能精确知道)。简化:total_with_gps ≈ resolved
    # + pending,resolved 最准。下面 pending 保守用 has_exif - resolved 作上限估计。
    pending = max(0, has_exif - resolved)
    return GeoSummary(
        total_with_gps=resolved + pending,
        resolved=resolved,
        pending=pending,
        photos_without_gps=total - has_exif,
    )


@router.get("/geo/provinces", response_model=list[GeoProvinceRow])
async def geo_provinces(request: Request) -> list[GeoProvinceRow]:
    """一级地图:每个省的照片数 + 鸟种数(去重后)。"""
    db = await _db(request)
    # 第一步:每个省 + 每个种(latin)→ photo_count。鸟种用 species 字段(简化)
    # 注意:photos.species 在 v6 detection-level 后已经是 effective species(含 manual
    # override),可以直接用。此处 species 来自 analysis_results 装配后的列(简化:
    # 直接 LEFT JOIN ar.species)。
    async with db.conn.execute(
        "SELECT p.province, ar.species AS species, COUNT(p.id) AS n "
        "FROM photos p "
        "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "WHERE p.province IS NOT NULL "
        "GROUP BY p.province, ar.species",
    ) as cur:
        rows = await cur.fetchall()

    # 第二步:聚合到省级 — 鸟种 distinct count(种为 None 的不计入物种但计入照片)
    by_province: dict[str, dict[str, set | int]] = {}
    for row in rows:
        prov = str(row["province"])
        species = row["species"]
        n = int(row["n"] or 0)
        bucket = by_province.setdefault(prov, {"species": set(), "photos": 0})
        bucket["photos"] = int(bucket["photos"]) + n  # type: ignore[operator]
        if species:
            bucket["species"].add(str(species))  # type: ignore[union-attr]

    return [
        GeoProvinceRow(
            province=prov,
            photo_count=int(b["photos"]),  # type: ignore[arg-type]
            species_count=len(b["species"]),  # type: ignore[arg-type]
        )
        for prov, b in sorted(by_province.items(), key=lambda x: -int(x[1]["photos"]))  # type: ignore[arg-type]
    ]


@router.get("/geo/cities", response_model=list[GeoCityRow])
async def geo_cities(
    request: Request,
    province: str = Query(..., description="省名(如 '江苏省')"),
) -> list[GeoCityRow]:
    """二级地图:某省内每个市的照片数 + 鸟种数。"""
    db = await _db(request)
    async with db.conn.execute(
        "SELECT p.city, ar.species AS species, COUNT(p.id) AS n "
        "FROM photos p "
        "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "WHERE p.province = ? AND p.city IS NOT NULL "
        "GROUP BY p.city, ar.species",
        (province,),
    ) as cur:
        rows = await cur.fetchall()

    by_city: dict[str, dict[str, set | int]] = {}
    for row in rows:
        city = str(row["city"])
        species = row["species"]
        n = int(row["n"] or 0)
        bucket = by_city.setdefault(city, {"species": set(), "photos": 0})
        bucket["photos"] = int(bucket["photos"]) + n  # type: ignore[operator]
        if species:
            bucket["species"].add(str(species))  # type: ignore[union-attr]

    return [
        GeoCityRow(
            city=city,
            photo_count=int(b["photos"]),  # type: ignore[arg-type]
            species_count=len(b["species"]),  # type: ignore[arg-type]
        )
        for city, b in sorted(by_city.items(), key=lambda x: -int(x[1]["photos"]))  # type: ignore[arg-type]
    ]


@router.get("/geo/spots", response_model=list[GeoSpot])
async def geo_spots(
    request: Request,
    province: str = Query(...),
    city: str = Query(...),
    max_photos_per_spot: int = Query(50, ge=1, le=200),
) -> list[GeoSpot]:
    """三级地图:某省某市的所有拍摄点(按 GPS 4位小数 round 聚合)。"""
    db = await _db(request)
    # 拉所有 photo + GPS + analysis 一起,前端聚合到 spot。
    # GPS 从 exif_json 抽,加 ar.species/ar.grade/ar.quality_score
    async with db.conn.execute(
        "SELECT p.id, p.file_name, p.exif_json, p.place, p.thumb_grid, "
        "  ar.species AS species, ar.grade, ar.quality_score, ar.result_json "
        "FROM photos p "
        "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "WHERE p.province = ? AND p.city = ?",
        (province, city),
    ) as cur:
        rows = await cur.fetchall()

    # 按 (round(lat,4), round(lon,4)) 聚合
    spots: dict[tuple[float, float], dict] = {}
    for row in rows:
        try:
            exif = json.loads(row["exif_json"] or "{}")
        except Exception:
            continue
        gps = exif.get("GPSInfo")
        if not isinstance(gps, dict):
            continue

        def _to_decimal(dms, ref):
            if not isinstance(dms, list) or len(dms) < 3:
                return None
            try:
                d, m, s = float(dms[0]), float(dms[1]), float(dms[2])
            except (TypeError, ValueError):
                return None
            value = d + m / 60.0 + s / 3600.0
            if ref in ("S", "W"):
                value = -value
            return value

        lat = _to_decimal(gps.get("GPSLatitude"), gps.get("GPSLatitudeRef"))
        lon = _to_decimal(gps.get("GPSLongitude"), gps.get("GPSLongitudeRef"))
        if lat is None or lon is None:
            continue
        key = (round(lat, 4), round(lon, 4))
        bucket = spots.setdefault(
            key,
            {
                "lat": lat,
                "lon": lon,
                "place": row["place"],
                "photos": [],
                "species_set": set(),
            },
        )
        species_latin = row["species"]
        if species_latin:
            bucket["species_set"].add(str(species_latin))
        if len(bucket["photos"]) < max_photos_per_spot:
            # species_zh 只能从 result_json 翻 candidates[0].name(可能 None)
            species_zh: str | None = None
            try:
                data = json.loads(row["result_json"] or "{}")
                detections = data.get("detections", [])
                if detections:
                    best = next(
                        (d for d in detections if d.get("is_best")), detections[0]
                    )
                    cands = best.get("species_candidates") or []
                    if cands:
                        species_zh = cands[0].get("canonical_zh") or cands[0].get(
                            "canonical_en"
                        )
            except Exception:
                pass
            bucket["photos"].append(
                GeoSpotPhoto(
                    photo_id=str(row["id"]),
                    file_name=str(row["file_name"]),
                    species_latin=str(species_latin) if species_latin else None,
                    species_zh=species_zh,
                    thumb_grid=str(row["thumb_grid"]) if row["thumb_grid"] else None,
                    grade=str(row["grade"]) if row["grade"] else None,
                    quality_score=(
                        float(row["quality_score"])
                        if row["quality_score"] is not None
                        else None
                    ),
                )
            )

    return [
        GeoSpot(
            lat=b["lat"],
            lon=b["lon"],
            place=b["place"],
            photo_count=len(b["photos"]),
            species_count=len(b["species_set"]),
            photos=b["photos"],
        )
        for b in sorted(spots.values(), key=lambda x: -len(x["photos"]))
    ]
