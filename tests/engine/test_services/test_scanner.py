"""Tests for folder scanner (two-phase scan + hash backfill)."""

from __future__ import annotations

import hashlib
import json
import struct
from fractions import Fraction
from pathlib import Path

import pytest
from engine.core.database import Database
from engine.services.scanner import (
    _extract_exif,
    _parse_canon_afinfo2,
    _probe_image_meta,
    backfill_hashes,
    scan_library,
)
from PIL import Image


@pytest.fixture
async def db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "scan_test.db")
    await db.connect()
    # 插入一个 library 供 scan 使用
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("lib-test", "Test Lib", "/tmp", "/tmp/lib-test", "2026-04-24", "2026-04-24"),
    )
    await db.conn.commit()
    yield db
    await db.close()


def _make_jpeg(path: Path, size: tuple[int, int] = (64, 48)) -> None:
    """Write a minimal valid JPEG file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color=(100, 120, 140)).save(path, "JPEG", quality=80)


def test_extract_exif_expands_gps_ifd() -> None:
    """真实照片 GPSInfo 常是 IFD offset，必须展开 GPS 子目录供地图使用。"""

    class FakeExif:
        def items(self):
            return [
                (0x010F, "Canon"),  # Make
                (0x0110, "EOS R5m2"),  # Model
                (0x8825, 1234),  # GPSInfo offset; should not be stored as-is
            ]

        def get_ifd(self, ifd):
            if ifd == 34853:  # ExifTags.IFD.GPSInfo
                return {
                    1: "N",
                    2: (Fraction(31, 1), Fraction(37, 1), Fraction(30, 1)),
                    3: "E",
                    4: (Fraction(121, 1), Fraction(28, 1), Fraction(15, 1)),
                }
            return {}

    class FakeImage:
        def getexif(self):
            return FakeExif()

    exif = _extract_exif(FakeImage())  # type: ignore[arg-type]

    assert exif["Make"] == "Canon"
    assert exif["GPSInfo"]["GPSLatitudeRef"] == "N"
    assert exif["GPSInfo"]["GPSLongitudeRef"] == "E"
    assert exif["GPSInfo"]["GPSLatitude"] == [31.0, 37.0, 30.0]
    assert exif["GPSInfo"]["2"] == [31.0, 37.0, 30.0]


def test_parse_canon_afinfo2_resolves_tiff_relative_offsets() -> None:
    """Canon AFInfo2 value offsets are relative to the EXIF TIFF header."""
    af_payload = b"".join(
        [
            struct.pack("<6H", 12, 9, 1, 1, 1000, 500),
            struct.pack("<h", 20),  # width
            struct.pack("<h", 20),  # height
            struct.pack("<h", 100),  # x, center-relative
            struct.pack("<h", -50),  # y, center-relative
            struct.pack("<H", 1),  # in-focus bitmask
            struct.pack("<H", 1),  # selected bitmask
        ]
    )
    makernote_tiff_offset = 400
    afinfo_tiff_offset = 1000
    afinfo_makernote_offset = afinfo_tiff_offset - makernote_tiff_offset
    makernote = bytearray(afinfo_makernote_offset + len(af_payload))
    struct.pack_into("<H", makernote, 0, 1)
    struct.pack_into("<HHII", makernote, 2, 0x0026, 3, len(af_payload) // 2, afinfo_tiff_offset)
    makernote[afinfo_makernote_offset:] = af_payload

    af = _parse_canon_afinfo2(
        bytes(makernote),
        image_width=2000,
        image_height=1000,
        makernote_tiff_offset=makernote_tiff_offset,
    )

    assert af is not None
    assert af["kind"] == "point"
    assert af["center"]["x"] == pytest.approx(1200)
    assert af["center"]["y"] == pytest.approx(400)
    assert af["focused_count"] == 1
    assert af["selected_count"] == 1


def test_parse_canon_afinfo2_preserves_area_and_focused_points() -> None:
    """区域 AF 不能被压成一个中心点，应保留区域框和合焦点列表。"""
    af_payload = b"".join(
        [
            struct.pack("<6H", 12, 9, 4, 4, 1000, 500),
            struct.pack("<4h", 20, 20, 20, 20),  # point widths
            struct.pack("<4h", 20, 20, 20, 20),  # point heights
            struct.pack("<4h", -100, 0, 100, 0),  # x positions
            struct.pack("<4h", 0, -100, 0, 100),  # y positions
            struct.pack("<H", 0b0110),  # in-focus points
            struct.pack("<H", 0b1111),  # selected AF area
        ]
    )
    makernote_tiff_offset = 400
    afinfo_tiff_offset = 1000
    afinfo_makernote_offset = afinfo_tiff_offset - makernote_tiff_offset
    makernote = bytearray(afinfo_makernote_offset + len(af_payload))
    struct.pack_into("<H", makernote, 0, 1)
    struct.pack_into("<HHII", makernote, 2, 0x0026, 3, len(af_payload) // 2, afinfo_tiff_offset)
    makernote[afinfo_makernote_offset:] = af_payload

    af = _parse_canon_afinfo2(
        bytes(makernote),
        image_width=2000,
        image_height=1000,
        makernote_tiff_offset=makernote_tiff_offset,
    )

    assert af is not None
    assert af["kind"] == "expanded"
    assert af["focused_count"] == 2
    assert af["selected_count"] == 4
    assert len(af["focused_points"]) == 2
    assert len(af["selected_points"]) == 4
    assert af["bounds"]["x1"] < af["center"]["x"] < af["bounds"]["x2"]
    assert af["bounds"]["y1"] < af["center"]["y"] < af["bounds"]["y2"]


def test_probe_extracts_canon_r5m2_af_point_when_local_fixture_exists() -> None:
    """Regression fixture for the user's Canon EOS R5m2 JPG batch."""
    fixture = Path(
        "/Users/wlfcss/Desktop/workspace/lingjian-v2/benchmark/results/new1/5Y3A7177.JPG"
    )
    if not fixture.exists():
        pytest.skip("local Canon R5m2 fixture is not available")

    meta = _probe_image_meta(fixture)
    exif = json.loads(str(meta.get("exif_json") or "{}"))
    af = exif.get("af_point")
    af_area = exif.get("af_area")

    assert isinstance(af, dict)
    assert af["x"] == pytest.approx(4096)
    assert af["y"] == pytest.approx(2732)
    assert isinstance(af_area, dict)
    assert af_area["center"]["x"] == pytest.approx(4096)
    assert af_area["center"]["y"] == pytest.approx(2732)


class TestScanLibrary:
    async def test_scan_empty_dir(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "empty"
        root.mkdir()
        report = await scan_library(db, "lib-test", root)
        assert report.added == 0
        assert report.updated == 0
        assert report.unchanged == 0

    async def test_adds_supported_files(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "library"
        _make_jpeg(root / "a.jpg")
        _make_jpeg(root / "b.jpeg")
        # 不支持的格式应该被跳过
        (root / "readme.txt").write_text("hello")

        report = await scan_library(db, "lib-test", root)
        assert report.added == 2
        assert report.errors == []

        async with db.conn.execute(
            "SELECT COUNT(*) FROM photos WHERE library_id = 'lib-test'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row[0] == 2

    async def test_recursive_flag(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        _make_jpeg(root / "top.jpg")
        _make_jpeg(root / "sub" / "deep.jpg")

        report_flat = await scan_library(
            db,
            "lib-test",
            root,
            recursive=False,
        )
        assert report_flat.added == 1  # 只有 top.jpg

        # 再跑一次 recursive=True 应新增 1 张（deep.jpg）
        report_recursive = await scan_library(db, "lib-test", root, recursive=True)
        assert report_recursive.added == 1  # 仅新增深层那张
        assert report_recursive.unchanged == 1

    async def test_width_height_populated(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        _make_jpeg(root / "photo.jpg", size=(320, 240))
        await scan_library(db, "lib-test", root)

        async with db.conn.execute(
            "SELECT width, height FROM photos WHERE library_id = 'lib-test'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["width"] == 320
        assert row["height"] == 240


class TestIncrementalScan:
    async def test_unchanged_file_skipped(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        _make_jpeg(root / "a.jpg")

        first = await scan_library(db, "lib-test", root)
        assert first.added == 1

        second = await scan_library(db, "lib-test", root)
        assert second.added == 0
        assert second.unchanged == 1

    async def test_modified_file_updates_and_clears_hash(
        self,
        db: Database,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "lib"
        path = root / "a.jpg"
        _make_jpeg(path, size=(100, 100))

        await scan_library(db, "lib-test", root)
        # 模拟哈希已写入
        await db.conn.execute(
            "UPDATE photos SET file_hash = ? WHERE file_path = ?",
            ("deadbeef", str(path)),
        )
        await db.conn.commit()

        # 改文件尺寸 + 手动调 mtime，避免 async 环境里的 sleep
        _make_jpeg(path, size=(200, 200))
        import os

        st = path.stat()
        # 把 mtime 往前拨 10 秒，保证与之前记录的 mtime 字符串不同
        os.utime(path, (st.st_atime, st.st_mtime + 10))

        report = await scan_library(db, "lib-test", root)
        assert report.updated == 1
        assert report.added == 0

        # hash 应被清空（等阶段 2 重算）
        async with db.conn.execute(
            "SELECT file_hash, width FROM photos WHERE file_path = ?",
            (str(path),),
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["file_hash"] is None
        assert row["width"] == 200


class TestBackfillHashes:
    async def test_fills_null_hashes(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        p1 = root / "a.jpg"
        p2 = root / "b.jpg"
        _make_jpeg(p1)
        _make_jpeg(p2)

        await scan_library(db, "lib-test", root)
        # 阶段 1 后 hash 应为 NULL
        async with db.conn.execute("SELECT COUNT(*) FROM photos WHERE file_hash IS NULL") as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row[0] == 2

        count = await backfill_hashes(db, "lib-test")
        assert count == 2

        # 每个 hash 匹配实际文件内容
        expected1 = hashlib.sha256(p1.read_bytes()).hexdigest()
        async with db.conn.execute(
            "SELECT file_hash FROM photos WHERE file_path = ?",
            (str(p1),),
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["file_hash"] == expected1

    async def test_backfill_idempotent(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        _make_jpeg(root / "a.jpg")
        await scan_library(db, "lib-test", root)
        first = await backfill_hashes(db, "lib-test")
        second = await backfill_hashes(db, "lib-test")
        assert first == 1
        assert second == 0  # 没有 NULL hash 的照片了

    async def test_missing_file_skipped(
        self,
        db: Database,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "lib"
        path = root / "a.jpg"
        _make_jpeg(path)
        await scan_library(db, "lib-test", root)

        # 先删掉文件
        path.unlink()

        count = await backfill_hashes(db, "lib-test")
        # 文件消失不报错，只是 hash 仍为 NULL
        assert count == 0
