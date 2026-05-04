# pyright: basic
"""把照片 GPS 坐标解析为地名(country/province/city/district/place)持久化到 photos 表。

启动期由 lifespan 后台跑;运行时遇到未解析的照片也可以触发。每张图查一次 reverse
geocoding(走 services/geocoder 的 provider chain),结果写回 photos 表对应字段,
之后羽迹页面三级地图直接 SQL 聚合,不再 round-trip 调 reverse geocoding。

幂等:已经填充过(country IS NOT NULL)的照片跳过。GPS 缺失的照片 country=NULL
保留(无法解析,不重试)。
"""

from __future__ import annotations

import contextlib
import json
from typing import Any

import structlog

from engine.core.database import Database
from engine.services.geocoder import reverse

logger = structlog.stdlib.get_logger()


def _parse_gps_from_exif(exif_json: str | None) -> tuple[float, float] | None:
    """从 photos.exif_json 提取 (lat, lon) WGS84 十进制度。
    无 GPS / 解析失败返回 None。"""
    if not exif_json:
        return None
    try:
        exif = json.loads(exif_json)
    except Exception:
        return None
    gps = exif.get("GPSInfo")
    if not isinstance(gps, dict):
        return None

    def _to_decimal(dms: object, ref: object) -> float | None:
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
        return None
    return lat, lon


def _split_components(display_name: str) -> dict[str, str | None]:
    """从 reverse_geocoding 返回的 display_name 启发式拆分成 country/province/city
    /district/place。各 provider 格式不同 — 我们尽量兼容:
      高德:    "江苏省苏州市姑苏区平江街道察院场社区"  (无分隔符,中文连写)
      百度:    "江苏省苏州市姑苏区XX路XX号"
      腾讯:    "江苏省苏州市姑苏区..."
      Nominatim: "调丰巷, 平江街道, 姑苏区, 苏州市, 江苏省, 215005, 中国"
      offline:   "中国 江苏省 苏州市 苏州"

    简单规则:
    1. 含逗号(Nominatim) → 倒序: country, ?, province, city, ..., place
    2. 不含逗号(中国 provider): 用正则切 [省/自治区/特别行政区] / [市/自治州/盟] /
       [区/县/旗] 三级,剩余作 place
    3. 拆失败 → 整串作 place,其他 NULL
    """
    out: dict[str, str | None] = {
        "country": None,
        "province": None,
        "city": None,
        "district": None,
        "place": display_name,
    }
    if not display_name:
        return out

    # Nominatim: 逗号分隔,倒序为大区到小区
    if "," in display_name:
        parts = [p.strip() for p in display_name.split(",") if p.strip()]
        # 过滤纯数字(邮编)
        parts = [p for p in parts if not p.isdigit()]
        if not parts:
            return out
        # 倒序:最后是国家,倒数第二是省,倒数第三是市
        n = len(parts)
        if n >= 1:
            out["country"] = parts[-1]
        if n >= 2:
            out["province"] = parts[-2]
        if n >= 3:
            out["city"] = parts[-3]
        if n >= 4:
            out["district"] = parts[-4]
        if n >= 5:
            # 最前面拼起来作 place(街道+门牌等)
            out["place"] = ", ".join(parts[:-4])
        else:
            out["place"] = parts[0] if parts else display_name
        return out

    # 中文连写:用关键字切
    s = display_name
    # country
    if s.startswith("中国"):
        out["country"] = "中国"
        s = s[2:]
    # province (省 / 自治区 / 特别行政区 / 市 北京/上海/天津/重庆 直辖)
    province_suffixes = ["省", "自治区", "特别行政区"]
    direct_municipalities = ["北京市", "上海市", "天津市", "重庆市"]
    for muni in direct_municipalities:
        if s.startswith(muni):
            out["province"] = muni
            s = s[len(muni):]
            break
    if out["province"] is None:
        for suf in province_suffixes:
            idx = s.find(suf)
            if 0 < idx <= 6:  # 省名 ≤ 6 字符
                out["province"] = s[: idx + len(suf)]
                s = s[idx + len(suf):]
                break
    # city
    city_suffixes = ["市", "自治州", "盟", "地区"]
    for suf in city_suffixes:
        idx = s.find(suf)
        if 0 < idx <= 8:
            out["city"] = s[: idx + len(suf)]
            s = s[idx + len(suf):]
            break
    # district
    district_suffixes = ["区", "县", "旗", "自治县"]
    for suf in district_suffixes:
        idx = s.find(suf)
        if 0 < idx <= 8:
            out["district"] = s[: idx + len(suf)]
            s = s[idx + len(suf):]
            break
    # 剩余的作 place(街道/POI)
    out["place"] = s.strip() or display_name
    if out["country"] is None and out["province"] is not None:
        # 中文 provider 默认中国
        out["country"] = "中国"
    return out


async def backfill_one(
    db: Database,
    photo_id: str,
    exif_json: str | None,
    lang: str = "zh-CN",
) -> bool:
    """对一张照片执行 reverse geocoding 并写回。返回 True = 成功填充,
    False = 无 GPS / 查询失败(都不重试)。"""
    coords = _parse_gps_from_exif(exif_json)
    if coords is None:
        return False
    lat, lon = coords
    result = await reverse(lat, lon, lang)
    if result is None:
        return False
    parts = _split_components(result["display_name"])
    await db.conn.execute(
        "UPDATE photos SET country = ?, province = ?, city = ?, district = ?, place = ? "
        "WHERE id = ?",
        (
            parts["country"],
            parts["province"],
            parts["city"],
            parts["district"],
            parts["place"],
            photo_id,
        ),
    )
    await db.conn.commit()
    return True


async def backfill_library_locations(
    db: Database,
    library_id: str,
    *,
    progress_cb: Any = None,
    batch_size: int = 50,
) -> dict[str, int]:
    """扫一个 library 内所有 country IS NULL 但有 exif_json 的 photo,逐张调
    reverse_geocoding 写回。Provider chain 自动 fallback,链路全失败时该照片
    保持 NULL,下次启动可重试(只要 country 仍 NULL)。"""
    conn = db.conn
    async with conn.execute(
        "SELECT id, exif_json FROM photos "
        "WHERE library_id = ? AND country IS NULL AND exif_json IS NOT NULL",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()

    if not rows:
        return {"total": 0, "filled": 0, "skipped": 0}

    filled = 0
    skipped = 0
    total = len(rows)
    for i, row in enumerate(rows):
        try:
            ok = await backfill_one(db, str(row["id"]), row["exif_json"])
            if ok:
                filled += 1
            else:
                skipped += 1
        except Exception:
            logger.exception("Location backfill failed for photo", photo_id=str(row["id"]))
            skipped += 1
        # 进度回调(每 batch_size 张通知一次,避免 SSE 太频)
        if progress_cb and (i + 1) % batch_size == 0:
            with contextlib.suppress(Exception):
                await progress_cb(library_id, i + 1, total)
    if progress_cb:
        with contextlib.suppress(Exception):
            await progress_cb(library_id, total, total)

    await logger.ainfo(
        "Location backfill done",
        library_id=library_id,
        total=total,
        filled=filled,
        skipped=skipped,
    )
    return {"total": total, "filled": filled, "skipped": skipped}


async def backfill_all_libraries(db: Database) -> None:
    """lifespan 启动后台跑 — 扫所有 library 的未解析照片。"""
    async with db.conn.execute("SELECT id FROM libraries") as cur:
        rows = await cur.fetchall()
    for row in rows:
        try:
            await backfill_library_locations(db, str(row["id"]))
        except Exception:
            logger.exception(
                "Location backfill aborted for library",
                library_id=str(row["id"]),
            )
