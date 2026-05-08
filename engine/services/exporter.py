# pyright: basic
"""Library export service.

The source library is treated as read-only. Export writes into a newly-created
subdirectory under the user-selected target directory, copies selected source
files, optionally copies JPG/RAW companions, and emits JSON/CSV manifests.
"""

from __future__ import annotations

import asyncio
import csv
import json
import re
import shutil
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape, quoteattr

from engine.api.schemas.export import (
    ExportLayout,
    ExportLibraryRequest,
    ExportLibraryResponse,
    ExportManifestPaths,
)
from engine.core.database import Database
from engine.pipeline.preprocess import IMAGE_EXTENSIONS, RAW_EXTENSIONS


class ExportError(Exception):
    """Raised when an export request is invalid or cannot be completed."""


@dataclass
class ExportPhoto:
    id: str
    file_path: str
    file_name: str
    file_mtime: str
    exif_json: str | None
    companion_path: str | None
    decision: str | None
    grade: str | None
    quality_score: float | None
    bird_count: int | None
    species: str | None


@dataclass
class ExportManifestRow:
    photo_id: str
    file_name: str
    source_path: str
    dest_path: str | None
    companion_source_path: str | None
    companion_dest_path: str | None
    xmp_dest_path: str | None
    grade: str | None
    auto_grade: str | None
    decision: str | None
    quality_score: float | None
    species: str | None
    bird_count: int | None
    shot_at: str
    exported_main: bool
    exported_companion: bool
    exported_xmp: bool
    error: str | None


_CHINESE_MANIFEST_FIELDNAMES = [
    "照片ID",
    "文件名",
    "源文件路径",
    "源文件夹",
    "导出文件路径",
    "导出相对路径",
    "同伴源文件路径",
    "同伴导出路径",
    "XMP导出路径",
    "评级",
    "自动评级",
    "人工决策",
    "质量分",
    "物种",
    "鸟数量",
    "拍摄时间",
    "已导出照片",
    "已导出同伴文件",
    "已导出XMP",
    "错误原因",
]
_GRADE_LABELS: dict[str, str] = {
    "select": "精选",
    "usable": "可用",
    "record": "记录",
    "reject": "淘汰",
}
_LAYOUT_LABELS: dict[ExportLayout, str] = {
    "merged": "合并导出（文件夹 / 照片）",
    "by_grade": "按评级分类（文件夹 / 评级 / 照片）",
}
_RAW_EXTENSION_ORDER = tuple(sorted(RAW_EXTENSIONS))
_ERROR_LABELS: dict[str, str] = {
    "source_missing": "源文件不存在",
    "companion_missing": "同伴文件不存在",
    "insufficient_space": "目标磁盘剩余空间不足",
}
_GRADE_RATINGS: dict[str, int] = {
    "select": 5,
    "usable": 4,
    "record": 3,
    "reject": -1,
}
_GRADE_XMP_LABELS: dict[str, str] = {
    "select": "Green",
    "usable": "Yellow",
    "record": "Blue",
    "reject": "Red",
}
_EXPORT_SPACE_MARGIN = 1.05


def _now_stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%d-%H%M%S")


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^\w.-]+", "_", value.strip(), flags=re.UNICODE).strip("._")
    return cleaned or "PlumeLens_Export"


# Windows-reserved 文件名 — 即使带扩展名 (CON.txt / NUL.jpg) Win32 API 也会
# 路由到设备而不是创建文件,在 Mac 上写出去再 zip 回 Windows 解压会触发"未知错误"
# 跨平台用户偶发踩坑。export 是用户期望"打包送朋友/上传"的场景,所以两端都净化。
_WINDOWS_RESERVED_NAMES = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "COM1",
        "COM2",
        "COM3",
        "COM4",
        "COM5",
        "COM6",
        "COM7",
        "COM8",
        "COM9",
        "LPT1",
        "LPT2",
        "LPT3",
        "LPT4",
        "LPT5",
        "LPT6",
        "LPT7",
        "LPT8",
        "LPT9",
    }
)


def _safe_path_part(value: str, fallback: str = "未命名文件夹") -> str:
    """Sanitize one path component for cross-platform export targets.

    防御点(由用户可控字段进入路径的情形 — 文件名 / 文件夹别名):
      * ``\\0`` null byte — Linux/macOS 路径中合法但会被部分 archiver 当字符串
        终止符截断,导致 zip/tar 内文件提取后路径错位。
      * ``\\x01-\\x1f`` 控制字符 — 同上,部分文件管理器渲染异常。
      * ``/ \\ :`` 路径分隔符 — 导致 ``Path / value`` 实际跨多级目录(目录穿越)。
      * Windows 保留字符 ``< > " | ? *`` — Win32 NTFS 拒绝创建,跨平台导出失败。
      * Windows 保留名 ``CON / PRN / AUX / NUL / COM1-9 / LPT1-9`` — 即使带扩展名也
        被路由到设备文件,文件本身写不出来。
      * 末尾 ``.`` 或 `` `` — Windows 创建后会被静默 trim,跨平台后路径不匹配。
      * ``""`` / ``.`` / ``..`` — 父目录穿越或空段。
    """
    if not value:
        return fallback
    # 1) 删 null + control 字符 (\x00-\x1f, \x7f)
    cleaned = re.sub(r"[\x00-\x1f\x7f]+", "", value)
    # 2) 替换路径分隔符 + Windows 保留符号为下划线
    cleaned = re.sub(r'[/\\:<>"|?*]+', "_", cleaned)
    # 3) 去首尾空白 + 末尾点(Windows 静默 trim)
    cleaned = cleaned.strip().rstrip(" .")
    if cleaned in ("", ".", ".."):
        return fallback
    # 4) Windows 保留名 — 完整(无扩展名)或前缀(带扩展名)都拦
    stem = cleaned.split(".", 1)[0].upper()
    if stem in _WINDOWS_RESERVED_NAMES:
        return f"_{cleaned}"
    return cleaned


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _effective_grade(photo: ExportPhoto) -> str | None:
    return photo.decision or photo.grade


def _score_percent(photo: ExportPhoto) -> float | None:
    if photo.quality_score is None:
        return None
    score = float(photo.quality_score)
    return score * 100 if score <= 1 else score


def _matches_request(photo: ExportPhoto, body: ExportLibraryRequest) -> bool:
    grade = _effective_grade(photo)
    if grade not in body.grades:
        return False
    score = _score_percent(photo)
    if score is not None and body.min_score is not None and score < body.min_score:
        return False
    return not (score is not None and body.max_score is not None and score > body.max_score)


def _parse_json(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _shot_at(photo: ExportPhoto) -> str:
    dto = _parse_json(photo.exif_json).get("DateTimeOriginal")
    if isinstance(dto, str) and dto:
        return dto.replace(":", "-", 2).replace(" ", "T")
    return photo.file_mtime


def _source_parent_rel(source: Path, root: Path, preserve_structure: bool) -> Path:
    if preserve_structure:
        try:
            return source.parent.resolve().relative_to(root)
        except ValueError:
            pass
    return Path()


def _dest_rel(
    source: Path,
    root: Path,
    grade: str | None,
    layout: ExportLayout,
    preserve_structure: bool,
) -> Path:
    grade_label = _GRADE_LABELS.get(grade or "", "未评级")
    file_name = _safe_path_part(source.name, "未命名照片")
    parent_rel = _source_parent_rel(source, root, preserve_structure)
    if layout == "by_grade":
        return parent_rel / grade_label / file_name
    return parent_rel / file_name


def _unique_dest(output_dir: Path, rel: Path, used: set[Path]) -> Path:
    rel = Path(*[part for part in rel.parts if part not in ("", ".", "..")])
    if not rel.parts:
        rel = Path("exported-file")
    candidate = rel
    suffix = 1
    while candidate in used or (output_dir / candidate).exists():
        stem = candidate.stem
        ext = candidate.suffix
        parent = candidate.parent
        candidate = parent / f"{stem}-{suffix}{ext}"
        suffix += 1
    used.add(candidate)
    return output_dir / candidate


def _unique_output_dir(base: Path) -> Path:
    candidate = base
    suffix = 1
    while candidate.exists():
        candidate = base.with_name(f"{base.name}-{suffix}")
        suffix += 1
    return candidate


def _copy_file(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)


def _write_text_file(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _unlink_silent(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _prune_empty_dirs(start: Path, stop: Path) -> None:
    cursor = start
    while cursor != stop and _is_relative_to(cursor, stop):
        try:
            cursor.rmdir()
        except OSError:
            break
        cursor = cursor.parent


def _release_dest(path: Path, output_dir: Path, used: set[Path]) -> None:
    with suppress(ValueError):
        used.discard(path.relative_to(output_dir))


def _existing_parent(path: Path) -> Path:
    cursor = path
    while not cursor.exists() and cursor != cursor.parent:
        cursor = cursor.parent
    return cursor


def _file_size(path: Path | None) -> int:
    if path is None:
        return 0
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _case_exact_existing_path(candidate: Path, inode: tuple[int, int]) -> Path:
    try:
        for child in candidate.parent.iterdir():
            if child.name.lower() != candidate.name.lower():
                continue
            child_stat = child.stat()
            if (child_stat.st_dev, child_stat.st_ino) == inode:
                return child
    except OSError:
        pass
    return candidate


def _discover_companion_path(photo: ExportPhoto, source: Path) -> Path | None:
    if photo.companion_path:
        return Path(photo.companion_path)
    if source.suffix.lower() not in IMAGE_EXTENSIONS:
        return None
    candidates: list[Path] = []
    seen: set[tuple[int, int]] = set()
    for suffix in _RAW_EXTENSION_ORDER:
        for candidate in (source.with_suffix(suffix), source.with_suffix(suffix.upper())):
            try:
                stat = candidate.stat()
            except OSError:
                continue
            inode = (stat.st_dev, stat.st_ino)
            if inode in seen:
                continue
            seen.add(inode)
            candidates.append(_case_exact_existing_path(candidate, inode))
    return candidates[0] if len(candidates) == 1 else None


def _xmp_rating(grade: str | None) -> int:
    return _GRADE_RATINGS.get(grade or "", 0)


def _xmp_label(grade: str | None) -> str:
    return _GRADE_XMP_LABELS.get(grade or "", "None")


def _xmp_sidecar_path(path: Path) -> Path:
    return path.with_suffix(".xmp")


def _xmp_dest_for(output_dir: Path, base: Path, used: set[Path]) -> Path:
    rel = base.relative_to(output_dir) if base.is_absolute() else base
    return _unique_dest(output_dir, _xmp_sidecar_path(rel), used)


def _xmp_keywords(photo: ExportPhoto) -> list[str]:
    grade = _effective_grade(photo)
    keywords = ["PlumeLens", f"评级:{_grade_label(grade) or '未评级'}"]
    if photo.species:
        keywords.extend([photo.species, f"鸟种:{photo.species}"])
    if photo.bird_count is not None:
        keywords.append(f"鸟数量:{photo.bird_count}")
    return list(dict.fromkeys(keyword for keyword in keywords if keyword))


def _xmp_packet(photo: ExportPhoto, source: Path) -> str:
    grade = _effective_grade(photo)
    rating = str(_xmp_rating(grade))
    label = _xmp_label(grade)
    metadata_date = datetime.now(UTC).isoformat()
    subject_items = "\n".join(
        f"        <rdf:li>{escape(keyword)}</rdf:li>" for keyword in _xmp_keywords(photo)
    )
    hierarchical_items = "\n".join(
        f"        <rdf:li>{escape(keyword)}</rdf:li>"
        for keyword in ["PlumeLens", f"PlumeLens|{_grade_label(grade) or '未评级'}"]
    )
    description = f"PlumeLens 导出评级：{_grade_label(grade) or '未评级'}" + (
        f"；鸟种：{photo.species}" if photo.species else ""
    )
    return (
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '    <rdf:Description rdf:about=""\n'
        '      xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
        '      xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
        '      xmlns:lr="http://ns.adobe.com/lightroom/1.0/"\n'
        f"      xmp:Rating={quoteattr(rating)}\n"
        f"      xmp:Label={quoteattr(label)}\n"
        f"      xmp:MetadataDate={quoteattr(metadata_date)}\n"
        f"      xmp:CreatorTool={quoteattr('PlumeLens')}\n"
        f"      xmp:Nickname={quoteattr(source.name)}>\n"
        "      <dc:description>\n"
        "        <rdf:Alt>\n"
        f'          <rdf:li xml:lang="x-default">{escape(description)}</rdf:li>\n'
        "        </rdf:Alt>\n"
        "      </dc:description>\n"
        "      <dc:subject>\n"
        "        <rdf:Bag>\n"
        f"{subject_items}\n"
        "        </rdf:Bag>\n"
        "      </dc:subject>\n"
        "      <lr:hierarchicalSubject>\n"
        "        <rdf:Bag>\n"
        f"{hierarchical_items}\n"
        "        </rdf:Bag>\n"
        "      </lr:hierarchicalSubject>\n"
        "    </rdf:Description>\n"
        "  </rdf:RDF>\n"
        "</x:xmpmeta>\n"
        '<?xpacket end="w"?>\n'
    )


def _estimate_export_bytes(
    selected: list[ExportPhoto],
    body: ExportLibraryRequest,
) -> int:
    total = 0
    for photo in selected:
        source = Path(photo.file_path)
        if body.copy_files:
            total += _file_size(source)
            if body.include_companions:
                total += _file_size(_discover_companion_path(photo, source))
        if body.include_xmp_sidecars:
            total += 16 * 1024
    return int(total * _EXPORT_SPACE_MARGIN)


def _ensure_target_has_space(target: Path, required_bytes: int) -> None:
    if required_bytes <= 0:
        return
    usage_path = _existing_parent(target)
    try:
        free = shutil.disk_usage(usage_path).free
    except OSError:
        return
    if free < required_bytes:
        msg = "Export target does not have enough free space"
        raise ExportError(msg)


def _yes_no(value: bool) -> str:
    return "是" if value else "否"


def _grade_label(value: str | None) -> str | None:
    if value is None:
        return None
    return _GRADE_LABELS.get(value, value)


def _error_label(value: str | None) -> str | None:
    if value is None:
        return None
    if value in _ERROR_LABELS:
        return _ERROR_LABELS[value]
    return f"复制失败：{value}"


def _quality_percent(value: float | None) -> float | None:
    if value is None:
        return None
    score = float(value)
    percent = score * 100 if score <= 1 else score
    return round(percent, 2)


def _rel_to_output(path: str | None, output_dir: Path) -> str | None:
    if path is None:
        return None
    try:
        return str(Path(path).relative_to(output_dir))
    except ValueError:
        return path


def _manifest_row_to_chinese(row: ExportManifestRow, output_dir: Path) -> dict[str, Any]:
    return {
        "照片ID": row.photo_id,
        "文件名": row.file_name,
        "源文件路径": row.source_path,
        "源文件夹": str(Path(row.source_path).parent),
        "导出文件路径": row.dest_path,
        "导出相对路径": _rel_to_output(row.dest_path, output_dir),
        "同伴源文件路径": row.companion_source_path,
        "同伴导出路径": row.companion_dest_path,
        "XMP导出路径": row.xmp_dest_path,
        "评级": _grade_label(row.grade),
        "自动评级": _grade_label(row.auto_grade),
        "人工决策": _grade_label(row.decision),
        "质量分": _quality_percent(row.quality_score),
        "物种": row.species,
        "鸟数量": row.bird_count,
        "拍摄时间": row.shot_at,
        "已导出照片": _yes_no(row.exported_main),
        "已导出同伴文件": _yes_no(row.exported_companion),
        "已导出XMP": _yes_no(row.exported_xmp),
        "错误原因": _error_label(row.error),
    }


def _write_manifests(
    output_dir: Path,
    rows: list[ExportManifestRow],
    summary: dict[str, Any],
) -> tuple[Path, Path]:
    json_path = output_dir / "鉴翎导出报告.json"
    csv_path = output_dir / "鉴翎导出清单.csv"
    with json_path.open("w", encoding="utf-8") as f:
        f.write("{\n")
        f.write(f'  "导出摘要": {json.dumps(summary, ensure_ascii=False, indent=2)},\n')
        f.write('  "照片清单": [\n')
        for index, row in enumerate(rows):
            if index > 0:
                f.write(",\n")
            rendered = json.dumps(_manifest_row_to_chinese(row, output_dir), ensure_ascii=False)
            f.write(f"    {rendered}")
        f.write("\n  ]\n")
        f.write("}\n")
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=_CHINESE_MANIFEST_FIELDNAMES)
        writer.writeheader()
        for row in rows:
            writer.writerow(_manifest_row_to_chinese(row, output_dir))
    return json_path, csv_path


def _run_export(
    *,
    library_id: str,
    library_name: str,
    root_path: str,
    target_dir: str,
    photos: list[ExportPhoto],
    body: ExportLibraryRequest,
) -> ExportLibraryResponse:
    root = Path(root_path).expanduser().resolve()
    target = Path(target_dir).expanduser().resolve()
    if _is_relative_to(target, root):
        msg = "Export target must not be inside the source library"
        raise ExportError(msg)
    # 反向包含同样要拦:target=/Volumes/dst, root=/Volumes/dst/lib 时 target 是 root
    # 的祖先,导出会在祖先目录下创建子目录,虽不直接覆写源文件,但仍违反"导出与源
    # 隔离"的语义。target == root 一并拦下(导出到同一根目录)。
    if target == root or _is_relative_to(root, target):
        msg = "Export target must not contain the source library"
        raise ExportError(msg)

    selected = [photo for photo in photos if _matches_request(photo, body)]
    _ensure_target_has_space(target, _estimate_export_bytes(selected, body))

    output_dir = _unique_output_dir(target / f"{_safe_name(library_name)}-{_now_stamp()}")
    output_dir.mkdir(parents=True, exist_ok=False)

    rows: list[ExportManifestRow] = []
    used: set[Path] = set()
    exported = 0
    companions = 0
    xmp_count = 0
    missing = 0
    failed = 0

    for photo in selected:
        source = Path(photo.file_path)
        dest_path: Path | None = None
        companion_dest: Path | None = None
        companion_source: Path | None = None
        xmp_dest: Path | None = None
        exported_main = False
        exported_companion = False
        exported_xmp = False
        error: str | None = None
        created_paths: list[Path] = []
        try:
            if not source.exists():
                missing += 1
                error = "source_missing"
            else:
                if body.copy_files and body.include_companions:
                    companion_source = _discover_companion_path(photo, source)
                    if photo.companion_path and (
                        companion_source is None or not companion_source.exists()
                    ):
                        error = "companion_missing"
                        missing += 1

                if error is None and body.copy_files:
                    rel = _dest_rel(
                        source,
                        root,
                        _effective_grade(photo),
                        body.layout,
                        body.preserve_structure,
                    )
                    dest_path = _unique_dest(output_dir, rel, used)
                    _copy_file(source, dest_path)
                    created_paths.append(dest_path)
                    exported_main = True

                    if body.include_companions and companion_source and companion_source.exists():
                        comp_rel = _dest_rel(
                            companion_source,
                            root,
                            _effective_grade(photo),
                            body.layout,
                            body.preserve_structure,
                        )
                        companion_dest = _unique_dest(output_dir, comp_rel, used)
                        _copy_file(companion_source, companion_dest)
                        created_paths.append(companion_dest)
                        exported_companion = True

                if error is None and body.include_xmp_sidecars:
                    xmp_source = (
                        companion_source
                        if companion_source is not None and companion_source.exists()
                        else source
                    )
                    if companion_dest is not None:
                        xmp_dest = _xmp_dest_for(output_dir, companion_dest, used)
                    elif dest_path is not None:
                        xmp_dest = _xmp_dest_for(output_dir, dest_path, used)
                    else:
                        xmp_rel = _dest_rel(
                            xmp_source,
                            root,
                            _effective_grade(photo),
                            body.layout,
                            body.preserve_structure,
                        )
                        xmp_dest = _xmp_dest_for(output_dir, xmp_rel, used)
                    _write_text_file(xmp_dest, _xmp_packet(photo, xmp_source))
                    created_paths.append(xmp_dest)
                    exported_xmp = True

                if error is None:
                    if exported_main:
                        exported += 1
                    if exported_companion:
                        companions += 1
                    if exported_xmp:
                        xmp_count += 1
        except Exception as exc:
            for path in reversed(created_paths):
                _unlink_silent(path)
                _release_dest(path, output_dir, used)
                _prune_empty_dirs(path.parent, output_dir)
            failed += 1
            error = str(exc)
            dest_path = None
            companion_dest = None
            xmp_dest = None
            exported_main = False
            exported_companion = False
            exported_xmp = False

        rows.append(
            ExportManifestRow(
                photo_id=photo.id,
                file_name=photo.file_name,
                source_path=photo.file_path,
                dest_path=str(dest_path) if dest_path else None,
                companion_source_path=str(companion_source)
                if companion_source
                else photo.companion_path,
                companion_dest_path=str(companion_dest) if companion_dest else None,
                xmp_dest_path=str(xmp_dest) if xmp_dest else None,
                grade=_effective_grade(photo),
                auto_grade=photo.grade,
                decision=photo.decision,
                quality_score=photo.quality_score,
                species=photo.species,
                bird_count=photo.bird_count,
                shot_at=_shot_at(photo),
                exported_main=exported_main,
                exported_companion=exported_companion,
                exported_xmp=exported_xmp,
                error=error,
            )
        )

    json_path: Path | None = None
    csv_path: Path | None = None
    if body.include_manifest:
        json_path, csv_path = _write_manifests(
            output_dir,
            rows,
            {
                "导出时间": datetime.now(UTC).isoformat(),
                "图库ID": library_id,
                "图库名称": library_name,
                "源图库路径": root_path,
                "目标目录": target_dir,
                "输出目录": str(output_dir),
                "导出布局": _LAYOUT_LABELS[body.layout],
                "复制照片文件": _yes_no(body.copy_files),
                "选择评级": [_GRADE_LABELS.get(grade, grade) for grade in body.grades],
                "最低分": body.min_score,
                "最高分": body.max_score,
                "包含同伴文件": _yes_no(body.include_companions),
                "生成XMP文件": _yes_no(body.include_xmp_sidecars),
                "包含报告": _yes_no(body.include_manifest),
                "选中照片数": len(selected),
                "已导出照片数": exported,
                "已导出同伴文件数": companions,
                "已生成XMP文件数": xmp_count,
                "缺失文件数": missing,
                "失败数": failed,
            },
        )

    return ExportLibraryResponse(
        library_id=library_id,
        output_dir=str(output_dir),
        selected_count=len(selected),
        exported_count=exported,
        companion_count=companions,
        xmp_count=xmp_count,
        skipped_missing=missing,
        failed_count=failed,
        manifest=ExportManifestPaths(
            json=str(json_path) if json_path else None,
            csv=str(csv_path) if csv_path else None,
        ),
    )


async def export_library(
    db: Database,
    library_id: str,
    body: ExportLibraryRequest,
) -> ExportLibraryResponse:
    """Export selected photos from a library."""
    async with db.conn.execute(
        "SELECT id, display_name, root_path, status FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        library = await cur.fetchone()
    if library is None:
        msg = "Library not found"
        raise ExportError(msg)

    root_path = str(library["root_path"])
    if not await asyncio.to_thread(Path(root_path).exists):
        await db.conn.execute(
            "UPDATE libraries SET status = 'path_missing' WHERE id = ?",
            (library_id,),
        )
        await db.conn.commit()
        msg = "Library source path is missing; relink the folder before export"
        raise ExportError(msg)
    if str(library["status"]) == "path_missing":
        await db.conn.execute(
            "UPDATE libraries SET status = 'ready' WHERE id = ?",
            (library_id,),
        )
        await db.conn.commit()

    async with db.conn.execute(
        "SELECT p.id, p.file_path, p.file_name, p.file_mtime, p.exif_json, "
        "p.companion_path, pd.decision, ar.grade, ar.quality_score, ar.bird_count, ar.species "
        "FROM photos p "
        "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "LEFT JOIN photo_decisions pd ON pd.photo_id = p.id "
        "WHERE p.library_id = ? "
        "ORDER BY p.file_mtime ASC",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()

    photos = [
        ExportPhoto(
            id=str(row["id"]),
            file_path=str(row["file_path"]),
            file_name=str(row["file_name"]),
            file_mtime=str(row["file_mtime"]),
            exif_json=(str(row["exif_json"]) if row["exif_json"] is not None else None),
            companion_path=(
                str(row["companion_path"]) if row["companion_path"] is not None else None
            ),
            decision=(str(row["decision"]) if row["decision"] is not None else None),
            grade=(str(row["grade"]) if row["grade"] is not None else None),
            quality_score=(
                float(row["quality_score"]) if row["quality_score"] is not None else None
            ),
            bird_count=(int(row["bird_count"]) if row["bird_count"] is not None else None),
            species=(str(row["species"]) if row["species"] is not None else None),
        )
        for row in rows
    ]

    return await asyncio.to_thread(
        _run_export,
        library_id=str(library["id"]),
        library_name=str(library["display_name"]),
        root_path=root_path,
        target_dir=body.target_dir,
        photos=photos,
        body=body,
    )
