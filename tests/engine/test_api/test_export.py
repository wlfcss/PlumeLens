"""Tests for real library export endpoints."""

from __future__ import annotations

import asyncio
import io
import json
import threading
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock
from xml.etree import ElementTree

import pytest
from anyio import Path as AsyncPath
from httpx import ASGITransport, AsyncClient, Response
from PIL import Image

MINIMAL_JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"
XMP_NAMESPACES = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "xmp": "http://ns.adobe.com/xap/1.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "lr": "http://ns.adobe.com/lightroom/1.0/",
    "crs": "http://ns.adobe.com/camera-raw-settings/1.0/",
    "xmpMM": "http://ns.adobe.com/xap/1.0/mm/",
    "evt": "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#",
    "customer": "urn:customer:metadata",
}


def _app1(payload: bytes) -> bytes:
    return b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload


def _jpeg_xmp_packet(image: bytes) -> tuple[bytes, bytes]:
    offset = image.index(XMP_HEADER)
    length = int.from_bytes(image[offset - 2 : offset], "big")
    end = offset + length - 2
    return image[offset + len(XMP_HEADER) : end], image[: offset - 4] + image[end:]


def _write_file(path: Path, body: bytes = b"photo") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)


async def _await_job(
    client: AsyncClient, job_id: str, wait_seconds: float = 10.0
) -> dict[str, Any]:
    """轮询 job 快照直到终态。"""
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while asyncio.get_running_loop().time() < deadline:
        snapshot = (await client.get(f"/export/jobs/{job_id}")).json()
        if snapshot["status"] != "running":
            return snapshot
        await asyncio.sleep(0.01)
    msg = f"export job {job_id} did not finish within {wait_seconds}s"
    raise AssertionError(msg)


async def _await_export(client: AsyncClient, started: Response) -> dict[str, Any]:
    """POST 只返回 job 句柄 —— 等后台 worker 跑完并断言成功,返回最终 result。"""
    assert started.status_code == 200, started.text
    snapshot = await _await_job(client, started.json()["job_id"])
    assert snapshot["status"] == "succeeded", snapshot
    assert snapshot["result"] is not None
    return snapshot["result"]


@pytest.fixture
async def export_client(tmp_path: Path):
    from engine.core.config import settings
    from engine.core.database import Database
    from engine.main import create_app

    settings.data_dir = tmp_path
    app = create_app()
    db = Database(tmp_path / "export.db")
    await db.connect()
    app.state.db = db
    app.state.pipeline = MagicMock()

    root = tmp_path / "source"
    _write_file(root / "a.jpg", b"jpg-a")
    _write_file(root / "a.CR3", b"raw-a")
    _write_file(root / "sub" / "b.jpg", b"jpg-b")
    _write_file(root / "reject.jpg", b"jpg-reject")
    _write_file(root / "missing-companion.jpg", b"jpg-missing-companion")

    await db.conn.execute(
        "INSERT INTO libraries "
        "(id, display_name, parent_path, root_path, created_at, last_opened_at) "
        "VALUES ('lib-export', 'Export Test', ?, ?, '2026-05-05', '2026-05-05')",
        (str(tmp_path), str(root)),
    )
    photos = [
        ("p1", root / "a.jpg", None, "select", 0.91, "须浮鸥"),
        ("p2", root / "sub" / "b.jpg", None, "reject", 0.72, "翠鸟"),
        ("p3", root / "reject.jpg", None, "reject", 0.2, "白鹭"),
        ("p4", root / "missing.jpg", None, "select", 0.8, "苍鹭"),
        (
            "p5",
            root / "missing-companion.jpg",
            root / "missing-companion.CR3",
            "record",
            0.63,
            "灰喜鹊",
        ),
    ]
    for idx, (pid, path, companion, grade, score, species) in enumerate(photos):
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, file_hash, "
            "exif_json, companion_path, created_at, library_id) "
            "VALUES (?, ?, ?, 100, ?, ?, ?, ?, '2026-05-05', 'lib-export')",
            (
                pid,
                str(path),
                path.name,
                f"2026-05-05T09:0{idx}:00",
                f"hash-{pid}",
                json.dumps({"DateTimeOriginal": f"2026:05:05 09:0{idx}:00"}),
                str(companion) if companion is not None else None,
            ),
        )
        await db.conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, result_json, "
            "quality_score, grade, bird_count, species, created_at, is_active) "
            "VALUES (?, ?, 'v1', ?, ?, ?, 1, ?, '2026-05-05', 1)",
            (
                f"ar-{pid}",
                pid,
                json.dumps({"bird_count": 1, "best": None, "detections": []}),
                score,
                grade,
                species,
            ),
        )
    await db.conn.execute(
        "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
        "VALUES ('p2', 'usable', '2026-05-05')"
    )
    await db.conn.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, root
    # job 注册表是模块级全局 —— 不清会让"同一 library 已有导出在跑"的并发检查
    # 泄漏到后续测试。
    from engine.services import exporter as exporter_module

    exporter_module._JOBS.clear()
    await db.close()


async def test_export_copies_selected_photos_companions_and_manifest(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, root = export_client
    target = tmp_path / "exports"
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "grades": ["select", "usable"],
            "min_score": 50,
            "include_companions": True,
            "preserve_structure": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    assert data["selected_count"] == 3
    assert data["exported_count"] == 2
    assert data["companion_count"] == 1
    assert data["skipped_missing"] == 1
    assert data["failed_count"] == 0

    output_dir = AsyncPath(data["output_dir"])
    assert await output_dir.is_dir()
    assert await (output_dir / "a.jpg").read_bytes() == b"jpg-a"
    assert await (output_dir / "a.CR3").read_bytes() == b"raw-a"
    assert await (output_dir / "sub" / "b.jpg").read_bytes() == b"jpg-b"
    assert not await (output_dir / "reject.jpg").exists()

    manifest_path = AsyncPath(data["manifest"]["json"])
    manifest = json.loads(await manifest_path.read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["导出布局"] == "合并导出（文件夹 / 照片）"
    assert manifest["导出摘要"]["选择评级"] == ["精选", "可用"]
    rows = manifest["照片清单"]
    assert len(rows) == 3
    assert manifest["导出摘要"]["源图库路径"] == "(已脱敏)"
    assert str(root) not in json.dumps(manifest, ensure_ascii=False)
    p1 = next(row for row in rows if row["照片ID"] == "p1")
    assert p1["源文件路径"] == "a.jpg"
    p2 = next(row for row in rows if row["照片ID"] == "p2")
    assert p2["评级"] == "可用"
    assert p2["自动评级"] == "淘汰"
    assert p2["人工决策"] == "可用"
    assert p2["源文件路径"] == "sub/b.jpg"
    assert p2["源文件夹"] == "sub"
    p4 = next(row for row in rows if row["照片ID"] == "p4")
    assert p4["错误原因"] == "源文件不存在"


async def test_export_rejects_missing_source_root(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, root = export_client
    await AsyncPath(root).rename(root.with_name("source-moved"))
    target = tmp_path / "exports-missing-root"

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "grades": ["select"],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "source_path_missing"
    assert not await AsyncPath(target).exists()


async def test_export_recovers_path_missing_when_source_root_returns(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, root = export_client
    target = tmp_path / "exports-restored-root"
    moved = root.with_name("source-temporarily-moved")

    await AsyncPath(root).rename(moved)
    failed = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "grades": ["select"],
        },
    )
    assert failed.status_code == 400
    await AsyncPath(moved).rename(root)

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "grades": ["select"],
            "include_manifest": False,
        },
    )

    await _await_export(client, response)
    detail = await client.get("/library/lib-export")
    assert detail.json()["library"]["status"] == "ready"


async def test_export_can_generate_xmp_sidecars_next_to_exported_files(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select"],
            "include_companions": True,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["selected_count"] == 2
    assert data["exported_count"] == 1
    assert data["companion_count"] == 1
    assert data["xmp_count"] == 1
    xmp = await (output_dir / "a.xmp").read_text(encoding="utf-8")
    assert 'xmp:Rating="5"' in xmp
    assert "须浮鸥" in xmp

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["生成XMP文件"] == "是"
    p1 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p1")
    assert p1["已导出XMP"] == "是"
    assert p1["XMP导出路径"].endswith("a.xmp")


async def test_export_embeds_xmp_into_copied_jpeg_for_lightroom(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, root = export_client
    _write_file(root / "sub" / "b.jpg", MINIMAL_JPEG)

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["usable"],
            "include_companions": False,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["selected_count"] == 1
    assert data["exported_count"] == 1
    assert data["xmp_count"] == 1

    exported_jpeg = output_dir / "sub" / "b.jpg"
    assert await exported_jpeg.exists()
    assert not await (output_dir / "sub" / "b.xmp").exists()

    jpeg_bytes = await exported_jpeg.read_bytes()
    assert b"http://ns.adobe.com/xap/1.0/\x00" in jpeg_bytes
    assert b'xmp:Rating="4"' in jpeg_bytes
    assert "翠鸟".encode() in jpeg_bytes

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    p2 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p2")
    assert p2["已导出XMP"] == "是"
    assert Path(p2["XMP导出路径"]).parts[-2:] == ("sub", "b.jpg")


@pytest.mark.parametrize("rating_form", ["attribute", "element"])
async def test_export_merges_existing_jpeg_xmp_without_changing_other_metadata_or_pixels(
    export_client: tuple[AsyncClient, Path], tmp_path: Path, rating_form: str
) -> None:
    client, root = export_client
    rating_attribute = 'basic:Rating="2"' if rating_form == "attribute" else ""
    rating_element = "<basic:Rating>2</basic:Rating>" if rating_form == "element" else ""
    existing = f'''<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <r:RDF xmlns:r="{XMP_NAMESPACES["rdf"]}">
    <r:Description r:about="" xmlns:basic="{XMP_NAMESPACES["xmp"]}"
      xmlns:crs="{XMP_NAMESPACES["crs"]}" xmlns:u="{XMP_NAMESPACES["customer"]}"
      xmlns:alias="urn:qualified-value" u:value="alias:Name&#10;line&#9;tab&#13;return"
      basic:CreatorTool="Original Editor" basic:Label="Review later" crs:Exposure2012="+0.75"
      {rating_attribute}>
      {rating_element}
    </r:Description>
    <r:Description r:about="" xmlns:terms="{XMP_NAMESPACES["dc"]}"
      xmlns:layers="{XMP_NAMESPACES["lr"]}" xmlns:doc="{XMP_NAMESPACES["xmpMM"]}"
      xmlns:event="{XMP_NAMESPACES["evt"]}">
      <terms:description>
        <r:Alt><r:li xml:lang="x-default">原始标题</r:li></r:Alt>
      </terms:description>
      <terms:subject><Bag xmlns="{XMP_NAMESPACES["rdf"]}">
        <li>作者 &amp; 关键字</li><li>翠鸟</li><li>PlumeLens</li>
      </Bag></terms:subject>
      <layers:hierarchicalSubject><r:Bag><r:li>观察|河流</r:li></r:Bag></layers:hierarchicalSubject>
      <doc:History><r:Seq><r:li r:parseType="Resource">
        <event:action>saved</event:action>
      </r:li></r:Seq></doc:History>
    </r:Description>
  </r:RDF>
</x:xmpmeta>
<?xpacket end="w"?>'''
    encoded = existing.encode("utf-8" if rating_form == "attribute" else "utf-16")
    image = io.BytesIO()
    exif = Image.Exif()
    exif[270] = "Original EXIF"
    Image.new("RGB", (8, 11), (82, 116, 190)).save(
        image, format="JPEG", progressive=True, exif=exif
    )
    jpeg = image.getvalue()
    source = root / "sub" / "b.jpg"
    source_bytes = jpeg[:2] + _app1(XMP_HEADER + encoded) + jpeg[2:]
    _write_file(source, source_bytes)

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "导出 & archive"),
            "grades": ["usable"],
            "include_companions": False,
            "include_xmp_sidecars": True,
        },
    )
    result = await _await_export(client, response)
    assert result["exported_count"] == result["xmp_count"] == 1
    output = Path(result["output_dir"]) / "sub" / "b.jpg"
    exported = output.read_bytes()
    merged_packet, outside_packet = _jpeg_xmp_packet(exported)
    assert not output.with_suffix(".xmp").exists()
    assert source.read_bytes() == source_bytes
    assert exported.count(XMP_HEADER) == 1
    assert outside_packet == jpeg  # Includes Exif, progressive scan data and marker order.
    assert b'xmlns:alias="urn:qualified-value"' in merged_packet
    with Image.open(io.BytesIO(source_bytes)) as src, Image.open(output) as dst:
        assert src.tobytes() == dst.tobytes()
        assert dst.getexif()[270] == "Original EXIF"

    ns = XMP_NAMESPACES
    tree = ElementTree.fromstring(merged_packet)
    descriptions = tree.findall("rdf:RDF/rdf:Description", ns)
    rating = descriptions[0].get(f"{{{ns['xmp']}}}Rating")
    if rating_form == "element":
        rating = descriptions[0].findtext("xmp:Rating", namespaces=ns)
    assert rating == "4"
    assert descriptions[0].get(f"{{{ns['xmp']}}}CreatorTool") == "Original Editor"
    assert descriptions[0].get(f"{{{ns['xmp']}}}Label") == "Review later"
    assert descriptions[0].get(f"{{{ns['crs']}}}Exposure2012") == "+0.75"
    assert descriptions[0].get(f"{{{ns['customer']}}}value") == "alias:Name\nline\ttab\rreturn"
    assert descriptions[1].findtext("dc:description/rdf:Alt/rdf:li", namespaces=ns) == "原始标题"
    assert descriptions[1].findtext("xmpMM:History/rdf:Seq/rdf:li/evt:action", namespaces=ns) == (
        "saved"
    )
    assert [item.text for item in descriptions[1].findall("dc:subject/rdf:Bag/rdf:li", ns)] == [
        "作者 & 关键字",
        "翠鸟",
        "PlumeLens",
        "评级:可用",
        "鸟种:翠鸟",
        "鸟数量:1",
    ]
    assert [
        item.text for item in descriptions[1].findall("lr:hierarchicalSubject/rdf:Bag/rdf:li", ns)
    ] == ["观察|河流", "PlumeLens", "PlumeLens|可用"]


def _unsafe_xmp_segments(case: str) -> bytes:
    root = f'<rdf:RDF xmlns:rdf="{XMP_NAMESPACES["rdf"]}">'.encode()
    head = root + b'<rdf:Description rdf:about="" xmlns:u="urn:customer:metadata" u:data="'
    tail = b'"/></rdf:RDF>'
    standard = _app1(XMP_HEADER + head + b"preserve me" + tail)
    if case == "extended":
        return standard + _app1(b"http://ns.adobe.com/xmp/extension/\x00" + b"x" * 120)
    if case == "extended_reference":
        return _app1(
            XMP_HEADER
            + root
            + (
                b'<rdf:Description rdf:about="" xmlns:n="http://ns.adobe.com/xmp/note/" '
                b'n:HasExtendedXMP="0123456789ABCDEF0123456789ABCDEF"/></rdf:RDF>'
            )
        )
    if case == "duplicate":
        return standard + standard
    if case == "oversized":
        limit = 0xFFFF - 2 - len(XMP_HEADER)
        return _app1(XMP_HEADER + head + b"x" * (limit - len(head) - len(tail)) + tail)
    if case == "doctype":
        packet = (
            '<!DOCTYPE rdf:RDF [<!ENTITY entry "read me">]>'
            + root.decode()
            + ("<rdf:Description>&entry;</rdf:Description></rdf:RDF>")
        )
        return _app1(XMP_HEADER + packet.encode("utf-16"))
    return _app1(XMP_HEADER + b"<RDF><broken>")


@pytest.mark.parametrize(
    "case", ["malformed", "extended", "extended_reference", "duplicate", "oversized", "doctype"]
)
async def test_export_preserves_unmergeable_jpeg_xmp_and_reports_skipped_metadata(
    export_client: tuple[AsyncClient, Path], tmp_path: Path, case: str
) -> None:
    client, root = export_client
    photo_path = root / "sub" / "b.jpg"
    original = MINIMAL_JPEG[:2] + _unsafe_xmp_segments(case) + MINIMAL_JPEG[2:]
    _write_file(photo_path, original)

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["usable"],
            "include_companions": False,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )
    assert response.status_code == 200, response.text
    job = await _await_job(client, response.json()["job_id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "partial_export"
    result = job["result"]
    assert result["exported_count"] == result["failed_count"] == 1
    assert result["xmp_count"] == 0
    output = Path(result["output_dir"]) / "sub" / "b.jpg"
    assert output.read_bytes() == photo_path.read_bytes() == original
    assert not output.with_suffix(".xmp").exists()
    report = json.loads(await AsyncPath(result["manifest"]["json"]).read_text(encoding="utf-8"))
    row = report["照片清单"][0]
    assert row["已导出照片"] == "是"
    assert row["已导出XMP"] == "否"
    assert "保留原有 XMP" in row["错误原因"]


async def test_export_with_raw_companion_keeps_existing_jpeg_xmp_intact(
    export_client: tuple[AsyncClient, Path], tmp_path: Path
) -> None:
    client, root = export_client
    # The JPEG is copied unchanged even if its packet cannot be merged. The
    # requested metadata belongs to the exported RAW sidecar in this mode.
    source = root / "a.jpg"
    original = MINIMAL_JPEG[:2] + _unsafe_xmp_segments("extended") + MINIMAL_JPEG[2:]
    _write_file(source, original)
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select"],
            "include_companions": True,
            "include_xmp_sidecars": True,
        },
    )
    result = await _await_export(client, response)
    assert result["exported_count"] == result["companion_count"] == result["xmp_count"] == 1
    output = Path(result["output_dir"])
    assert (output / "a.jpg").read_bytes() == source.read_bytes() == original
    assert (output / "a.CR3").read_bytes() == b"raw-a"
    assert 'xmp:Rating="5"' in (output / "a.xmp").read_text(encoding="utf-8")


async def test_export_can_generate_xmp_only_package_without_copying_photos(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["usable"],
            "copy_files": False,
            "include_companions": True,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["selected_count"] == 1
    assert data["exported_count"] == 0
    assert data["companion_count"] == 0
    assert data["xmp_count"] == 1
    assert not await (output_dir / "sub" / "b.jpg").exists()
    xmp = await (output_dir / "sub" / "b.xmp").read_text(encoding="utf-8")
    assert 'xmp:Rating="4"' in xmp
    assert "翠鸟" in xmp

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["复制照片文件"] == "否"
    p2 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p2")
    assert p2["已导出照片"] == "否"
    assert p2["已导出XMP"] == "是"


async def test_export_rejects_empty_content_mode(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "copy_files": False,
            "include_xmp_sidecars": False,
        },
    )

    assert response.status_code == 422


async def test_export_rolls_back_main_file_when_explicit_companion_is_missing(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["record"],
            "include_companions": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["selected_count"] == 1
    assert data["exported_count"] == 0
    assert data["companion_count"] == 0
    assert data["skipped_missing"] == 1
    assert data["failed_count"] == 0
    assert not await (output_dir / "missing-companion.jpg").exists()

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    p5 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p5")
    assert p5["错误原因"] == "同伴文件不存在"
    assert p5["已导出照片"] == "否"


async def test_export_uses_updated_library_alias_for_output_folder(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    renamed = await client.patch(
        "/library/lib-export",
        json={"display_name": "洋湖湿地早晨"},
    )
    assert renamed.status_code == 200

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select"],
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert output_dir.name.startswith("洋湖湿地早晨-")

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["图库名称"] == "洋湖湿地早晨"


async def test_export_can_insert_grade_folders_under_source_folders(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select", "usable"],
            "include_companions": True,
            "layout": "by_grade",
            "preserve_structure": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert await (output_dir / "精选" / "a.jpg").read_bytes() == b"jpg-a"
    assert await (output_dir / "精选" / "a.CR3").read_bytes() == b"raw-a"
    assert await (output_dir / "sub" / "可用" / "b.jpg").read_bytes() == b"jpg-b"
    assert not await (output_dir / "sub" / "b.jpg").exists()

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["导出布局"] == "按评级分类（文件夹 / 评级 / 照片）"
    p2 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p2")
    assert p2["导出相对路径"] == "sub/可用/b.jpg"


async def test_export_rejects_target_inside_source_library(
    export_client: tuple[AsyncClient, Path],
) -> None:
    client, root = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(root / "exports")},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "target_inside_source"


async def test_export_unknown_library_returns_404(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/missing",
        json={"target_dir": str(tmp_path / "exports")},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "library_not_found"


async def test_export_reports_insufficient_space_with_byte_counts(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """空间不足要带上 required/free —— 前端据此渲染"还差多少",而不是一句英文。"""
    client, _ = export_client
    from engine.services import exporter as exporter_module

    class _Usage:
        total = 1_000
        used = 999
        free = 1

    monkeypatch.setattr(exporter_module.shutil, "disk_usage", lambda _p: _Usage())

    response = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(tmp_path / "exports"), "grades": ["select"]},
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "insufficient_space"
    assert detail["free_bytes"] == 1
    assert detail["required_bytes"] > detail["free_bytes"]
    assert not await AsyncPath(tmp_path / "exports").exists()


async def test_export_rejects_second_export_while_one_is_running(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """同一图库只允许一个导出在跑。

    历史 bug:前端 60s 超时报"导出失败",用户重试 → 后台叠加多个导出线程并发
    写同一个卷,互相抢 IO 越跑越慢,看上去就是"一直失败"。
    """
    client, _ = export_client
    from engine.services import exporter as exporter_module

    running = exporter_module.ExportJob(
        job_id="already-running", library_id="lib-export", total=1, total_bytes=1
    )
    exporter_module._register_job(running)

    response = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(tmp_path / "exports"), "grades": ["select"]},
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "export_already_running"
    assert detail["job_id"] == "already-running"


async def test_export_progress_stream_ends_on_terminal_frame(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    started = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(tmp_path / "exports"), "grades": ["select"]},
    )
    assert started.status_code == 200
    job_id = started.json()["job_id"]

    frames: list[dict[str, Any]] = []
    async with client.stream("GET", f"/export/jobs/{job_id}/events") as stream:
        assert stream.status_code == 200
        async for line in stream.aiter_lines():
            if line.startswith("data: "):
                frames.append(json.loads(line[len("data: ") :]))
                if frames[-1]["status"] != "running":
                    break

    assert frames, "expected at least one SSE frame"
    terminal = frames[-1]
    assert terminal["status"] == "succeeded"
    assert terminal["job_id"] == job_id
    assert terminal["result"]["exported_count"] == 1
    assert terminal["result"]["manifest"]["json"] is not None


async def test_export_cancel_marks_job_cancelled(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    from engine.services import exporter as exporter_module

    running = exporter_module.ExportJob(
        job_id="cancel-me", library_id="lib-export", total=5, total_bytes=5
    )
    exporter_module._register_job(running)

    response = await client.post("/export/jobs/cancel-me/cancel")

    assert response.status_code == 200
    assert running.is_cancelled

    missing = await client.post("/export/jobs/nope/cancel")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "job_not_found"


async def test_export_formats_lists_source_extensions_with_sizes(
    export_client: tuple[AsyncClient, Path],
) -> None:
    client, _ = export_client
    response = await client.get("/export/library/lib-export/formats")

    assert response.status_code == 200
    formats = {item["ext"]: item for item in response.json()["formats"]}
    # 主文件 4 张 jpg + 1 张 missing.jpg;同伴一条 CR3(p5 的 companion_path)
    assert formats["JPG"]["count"] == 5
    assert formats["JPG"]["is_raw"] is False
    assert formats["CR3"]["count"] == 1
    assert formats["CR3"]["is_raw"] is True
    # 体积降序 —— 用户最想砍掉的那种排最前
    sizes = [item["bytes"] for item in response.json()["formats"]]
    assert sizes == sorted(sizes, reverse=True)

    missing = await client.get("/export/library/nope/formats")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "library_not_found"


async def test_export_formats_filter_skips_unselected_extensions(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """只勾 CR3 时:JPG 主文件跳过,配套 CR3 仍然要导出。"""
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select"],
            "formats": ["CR3"],
            "include_companions": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["exported_count"] == 0, "JPG 主文件不在白名单内,不该导出"
    assert data["companion_count"] == 1
    assert await (output_dir / "a.CR3").read_bytes() == b"raw-a"
    assert not await (output_dir / "a.jpg").exists()


async def test_export_formats_filter_can_keep_jpg_only(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """只勾 JPG —— 这正是"磁盘装不下 RAW"时用户要的那条路。"""
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select"],
            "formats": ["JPG"],
            "include_companions": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["exported_count"] == 1
    assert data["companion_count"] == 0
    assert await (output_dir / "a.jpg").read_bytes() == b"jpg-a"
    assert not await (output_dir / "a.CR3").exists()


async def test_export_formats_filter_excludes_photos_with_known_mismatched_pair(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """主文件与同伴都确定不在白名单里的照片,直接不进选中集合。

    "确定"是关键 —— p5 的 companion_path 在库里有记录(.CR3),选 NEF 时可以当场
    判定排除;而 p1/p2/p4 的 companion_path 为空(老库形态),同伴要靠磁盘探测才
    知道,只能先放行、到复制阶段再按真实扩展名过滤,最终一个文件都不会导出。
    """
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select", "usable", "record"],
            "formats": ["NEF"],
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    assert data["exported_count"] == 0
    assert data["companion_count"] == 0

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    photo_ids = {row["照片ID"] for row in manifest["照片清单"]}
    assert "p5" not in photo_ids, "companion_path 已知且不匹配,应当场排除"


async def test_export_formats_ignored_for_xmp_only_mode(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """xmp_only 导的是 sidecar,与源文件格式无关 —— 不能因为没勾格式就漏掉照片。"""
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["usable"],
            "formats": ["NEF"],
            "copy_files": False,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    assert data["selected_count"] == 1
    assert data["xmp_count"] == 1


def test_estimate_drops_when_raw_companions_are_disabled(tmp_path: Path) -> None:
    """关掉 RAW 同伴后预估体积必须真的下降。

    这是"目标磁盘空间不足"时用户唯一的自救手段 —— 实测 964 张里 JPG 只占
    25 GB,配套 CR3 却有 56 GB,不给关就等于强制 3.4 倍体积。
    """
    from engine.api.schemas.export import ExportLibraryRequest
    from engine.services.exporter import ExportPhoto, _estimate_export_bytes

    root = tmp_path / "src"
    _write_file(root / "a.jpg", b"x" * 1_000)
    _write_file(root / "a.CR3", b"y" * 9_000)
    photo = ExportPhoto(
        id="p1",
        file_path=str(root / "a.jpg"),
        file_name="a.jpg",
        file_mtime="2026-05-05T09:00:00",
        exif_json=None,
        companion_path=str(root / "a.CR3"),
        decision="select",
        grade="select",
        quality_score=0.9,
        bird_count=1,
        species=None,
    )

    def _body(include_companions: bool) -> ExportLibraryRequest:
        return ExportLibraryRequest(
            target_dir=str(tmp_path / "dst"),
            grades=["select"],
            include_companions=include_companions,
        )

    with_raw = _estimate_export_bytes([photo], _body(True))
    without_raw = _estimate_export_bytes([photo], _body(False))

    assert with_raw == int(10_000 * 1.05)
    assert without_raw == int(1_000 * 1.05)
    assert without_raw < with_raw


def test_run_export_stops_at_cancel_checkpoint_without_partial_files(
    tmp_path: Path,
) -> None:
    """取消位在开跑前就置上 → 一张都不复制,且不留半截文件。

    检查点在照片之间(shutil.copy2 不可中断),所以取消永远落在文件边界上 ——
    产出要么是完整文件,要么根本不存在。
    """
    from engine.api.schemas.export import ExportLibraryRequest
    from engine.services.exporter import ExportJob, ExportPhoto, _run_export

    root = tmp_path / "src"
    _write_file(root / "a.jpg", b"jpg-a")
    _write_file(root / "b.jpg", b"jpg-b")
    photos = [
        ExportPhoto(
            id=f"p{i}",
            file_path=str(root / name),
            file_name=name,
            file_mtime="2026-05-05T09:00:00",
            exif_json=None,
            companion_path=None,
            decision="select",
            grade="select",
            quality_score=0.9,
            bird_count=1,
            species=None,
        )
        for i, name in enumerate(("a.jpg", "b.jpg"))
    ]
    target = tmp_path / "dst"
    job = ExportJob(job_id="j", library_id="lib", total=2, total_bytes=0)
    job.cancel()

    result = _run_export(
        library_id="lib",
        library_name="Lib",
        root_path=str(root),
        target_dir=str(target),
        photos=photos,
        body=ExportLibraryRequest(target_dir=str(target), grades=["select"]),
        job=job,
    )

    assert result.exported_count == 0
    output_dir = Path(result.output_dir)
    copied = [p for p in output_dir.rglob("*") if p.is_file() and p.suffix == ".jpg"]
    assert copied == []
    manifest = json.loads(Path(result.manifest.json_path or "").read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["任务状态"] == "已取消（仅含取消前已导出的部分）"


@pytest.fixture(params=["buffered"])
def selection_summary_mode(request: pytest.FixtureRequest) -> str:
    return str(request.param)


async def _selection_preview(client: AsyncClient, *, mode: str) -> dict[str, Any]:
    """The model says egret; the effective manual identity is kingfisher in reject grade."""
    db = client._transport.app.state.db  # type: ignore[attr-defined]
    bird = {
        "bbox": {"x1": 1, "y1": 2, "x2": 20, "y2": 30, "confidence": 0.9},
        "species": "白鹭",
        "species_latin": "Egretta garzetta",
        "species_candidates": [
            {"canonical_sci": "Egretta garzetta", "recognition_state": "recognized"}
        ],
    }
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE analysis_results SET result_json = ? WHERE photo_id = 'p3'",
            (json.dumps({"bird_count": 1, "best": bird, "detections": [bird]}),),
        )
        await conn.execute(
            "INSERT INTO photo_species_overrides "
            "(photo_id, bird_index, canonical_sci, canonical_zh, updated_at) "
            "VALUES ('p3', 0, 'Alcedo atthis', '普通翠鸟', '2026-11-17')"
        )
    headers = {"Accept": "application/x-ndjson"} if mode == "batches" else None
    detail = await client.get(
        "/library/lib-export?view=summary&include_selection_snapshot=true", headers=headers
    )
    assert detail.status_code == 200, detail.text
    assert ("content-length" in detail.headers) == (mode == "buffered")
    if mode == "batches":
        frames = [json.loads(line) for line in detail.text.splitlines()]
        photos = [photo for batch in frames[1:-1] for photo in batch]
        assert len(photos) == frames[-1]
        summary = frames[0] | {"photos": photos}
    else:
        summary = detail.json()
    assert next(photo["species"] for photo in summary["photos"] if photo["id"] == "p3") == (
        "普通翠鸟"
    )
    query = {"species_keys": ["sci:Alcedo atthis"], "grades": ["reject"]}
    route = "/library/lib-export/selection/query"
    response = await client.post(
        route, params={"projection_revision": summary["projection_revision"]}, json=query
    )
    live = await client.post(route, json=query)
    assert response.status_code == 200, response.text
    assert live.status_code == 200, live.text
    data = response.json()
    assert data == live.json()
    assert data["matched_photo_ids"] == ["p3"]
    return data


async def test_selection_export_uses_frozen_effective_identity_and_exact_members(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    selection_summary_mode: str,
) -> None:
    from engine.services import exporter

    client, _ = export_client
    preview = await _selection_preview(client, mode=selection_summary_mode)
    release = threading.Event()
    original = exporter._run_export

    def delayed_export(**kwargs: Any):
        assert release.wait(5), "test did not release export worker"
        return original(**kwargs)

    monkeypatch.setattr(exporter, "_run_export", delayed_export)
    started = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "out"),
            "scope": "selection",
            "selection_query": preview["query"],
            "projection_revision": preview["projection_revision"],
            # A second export-panel grade must not silently replace current selection.
            "grades": ["select"],
            "min_score": 99,
        },
    )
    assert started.status_code == 200, started.text
    db = client._transport.app.state.db  # type: ignore[attr-defined]
    try:
        async with db.transaction() as conn:
            await conn.execute(
                "UPDATE photo_species_overrides SET canonical_sci = 'Egretta garzetta', "
                "canonical_zh = '白鹭' WHERE photo_id = 'p3'"
            )
            await conn.execute(
                "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
                "VALUES ('p3', 'select', '2026-11-17')"
            )
    finally:
        release.set()
    result = await _await_export(client, started)
    assert result["selected_count"] == result["exported_count"] == 1
    output_dir = AsyncPath(result["output_dir"])
    exported = [path async for path in output_dir.rglob("*.jpg")]
    assert [path.name for path in exported] == ["reject.jpg"]
    assert await exported[0].read_bytes() == b"jpg-reject"
    report = json.loads(await AsyncPath(result["manifest"]["json"]).read_text(encoding="utf-8"))
    assert report["导出摘要"]["导出范围"] == "当前筛选"
    row = report["照片清单"][0]
    assert row["照片ID"] == "p3"
    assert row["物种"] == "普通翠鸟"
    assert row["评级"] == "淘汰"


async def test_selection_export_rejects_changed_preview_before_creating_output(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
    selection_summary_mode: str,
) -> None:
    client, _ = export_client
    preview = await _selection_preview(client, mode=selection_summary_mode)
    db = client._transport.app.state.db  # type: ignore[attr-defined]
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
            "VALUES ('p3', 'select', '2026-11-17')"
        )
    target = tmp_path / "out"
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "scope": "selection",
            "selection_query": preview["query"],
            "projection_revision": preview["projection_revision"],
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "selection_changed"
    assert not target.exists()


async def test_selection_export_requires_explicit_preview_contract(
    export_client: tuple[AsyncClient, Path], tmp_path: Path
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(tmp_path / "out"), "scope": "selection"},
    )
    assert response.status_code == 422


async def test_raw_sidecar_export_merges_existing_xmp_and_preserves_lightroom_edits(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """RAW 同伴存在既有 .xmp 时，保留原有 Lightroom 调色/版权/关键词并去重合并鉴翎评级与鸟种。"""
    client, source_root = export_client
    existing_xmp = (
        '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
        '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"\n'
        '    xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
        '    xmp:Rating="1"\n'
        '    crs:Exposure2012="+0.65"\n'
        '    crs:Highlights2012="-35">\n'
        "   <dc:subject><rdf:Bag>"
        "<rdf:li>洞庭湖</rdf:li>"
        "<rdf:li>PlumeLens:select</rdf:li>"
        "</rdf:Bag></dc:subject>\n"
        "  </rdf:Description>\n"
        " </rdf:RDF>\n"
        "</x:xmpmeta>\n"
        '<?xpacket end="w"?>'
    )
    (source_root / "a.xmp").write_text(existing_xmp, encoding="utf-8")
    source_before = (source_root / "a.xmp").read_bytes()

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select"],
            "formats": ["CR3"],
            "include_companions": True,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )
    data = await _await_export(client, response)
    assert data["companion_count"] == 1
    assert data["xmp_count"] == 1
    assert data["failed_count"] == 0
    assert (source_root / "a.xmp").read_bytes() == source_before

    output_dir = AsyncPath(data["output_dir"])
    merged_text = await (output_dir / "a.xmp").read_text(encoding="utf-8")
    assert 'xmp:Rating="5"' in merged_text
    assert 'crs:Exposure2012="+0.65"' in merged_text
    assert 'crs:Highlights2012="-35"' in merged_text
    assert "<rdf:li>洞庭湖</rdf:li>" in merged_text
    assert merged_text.count("<rdf:li>PlumeLens:select</rdf:li>") == 1


async def test_raw_sidecar_export_preserves_corrupt_xmp_verbatim_and_reports_warning(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """损坏的既有 .xmp 边车不可覆盖破坏，须原样保留并在清单标注未写入新元数据。"""
    client, source_root = export_client
    corrupt_bytes = b"<x:xmpmeta><broken-xml"
    (source_root / "a.xmp").write_bytes(corrupt_bytes)

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports-corrupt"),
            "grades": ["select"],
            "formats": ["CR3"],
            "include_companions": True,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )
    assert response.status_code == 200, response.text
    snapshot = await _await_job(client, response.json()["job_id"])
    assert snapshot["status"] == "failed"
    assert snapshot["error"]["code"] == "partial_export"
    data = snapshot["result"]
    assert data["companion_count"] == 1
    assert data["xmp_count"] == 0
    assert data["failed_count"] == 1

    output_dir = AsyncPath(data["output_dir"])
    assert await (output_dir / "a.xmp").read_bytes() == corrupt_bytes
    report = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    row = next(item for item in report["照片清单"] if item["文件名"] == "a.jpg")
    assert row["已导出XMP"] == "否"
    assert "保留原有 XMP 边车" in row["错误原因"]
