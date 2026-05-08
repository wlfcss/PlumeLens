# pyright: basic
"""把照片 GPS 坐标解析为地名(country/province/city/district/place)持久化到 photos 表。

启动期由 lifespan 后台跑;运行时遇到未解析的照片也可以触发。每张图查一次 reverse
geocoding(走 services/geocoder 的 provider chain),结果写回 photos 表对应字段,
之后羽迹页面三级地图直接 SQL 聚合,不再 round-trip 调 reverse geocoding。

幂等:已经填充过(country IS NOT NULL)的照片跳过。GPS 缺失的照片 country=NULL
保留；有 GPS 但 provider 链路无法解析时写入内部哨兵值,避免每次启动重复重试。
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Mapping
from typing import Any, Literal

import structlog

from engine.core.database import Database
from engine.services.geo_constants import UNRESOLVED_COUNTRY
from engine.services.geocoder import reverse
from engine.services.gps import parse_gps_from_exif

logger = structlog.stdlib.get_logger()
BackfillStatus = Literal["filled", "unresolved", "skipped"]


def _parse_gps_from_exif(exif_json: str | None) -> tuple[float, float] | None:
    """从 photos.exif_json 提取 (lat, lon) WGS84 十进制度。
    无 GPS / 解析失败返回 None。"""
    return parse_gps_from_exif(exif_json)


def _looks_like_broken_gps(exif_json: str | None) -> bool:
    """EXIF 声明了经纬度字段但解析失败，说明 GPS 元数据不完整/不可用。"""
    if not exif_json:
        return False
    try:
        raw: object = json.loads(exif_json)
    except Exception:
        return False
    if not isinstance(raw, Mapping):
        return False
    gps = raw.get("GPSInfo")
    if not isinstance(gps, Mapping):
        return False
    return ("GPSLatitude" in gps or "2" in gps) and ("GPSLongitude" in gps or "4" in gps)


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
            # 直辖市:province 与 city 同名(高德/百度返回的"北京市朝阳区..."不会再出
            # "市"后缀)。若不在此处显式回写 city,二级地图 SQL 按 province 查 city
            # 永远 0 命中,北京/上海/天津/重庆 4 个直辖市点击后都看不到下钻数据。
            out["city"] = muni
            s = s[len(muni):]
            break
    if out["province"] is None:
        for suf in province_suffixes:
            idx = s.find(suf)
            # 省名前缀长度上限 6 字符:覆盖 "新疆维吾尔自治区"(前缀 "新疆维吾尔"=5)
            # / "黔西南布依族苗族自治州"等。
            if 0 < idx <= 6:
                out["province"] = s[: idx + len(suf)]
                s = s[idx + len(suf):]
                # 港澳特别行政区:与直辖市一样,province == city(没有"市"分级)。
                # 不显式回写 city → 二级地图 SQL `WHERE province=? AND city IS NOT NULL`
                # 永远 0 命中,香港/澳门点击后看不到任何下钻数据(同直辖市 bug)。
                if suf == "特别行政区":
                    out["city"] = out["province"]
                break
    # city — 直辖市/特别行政区分支已经回写过 out["city"] = province,这里守卫别覆盖
    if out["city"] is None:
        city_suffixes = ["市", "自治州", "盟", "地区"]
        for suf in city_suffixes:
            idx = s.find(suf)
            # 8 字符上限覆盖 "黔西南布依族苗族自治州"(前缀 8)/"西双版纳傣族自治州"等
            if 0 < idx <= 10:
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
    *,
    commit: bool = True,
) -> BackfillStatus:
    """对一张照片执行 reverse geocoding 并写回。

    返回:
    - filled: 成功填充地理字段
    - unresolved: 有 GPS,但 provider 链路无法解析;写哨兵值避免启动期反复重试
    - skipped: 无 GPS / EXIF 不可解析

    commit=False 时只 execute 不 commit — 调用方批量处理后统一 commit
    (减少千张照片 ×千次 fsync 的 I/O 开销 + 写锁占用时间)。
    """
    coords = _parse_gps_from_exif(exif_json)
    if coords is None:
        if _looks_like_broken_gps(exif_json):
            await db.conn.execute(
                "UPDATE photos SET country = ?, province = NULL, city = NULL, "
                "district = NULL, place = NULL WHERE id = ?",
                (UNRESOLVED_COUNTRY, photo_id),
            )
            if commit:
                await db.conn.commit()
            return "unresolved"
        return "skipped"
    lat, lon = coords
    result = await reverse(lat, lon, lang)
    if result is None:
        await db.conn.execute(
            "UPDATE photos SET country = ?, province = NULL, city = NULL, "
            "district = NULL, place = NULL WHERE id = ?",
            (UNRESOLVED_COUNTRY, photo_id),
        )
        if commit:
            await db.conn.commit()
        return "unresolved"
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
    if commit:
        await db.conn.commit()
    return "filled"


async def backfill_library_locations(
    db: Database,
    library_id: str,
    *,
    progress_cb: Any = None,
    batch_size: int = 50,
) -> dict[str, int]:
    """扫一个 library 内所有 country IS NULL 但有 exif_json 的 photo,逐张调
    reverse_geocoding 写回。Provider chain 自动 fallback；链路全失败时写入
    内部哨兵值,避免启动期反复重试永久无解坐标。"""
    conn = db.conn
    # 关键预过滤:只挑 EXIF 里真有经纬度字段的照片。
    # 老逻辑只看 `country IS NULL AND exif_json IS NOT NULL`,会把 photos 表里
    # 全部"没 GPS 但有 EXIF"的照片每次启动都重扫一遍 → 解析失败 → skipped += 1,
    # 大库可能数千张照片永远在 backfill 队列里空跑。部分相机会写空 GPSInfo 容器,
    # 所以这里必须看 GPSLatitude/GPSLongitude,不能只看 GPSInfo。
    async with conn.execute(
        "SELECT id, exif_json FROM photos "
        "WHERE library_id = ? AND country IS NULL "
        "AND exif_json IS NOT NULL "
        "AND exif_json LIKE '%\"GPSLatitude\"%' "
        "AND exif_json LIKE '%\"GPSLongitude\"%'",
        (library_id,),
    ) as cur:
        rows = list(await cur.fetchall())  # 实化成 list 才能 len()/enumerate 二次遍历

    if not rows:
        return {"total": 0, "filled": 0, "skipped": 0, "unresolved": 0}

    filled = 0
    skipped = 0
    unresolved = 0
    total = len(rows)
    pending_writes = 0
    # batch commit:每 batch_size 张才 commit 一次 — 减少 千次 fsync + 长时间持有写锁
    # (WAL 模式下 writer 持锁期间 reader 可读但其他 writer 全部阻塞)。
    for i, row in enumerate(rows):
        try:
            status = await backfill_one(db, str(row["id"]), row["exif_json"], commit=False)
            if status == "filled":
                filled += 1
                pending_writes += 1
            elif status == "unresolved":
                unresolved += 1
                pending_writes += 1
            else:
                skipped += 1
        except Exception:
            logger.exception("Location backfill failed for photo", photo_id=str(row["id"]))
            skipped += 1
        # batch commit 触发:每 batch_size 张落盘 + 进度回调
        if (i + 1) % batch_size == 0:
            if pending_writes > 0:
                await conn.commit()
                pending_writes = 0
            if progress_cb:
                with contextlib.suppress(Exception):
                    await progress_cb(library_id, i + 1, total)
    # 最终残余批 commit + 进度
    if pending_writes > 0:
        await conn.commit()
    if progress_cb:
        with contextlib.suppress(Exception):
            await progress_cb(library_id, total, total)

    await logger.ainfo(
        "Location backfill done",
        library_id=library_id,
        total=total,
        filled=filled,
        skipped=skipped,
        unresolved=unresolved,
    )
    return {"total": total, "filled": filled, "skipped": skipped, "unresolved": unresolved}


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
