"""一次性脚本:从 GeoNames 下载 cities1000 / admin1 / admin2 / countryInfo,
转换为 PlumeLens 离线 reverse geocoding 用的紧凑 npz 数据。

输出:engine/data/cities1000.npz
  - coords:  (N, 2) float32 — lat, lon
  - meta:    list[dict] — {country, admin1, admin2, name}

GeoNames 数据 CC-BY 4.0,可商用 + 重新分发。

运行:
    cd <project_root>
    uv run python scripts/build_geocoding_data.py
"""

from __future__ import annotations

import io
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

import numpy as np

GEONAMES = "https://download.geonames.org/export/dump"
SOURCES = {
    "cities1000": f"{GEONAMES}/cities1000.zip",      # 城市/区县(人口 >1000),~14 MB zip
    "admin1": f"{GEONAMES}/admin1CodesASCII.txt",     # 省/州 code → name,~10 KB
    "admin2": f"{GEONAMES}/admin2Codes.txt",          # 市/县 code → name,~600 KB
    "country": f"{GEONAMES}/countryInfo.txt",         # ISO code → 国家名,~30 KB
}

# 输出目录
OUT_DIR = Path(__file__).parent.parent / "engine" / "data"


def fetch_text(url: str) -> str:
    print(f"[fetch] {url}")
    with urllib.request.urlopen(url, timeout=60) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_zip_text(url: str, member: str) -> str:
    print(f"[fetch zip] {url} → {member}")
    with urllib.request.urlopen(url, timeout=120) as resp:
        data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return zf.read(member).decode("utf-8", errors="replace")


def parse_admin1(text: str) -> dict[str, str]:
    """admin1CodesASCII.txt:CN.04\tJiangsu Sheng\tJiangsu\t1799962"""
    out: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        out[parts[0]] = parts[1]  # CN.04 → Jiangsu Sheng
    return out


def parse_admin2(text: str) -> dict[str, str]:
    """admin2Codes.txt:CN.04.06\tSuzhou Shi\tSuzhou\t..."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        out[parts[0]] = parts[1]
    return out


def parse_country(text: str) -> dict[str, str]:
    """countryInfo.txt: 注释行以 # 开头,正文 ISO\tISO3\t...\tName\t..."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 5:
            out[parts[0]] = parts[4]  # ISO → name
    return out


def parse_cities(
    text: str,
    admin1: dict[str, str],
    admin2: dict[str, str],
    country: dict[str, str],
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """cities1000.txt 字段(tab):
    0=geonameid 1=name(utf-8) 2=asciiname 3=alternatenames 4=lat 5=lon
    6=feature_class 7=feature_code 8=country_code 9=cc2 10=admin1 11=admin2
    12=admin3 13=admin4 14=population ...
    """
    coords_list: list[list[float]] = []
    meta_list: list[dict[str, Any]] = []
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 12:
            continue
        try:
            lat = float(parts[4])
            lon = float(parts[5])
        except ValueError:
            continue
        cc = parts[8]
        a1_code = f"{cc}.{parts[10]}" if parts[10] else ""
        a2_code = f"{cc}.{parts[10]}.{parts[11]}" if parts[11] else ""
        coords_list.append([lat, lon])
        meta_list.append({
            "name": parts[1],  # UTF-8 name(可能含原住民语言/中文别名)
            "country": country.get(cc, cc),
            "admin1": admin1.get(a1_code, ""),
            "admin2": admin2.get(a2_code, ""),
        })
    coords = np.asarray(coords_list, dtype=np.float32)
    print(f"[cities] parsed {len(coords_list)} entries")
    return coords, meta_list


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    admin1 = parse_admin1(fetch_text(SOURCES["admin1"]))
    admin2 = parse_admin2(fetch_text(SOURCES["admin2"]))
    country = parse_country(fetch_text(SOURCES["country"]))
    cities_text = fetch_zip_text(SOURCES["cities1000"], "cities1000.txt")
    coords, meta = parse_cities(cities_text, admin1, admin2, country)

    out_path = OUT_DIR / "cities1000.npz"
    np.savez_compressed(out_path, coords=coords, meta=np.array(meta, dtype=object))
    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"[done] wrote {out_path} ({size_mb:.2f} MB, {len(meta)} entries)")


if __name__ == "__main__":
    main()
