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
    _resolve_pairs,
    backfill_companion_for_library,
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


def _touch(path: Path, content: bytes = b"x") -> None:
    """写一个有内容的占位文件 — _resolve_pairs 只 stat,不解码,所以无需是合法图片。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


class TestPairResolution:
    """`_resolve_pairs` — JPG/RAW 同名 pair 识别。覆盖典型相机输出场景。"""

    def test_jpg_raw_pair_picks_image_as_primary(self, tmp_path: Path) -> None:
        jpg = tmp_path / "IMG_001.JPG"
        cr3 = tmp_path / "IMG_001.CR3"
        _touch(jpg)
        _touch(cr3, b"raw" * 1000)
        primaries, comp = _resolve_pairs([jpg, cr3])
        # JPG 作主 entry,CR3 作 companion
        assert primaries == [jpg]
        info = comp[str(jpg)]
        assert info is not None
        assert info.path == cr3
        assert info.format == "CR3"
        assert info.size == len(b"raw" * 1000)

    def test_raw_only_no_companion(self, tmp_path: Path) -> None:
        cr3 = tmp_path / "IMG_002.CR3"
        _touch(cr3)
        primaries, comp = _resolve_pairs([cr3])
        # 只有 RAW → RAW 作主,无 companion
        assert primaries == [cr3]
        assert comp[str(cr3)] is None

    def test_jpg_only_no_companion(self, tmp_path: Path) -> None:
        jpg = tmp_path / "IMG_003.jpg"
        _touch(jpg)
        primaries, comp = _resolve_pairs([jpg])
        assert primaries == [jpg]
        assert comp[str(jpg)] is None

    def test_case_insensitive_stem_match(self, tmp_path: Path) -> None:
        """相机有时输出 IMG_001.JPG + img_001.cr3 或 .jpg + .CR3 大小写混合。
        stem 比较应忽略大小写。"""
        jpg = tmp_path / "IMG_004.JPG"
        cr3 = tmp_path / "img_004.CR3"  # 注意 stem 大小写不同
        _touch(jpg)
        _touch(cr3)
        primaries, comp = _resolve_pairs([jpg, cr3])
        assert len(primaries) == 1
        assert comp[str(primaries[0])] is not None

    def test_multiple_jpgs_no_pair(self, tmp_path: Path) -> None:
        """同 stem 多 JPG(IMG.jpg + IMG_small.jpg 复制错命名)→ 不识别 pair,各自独立。"""
        jpg1 = tmp_path / "IMG_005.jpg"
        jpg2 = tmp_path / "IMG_005.jpeg"  # 同 stem,不同 ext
        cr3 = tmp_path / "IMG_005.CR3"
        _touch(jpg1)
        _touch(jpg2)
        _touch(cr3)
        primaries, comp = _resolve_pairs([jpg1, jpg2, cr3])
        # 多 IMAGE → 不识别 pair,3 个文件各自独立 entry
        assert sorted(primaries) == sorted([jpg1, jpg2, cr3])
        for p in primaries:
            assert comp[str(p)] is None

    def test_different_dirs_same_stem_not_paired(self, tmp_path: Path) -> None:
        """跨目录同 stem 不该误识别为 pair。"""
        d1 = tmp_path / "day1"
        d2 = tmp_path / "day2"
        jpg = d1 / "IMG_006.JPG"
        cr3 = d2 / "IMG_006.CR3"
        _touch(jpg)
        _touch(cr3)
        primaries, comp = _resolve_pairs([jpg, cr3])
        # 不同目录不 pair
        assert sorted(primaries) == sorted([jpg, cr3])
        assert comp[str(jpg)] is None
        assert comp[str(cr3)] is None

    def test_mixed_pair_and_solo(self, tmp_path: Path) -> None:
        """常见用户场景:有的照片 RAW+JPG,有的只 JPG。"""
        pair_jpg = tmp_path / "IMG_007.JPG"
        pair_cr3 = tmp_path / "IMG_007.CR3"
        solo_jpg = tmp_path / "IMG_008.JPG"
        _touch(pair_jpg)
        _touch(pair_cr3)
        _touch(solo_jpg)
        primaries, comp = _resolve_pairs([pair_jpg, pair_cr3, solo_jpg])
        # 主 entry: pair 的 JPG + solo JPG
        assert sorted(primaries) == sorted([pair_jpg, solo_jpg])
        assert comp[str(pair_jpg)] is not None
        assert comp[str(solo_jpg)] is None


class TestScanLibraryWithCompanion:
    """scan_library 端到端 — companion 字段写入 + change 检测。"""

    async def test_pair_inserts_one_row_with_companion(
        self,
        db: Database,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "lib"
        jpg = root / "IMG_010.JPG"
        cr3 = root / "IMG_010.CR3"
        _make_jpeg(jpg)
        _touch(cr3, b"raw" * 100)

        report = await scan_library(db, "lib-test", root)
        assert report.added == 1  # 关键:只入 1 行,RAW 不再独立

        async with db.conn.execute(
            "SELECT file_path, companion_path, companion_format, companion_size "
            "FROM photos WHERE library_id = ?",
            ("lib-test",),
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["file_path"] == str(jpg)  # JPG 作主
        assert row["companion_path"] == str(cr3)
        assert row["companion_format"] == "CR3"
        assert row["companion_size"] == len(b"raw" * 100)

    async def test_companion_added_later_updates_main_row(
        self,
        db: Database,
        tmp_path: Path,
    ) -> None:
        """先扫到 JPG,后导入 RAW → 第二次 scan 应把 companion 字段补上,不动 file_hash。"""
        root = tmp_path / "lib"
        jpg = root / "IMG_011.JPG"
        _make_jpeg(jpg)
        await scan_library(db, "lib-test", root)
        await backfill_hashes(db, "lib-test")  # 让 hash 有值,后面验它没被清

        # 后导入 RAW
        cr3 = root / "IMG_011.CR3"
        _touch(cr3, b"raw")
        report = await scan_library(db, "lib-test", root)
        assert report.updated == 1
        assert report.added == 0

        async with db.conn.execute(
            "SELECT companion_path, companion_format, file_hash FROM photos "
            "WHERE library_id = ?",
            ("lib-test",),
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["companion_path"] == str(cr3)
        assert row["companion_format"] == "CR3"
        assert row["file_hash"] is not None  # 主文件没动,hash 应保留

    async def test_companion_removed_clears_fields(
        self,
        db: Database,
        tmp_path: Path,
    ) -> None:
        """RAW 同伴被删 → 第二次 scan 应清掉 companion_*,主 entry 保留。"""
        root = tmp_path / "lib"
        jpg = root / "IMG_012.JPG"
        cr3 = root / "IMG_012.CR3"
        _make_jpeg(jpg)
        _touch(cr3)
        await scan_library(db, "lib-test", root)

        cr3.unlink()
        await scan_library(db, "lib-test", root)

        async with db.conn.execute(
            "SELECT companion_path, companion_format, companion_size FROM photos "
            "WHERE library_id = ?",
            ("lib-test",),
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["companion_path"] is None
        assert row["companion_format"] is None
        assert row["companion_size"] is None


class TestBackfillCompanion:
    """`backfill_companion_for_library` — v6→v7 升级后的老库一次性补 companion 字段。"""

    async def test_backfills_existing_pair(
        self,
        db: Database,
        tmp_path: Path,
    ) -> None:
        """模拟老库:DB 有两行(JPG + CR3 各自一行,companion=NULL,这是 v6 行为)。
        backfill 后:JPG 行得到 companion_path 指向 CR3。
        注意:不删 CR3 photo 行(怕丢决策/物种标注),只补主 entry 的字段。"""
        root = tmp_path / "lib"
        jpg = root / "IMG_020.JPG"
        cr3 = root / "IMG_020.CR3"
        _make_jpeg(jpg)
        _touch(cr3, b"raw")
        # 模拟 v6 行为:两个文件各自独立入 photos
        for p in (jpg, cr3):
            await db.conn.execute(
                "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
                "format, created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    f"photo-{p.suffix}",
                    str(p),
                    p.name,
                    p.stat().st_size,
                    "2026-01-01",
                    p.suffix.lstrip(".").upper(),
                    "2026-01-01",
                    "lib-test",
                ),
            )
        await db.conn.commit()

        updated = await backfill_companion_for_library(db, "lib-test")
        assert updated == 1  # 只 JPG 主 entry 被更新

        async with db.conn.execute(
            "SELECT file_path, companion_path FROM photos WHERE library_id = ? "
            "ORDER BY file_path",
            ("lib-test",),
        ) as cur:
            rows = await cur.fetchall()
        # CR3 行: companion 仍 NULL(_resolve_pairs 把 IMAGE 选为主)
        # JPG 行: companion = CR3 path
        by_path = {str(r["file_path"]): r["companion_path"] for r in rows}
        assert by_path[str(jpg)] == str(cr3)
        assert by_path[str(cr3)] is None
