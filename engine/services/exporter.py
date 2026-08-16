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
import threading
import unicodedata
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape, quoteattr

import structlog

from engine.api.schemas.export import (
    ExportFormatStat,
    ExportLayout,
    ExportLibraryRequest,
    ExportLibraryResponse,
    ExportManifestPaths,
)
from engine.core.database import Database
from engine.pipeline.preprocess import IMAGE_EXTENSIONS, RAW_EXTENSIONS

logger = structlog.stdlib.get_logger()


class ExportError(Exception):
    """Raised when an export request is invalid or cannot be completed.

    ``code`` 是稳定的机器可读标识,前端按 code 查 i18n 表渲染本地化文案;
    ``context`` 携带渲染所需的数值(如空间不足时的 required/free 字节数),
    让用户看到"还差多少"而不是一句无从下手的英文。``args[0]`` 仍是英文
    message,作为前端没有对应 i18n key 时的兜底。
    """

    def __init__(self, code: str, message: str, **context: Any) -> None:
        super().__init__(message)
        self.code = code
        self.context = context


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


JOB_RUNNING = "running"
JOB_SUCCEEDED = "succeeded"
JOB_FAILED = "failed"
JOB_CANCELLED = "cancelled"

# 已结束的 job 快照保留上限 — 前端拿到 job_id 后可能因为 SSE 重连/刷新再来查一次
# 结果,所以不能一完成就丢。超过上限按完成顺序淘汰最老的,避免长会话内存泄漏。
_JOB_HISTORY_LIMIT = 16


@dataclass
class ExportJob:
    """一次导出的可观测句柄。

    worker 跑在 ``asyncio.to_thread`` 的线程里,SSE 生成器跑在事件循环里 ——
    两边并发读写同一份计数,所以所有可变字段都只在 ``_lock`` 下更新/快照。

    ``cancel_event`` 是 worker 与外界唯一的中断通道:复制循环每张照片检查一次。
    检查点放在照片之间而不是字节流中间 —— ``shutil.copy2`` 不可中断,让它把当前
    这张写完(单张 RAW 最多 ~60 MB,约 1 秒)换来的是"取消后不留半截文件",
    比留下一个大小不对的 CR3 让用户误当成完整文件要好得多。
    """

    job_id: str
    library_id: str
    total: int
    total_bytes: int
    status: str = JOB_RUNNING
    processed: int = 0
    exported: int = 0
    companions: int = 0
    xmp: int = 0
    missing: int = 0
    failed: int = 0
    copied_bytes: int = 0
    current_file: str | None = None
    output_dir: str | None = None
    result: ExportLibraryResponse | None = None
    error_code: str | None = None
    error_message: str | None = None
    error_context: dict[str, Any] = field(default_factory=dict)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def cancel(self) -> None:
        self.cancel_event.set()

    @property
    def is_cancelled(self) -> bool:
        return self.cancel_event.is_set()

    def set_output_dir(self, path: str) -> None:
        with self._lock:
            self.output_dir = path

    def note_current(self, name: str | None) -> None:
        with self._lock:
            self.current_file = name

    def record(
        self,
        *,
        exported_main: bool = False,
        exported_companion: bool = False,
        exported_xmp: bool = False,
        missing: bool = False,
        failed: bool = False,
        copied_bytes: int = 0,
    ) -> None:
        with self._lock:
            self.processed += 1
            self.copied_bytes += copied_bytes
            if exported_main:
                self.exported += 1
            if exported_companion:
                self.companions += 1
            if exported_xmp:
                self.xmp += 1
            if missing:
                self.missing += 1
            if failed:
                self.failed += 1

    def finish(
        self,
        status: str,
        *,
        result: ExportLibraryResponse | None = None,
        code: str | None = None,
        message: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            self.status = status
            self.result = result
            self.error_code = code
            self.error_message = message
            self.error_context = dict(context or {})
            self.current_file = None

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.job_id,
                "library_id": self.library_id,
                "status": self.status,
                "total": self.total,
                "processed": self.processed,
                "exported": self.exported,
                "companions": self.companions,
                "xmp": self.xmp,
                "missing": self.missing,
                "failed": self.failed,
                "total_bytes": self.total_bytes,
                "copied_bytes": self.copied_bytes,
                "current_file": self.current_file,
                "output_dir": self.output_dir,
                "result": (self.result.model_dump(by_alias=True) if self.result else None),
                "error": (
                    {
                        "code": self.error_code,
                        "message": self.error_message,
                        **self.error_context,
                    }
                    if self.error_code
                    else None
                ),
            }


_JOBS: dict[str, ExportJob] = {}
_JOBS_LOCK = threading.Lock()


def get_export_job(job_id: str) -> ExportJob | None:
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def cancel_export_job(job_id: str) -> ExportJob | None:
    job = get_export_job(job_id)
    if job is not None and job.status == JOB_RUNNING:
        job.cancel()
    return job


def cancel_all_export_jobs() -> int:
    """Shutdown 钩子:请求所有运行中的导出停下来。

    ``asyncio.to_thread`` 用的 ThreadPoolExecutor 线程是非 daemon 的,解释器退出
    时 atexit 会 join 它们 —— 一个跑了两小时的复制循环会把 SIGTERM 整个堵死,
    逼得外层只能 SIGKILL(那才是真正留下半截文件的原因)。这里先置取消位,让
    worker 在当前这张照片写完后自己退出。
    """
    with _JOBS_LOCK:
        running = [job for job in _JOBS.values() if job.status == JOB_RUNNING]
    for job in running:
        job.cancel()
    return len(running)


def _register_job(job: ExportJob) -> None:
    with _JOBS_LOCK:
        finished = [jid for jid, existing in _JOBS.items() if existing.status != JOB_RUNNING]
        overflow = len(finished) - _JOB_HISTORY_LIMIT
        for jid in finished[:overflow] if overflow > 0 else []:
            _JOBS.pop(jid, None)
        _JOBS[job.job_id] = job


def _running_job_for_library(library_id: str) -> ExportJob | None:
    with _JOBS_LOCK:
        for job in _JOBS.values():
            if job.library_id == library_id and job.status == JOB_RUNNING:
                return job
    return None


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
_JPEG_EXTENSIONS = {".jpg", ".jpeg"}
_JPEG_SOI = b"\xff\xd8"
_JPEG_APP1 = b"\xff\xe1"
_JPEG_XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"
_JPEG_STANDALONE_MARKERS = {*range(0xD0, 0xD8), 0x01, 0xD8, 0xD9}


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
    # 0) Unicode NFC 归一 — 同一字符可能用 base + 组合记号(NFD)写两遍,先归到
    #    NFC,后续 regex 才能稳定匹配 reserved char/name 的 bytes 形态(否则攻击
    #    者用 "ÇON" 这种 NFD 形式就能绕过 reserved-name 检测)。
    cleaned = unicodedata.normalize("NFC", value)
    # 1) 删 null + control 字符 (\x00-\x1f, \x7f) + Unicode line/paragraph 分隔符
    #    ( /  在部分 Windows 文本工具会被当 newline 截断)。
    cleaned = re.sub(r"[\x00-\x1f\x7f  ]+", "", cleaned)
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


def _ext_key(name: str | None) -> str | None:
    """文件名 → 大写扩展名(不含点)。无扩展名返回 None。"""
    if not name:
        return None
    _, dot, ext = name.rpartition(".")
    return ext.upper() if dot and ext else None


def _allowed_formats(body: ExportLibraryRequest) -> frozenset[str] | None:
    return frozenset(body.formats) if body.formats else None


def _format_ok(name: str | None, allowed: frozenset[str] | None) -> bool:
    if allowed is None:
        return True
    ext = _ext_key(name)
    return ext is not None and ext in allowed


def _plan_files(photo: ExportPhoto, body: ExportLibraryRequest) -> tuple[bool, bool]:
    """按格式白名单判定 (要不要导主文件, 要不要考虑同伴文件)。

    两者独立判定 —— 用户只勾 CR3 时,JPG 主文件跳过而配套 CR3 仍要导出;
    只勾 JPG 则反过来。``include_companions`` 是同伴的总开关,与白名单是 AND。
    """
    allowed = _allowed_formats(body)
    want_main = _format_ok(photo.file_name, allowed)
    want_companion = body.include_companions and _format_ok(
        Path(photo.companion_path).name if photo.companion_path else None,
        allowed,
    )
    # 没有 companion_path 记录时(v7 之前入库的老库),同伴只能靠磁盘探测,此刻还
    # 判不出扩展名 —— 先放行,等 _discover_companion_path 拿到真实路径再过一次
    # _format_ok。不放行的话老库勾了 CR3 会一个 RAW 都导不出来。
    #
    # 代价:前端只看得到 DB 字段,这类照片会被它算作"没有同伴"而不计入"将导出
    # N 张"。偏差方向是后端多导而非少导,且仅限老库,可接受。
    if body.include_companions and photo.companion_path is None:
        want_companion = True
    return want_main, want_companion


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
    if score is not None and body.max_score is not None and score > body.max_score:
        return False
    # 格式白名单只在真的复制文件时参与筛选 —— xmp_only 模式下导的是 sidecar,
    # 与源文件格式无关,不能因为"没勾 CR3"就把整张照片排除掉。
    if body.copy_files:
        want_main, want_companion = _plan_files(photo, body)
        if not want_main and not want_companion:
            return False
    return True


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


def _is_jpeg_path(path: Path) -> bool:
    return path.suffix.lower() in _JPEG_EXTENSIONS


def _jpeg_app1_segment(payload: bytes) -> bytes:
    # JPEG APP1 length includes the two length bytes, so the payload itself is capped at 65533.
    segment_len = len(payload) + 2
    if segment_len > 0xFFFF:
        msg = "XMP packet is too large for a single JPEG APP1 segment"
        raise ValueError(msg)
    return _JPEG_APP1 + segment_len.to_bytes(2, "big") + payload


def _jpeg_with_embedded_xmp(data: bytes, packet: str) -> bytes:
    """Return JPEG bytes with one standard XMP APP1 segment, preserving image data."""

    if not data.startswith(_JPEG_SOI):
        msg = "not a JPEG file"
        raise ValueError(msg)

    xmp_segment = _jpeg_app1_segment(_JPEG_XMP_HEADER + packet.encode("utf-8"))
    segments: list[bytes] = []
    offset = len(_JPEG_SOI)
    tail_offset = offset

    while offset < len(data):
        marker_start = offset
        if data[offset] != 0xFF:
            tail_offset = offset
            break

        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            tail_offset = marker_start
            break

        marker = data[offset]
        offset += 1
        if marker == 0x00:
            tail_offset = marker_start
            break
        if marker == 0xDA:  # Start of Scan: compressed image data follows.
            tail_offset = marker_start
            break
        if marker in _JPEG_STANDALONE_MARKERS:
            tail_offset = offset
            if marker != 0xD9:
                segments.append(data[marker_start:offset])
                continue
            tail_offset = marker_start
            break

        if offset + 2 > len(data):
            msg = "truncated JPEG segment length"
            raise ValueError(msg)
        segment_len = int.from_bytes(data[offset : offset + 2], "big")
        if segment_len < 2:
            msg = "invalid JPEG segment length"
            raise ValueError(msg)
        segment_end = offset + segment_len
        if segment_end > len(data):
            msg = "truncated JPEG segment payload"
            raise ValueError(msg)

        payload = data[offset + 2 : segment_end]
        segment = data[marker_start:segment_end]
        if marker != 0xE1 or not payload.startswith(_JPEG_XMP_HEADER):
            segments.append(segment)
        offset = segment_end
        tail_offset = offset

    return _JPEG_SOI + b"".join(segments) + xmp_segment + data[tail_offset:]


def _try_embed_xmp_in_jpeg(path: Path, packet: str) -> bool:
    if not _is_jpeg_path(path):
        return False
    try:
        embedded = _jpeg_with_embedded_xmp(path.read_bytes(), packet)
    except (OSError, ValueError):
        return False
    path.write_bytes(embedded)
    return True


def _estimate_export_bytes(
    selected: list[ExportPhoto],
    body: ExportLibraryRequest,
) -> int:
    total = 0
    allowed = _allowed_formats(body)
    for photo in selected:
        source = Path(photo.file_path)
        if body.copy_files:
            want_main, want_companion = _plan_files(photo, body)
            if want_main:
                total += _file_size(source)
            if want_companion:
                companion = _discover_companion_path(photo, source)
                if companion is not None and _format_ok(companion.name, allowed):
                    total += _file_size(companion)
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
        # 带上具体字节数 — 前端才能渲染"约需 84.9 GB / 可用 83.2 GB / 还差 1.7 GB",
        # 用户据此决定是关掉 RAW 同伴还是收窄分数区间,而不是干瞪一句英文报错。
        raise ExportError(
            "insufficient_space",
            msg,
            required_bytes=required_bytes,
            free_bytes=free,
        )


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


def _rel_to_source_root(path: str | None, root: Path) -> str | None:
    if path is None:
        return None
    try:
        return str(Path(path).resolve().relative_to(root))
    except (OSError, ValueError):
        return Path(path).name


def _source_parent_label(relative_source: str | None) -> str | None:
    if not relative_source:
        return None
    parent = Path(relative_source).parent
    return "" if str(parent) == "." else str(parent)


def _manifest_row_to_chinese(
    row: ExportManifestRow,
    output_dir: Path,
    root: Path,
) -> dict[str, Any]:
    source_rel = _rel_to_source_root(row.source_path, root)
    return {
        "照片ID": row.photo_id,
        "文件名": row.file_name,
        "源文件路径": source_rel,
        "源文件夹": _source_parent_label(source_rel),
        "导出文件路径": row.dest_path,
        "导出相对路径": _rel_to_output(row.dest_path, output_dir),
        "同伴源文件路径": _rel_to_source_root(row.companion_source_path, root),
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
    root: Path,
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
            rendered = json.dumps(
                _manifest_row_to_chinese(row, output_dir, root),
                ensure_ascii=False,
            )
            f.write(f"    {rendered}")
        f.write("\n  ]\n")
        f.write("}\n")
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=_CHINESE_MANIFEST_FIELDNAMES)
        writer.writeheader()
        for row in rows:
            writer.writerow(_manifest_row_to_chinese(row, output_dir, root))
    return json_path, csv_path


def _prepare_export(
    *,
    root_path: str,
    target_dir: str,
    photos: list[ExportPhoto],
    body: ExportLibraryRequest,
) -> tuple[list[ExportPhoto], Path, Path]:
    """校验目标目录 + 预估空间,返回 (选中照片, 源根目录, 目标目录)。

    这段必须在 HTTP 请求内同步跑完:路径非法 / 空间不足要立刻以 4xx 回给用户,
    而不是先建个 job 再从 SSE 里报错(那样用户已经看到"导出中"了才被告知失败)。
    """
    root = Path(root_path).expanduser().resolve()
    target = Path(target_dir).expanduser().resolve()
    if _is_relative_to(target, root):
        msg = "Export target must not be inside the source library"
        raise ExportError("target_inside_source", msg)
    # 反向包含同样要拦:target=/Volumes/dst, root=/Volumes/dst/lib 时 target 是 root
    # 的祖先,导出会在祖先目录下创建子目录,虽不直接覆写源文件,但仍违反"导出与源
    # 隔离"的语义。target == root 一并拦下(导出到同一根目录)。
    if target == root or _is_relative_to(root, target):
        msg = "Export target must not contain the source library"
        raise ExportError("target_contains_source", msg)

    selected = [photo for photo in photos if _matches_request(photo, body)]
    _ensure_target_has_space(target, _estimate_export_bytes(selected, body))
    return selected, root, target


def _run_export(
    *,
    library_id: str,
    library_name: str,
    root_path: str,
    target_dir: str,
    photos: list[ExportPhoto],
    body: ExportLibraryRequest,
    job: ExportJob | None = None,
) -> ExportLibraryResponse:
    selected, root, target = _prepare_export(
        root_path=root_path,
        target_dir=target_dir,
        photos=photos,
        body=body,
    )

    output_dir = _unique_output_dir(target / f"{_safe_name(library_name)}-{_now_stamp()}")
    output_dir.mkdir(parents=True, exist_ok=False)
    if job is not None:
        job.set_output_dir(str(output_dir))

    allowed_formats = _allowed_formats(body)
    rows: list[ExportManifestRow] = []
    used: set[Path] = set()
    exported = 0
    companions = 0
    xmp_count = 0
    missing = 0
    failed = 0

    cancelled = False
    for photo in selected:
        # 取消检查点 — 放在每张照片开头,当前这张会完整写完再退出(见 ExportJob 注释)
        if job is not None and job.is_cancelled:
            cancelled = True
            break
        source = Path(photo.file_path)
        if job is not None:
            job.note_current(photo.file_name)
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
                want_main, want_companion = _plan_files(photo, body)
                if body.copy_files and want_companion:
                    companion_source = _discover_companion_path(photo, source)
                    if photo.companion_path and (
                        companion_source is None or not companion_source.exists()
                    ):
                        error = "companion_missing"
                        missing += 1
                    elif companion_source is not None and not _format_ok(
                        companion_source.name, allowed_formats
                    ):
                        # 磁盘探测出来的同伴不在格式白名单内(companion_path 为空时
                        # 才会走到这) —— 不是错误,只是不导。
                        companion_source = None

                if error is None and body.copy_files and want_main:
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

                # 同伴复制独立于主文件 —— 只勾 CR3 时主文件(JPG)被跳过,配套 CR3
                # 仍然要导出,所以不能再嵌在"主文件复制成功"的分支里。
                if (
                    error is None
                    and body.copy_files
                    and companion_source
                    and companion_source.exists()
                ):
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
                    xmp_body = _xmp_packet(photo, xmp_source)
                    if companion_dest is not None:
                        xmp_dest = _xmp_dest_for(output_dir, companion_dest, used)
                        _write_text_file(xmp_dest, xmp_body)
                        created_paths.append(xmp_dest)
                    elif dest_path is not None:
                        if _try_embed_xmp_in_jpeg(dest_path, xmp_body):
                            xmp_dest = dest_path
                        else:
                            xmp_dest = _xmp_dest_for(output_dir, dest_path, used)
                            _write_text_file(xmp_dest, xmp_body)
                            created_paths.append(xmp_dest)
                    else:
                        xmp_rel = _dest_rel(
                            xmp_source,
                            root,
                            _effective_grade(photo),
                            body.layout,
                            body.preserve_structure,
                        )
                        xmp_dest = _xmp_dest_for(output_dir, xmp_rel, used)
                        _write_text_file(xmp_dest, xmp_body)
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
        if job is not None:
            job.record(
                exported_main=exported_main,
                exported_companion=exported_companion,
                exported_xmp=exported_xmp,
                missing=error in ("source_missing", "companion_missing"),
                failed=error is not None and error not in ("source_missing", "companion_missing"),
                copied_bytes=(
                    _file_size(dest_path if exported_main else None)
                    + _file_size(companion_dest if exported_companion else None)
                ),
            )

    if job is not None:
        job.note_current(None)

    json_path: Path | None = None
    csv_path: Path | None = None
    if body.include_manifest:
        json_path, csv_path = _write_manifests(
            output_dir,
            root,
            rows,
            {
                "导出时间": datetime.now(UTC).isoformat(),
                "任务状态": "已取消（仅含取消前已导出的部分）" if cancelled else "已完成",
                "图库ID": library_id,
                "图库名称": library_name,
                "源图库路径": "(已脱敏)",
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


async def _load_export_context(
    db: Database,
    library_id: str,
) -> tuple[str, str, str, list[ExportPhoto]]:
    """读取图库元信息 + 全部候选照片,返回 (id, 名称, 源根路径, 照片列表)。"""
    async with db.conn.execute(
        "SELECT id, display_name, root_path, status FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        library = await cur.fetchone()
    if library is None:
        msg = "Library not found"
        raise ExportError("library_not_found", msg)

    root_path = str(library["root_path"])
    if not await asyncio.to_thread(Path(root_path).exists):
        await db.conn.execute(
            "UPDATE libraries SET status = 'path_missing' WHERE id = ?",
            (library_id,),
        )
        await db.conn.commit()
        msg = "Library source path is missing; relink the folder before export"
        raise ExportError("source_path_missing", msg)
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
    return str(library["id"]), str(library["display_name"]), root_path, photos


async def list_export_formats(db: Database, library_id: str) -> list[ExportFormatStat]:
    """按扩展名聚合库内存量(主文件 + 同伴文件),供导出面板展示可选格式。

    体积直接取 photos 表里已记的 file_size / companion_size,不碰磁盘 —— 面板
    每次打开都要拉,几千行的 SQL 聚合比几千次 stat 便宜得多。
    """
    async with db.conn.execute(
        "SELECT id FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        if await cur.fetchone() is None:
            msg = "Library not found"
            raise ExportError("library_not_found", msg)

    async with db.conn.execute(
        "SELECT file_name, file_size, companion_path, companion_format, companion_size "
        "FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()

    tally: dict[str, list[int]] = {}

    def _add(ext: str | None, size: int | None) -> None:
        if ext is None:
            return
        entry = tally.setdefault(ext, [0, 0])
        entry[0] += 1
        entry[1] += int(size or 0)

    for row in rows:
        _add(_ext_key(str(row["file_name"])), row["file_size"])
        companion_ext = row["companion_format"] or (
            _ext_key(Path(str(row["companion_path"])).name) if row["companion_path"] else None
        )
        if companion_ext:
            _add(str(companion_ext).lstrip(".").upper(), row["companion_size"])

    raw_exts = {ext.lstrip(".").upper() for ext in RAW_EXTENSIONS}
    return [
        ExportFormatStat(ext=ext, count=count, bytes=size, is_raw=ext in raw_exts)
        # 体积降序 —— 用户最想砍掉的就是最占地方的那一种
        for ext, (count, size) in sorted(tally.items(), key=lambda kv: (-kv[1][1], kv[0]))
    ]


# 后台 job 的 asyncio.Task 强引用 — create_task 只持弱引用,不存住会被 GC 提前回收。
_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


async def _run_job(
    job: ExportJob,
    *,
    library_id: str,
    library_name: str,
    root_path: str,
    body: ExportLibraryRequest,
    photos: list[ExportPhoto],
) -> None:
    """后台跑完一次导出,把终态写回 job(SSE 生成器据此收流)。"""
    try:
        result = await asyncio.to_thread(
            _run_export,
            library_id=library_id,
            library_name=library_name,
            root_path=root_path,
            target_dir=body.target_dir,
            photos=photos,
            body=body,
            job=job,
        )
    except ExportError as exc:
        job.finish(JOB_FAILED, code=exc.code, message=str(exc), context=exc.context)
        await logger.aerror(
            "Export job failed",
            job_id=job.job_id,
            library_id=library_id,
            code=exc.code,
            **exc.context,
        )
    except Exception as exc:
        job.finish(JOB_FAILED, code="internal_error", message=str(exc))
        await logger.aexception("Export job crashed", job_id=job.job_id, library_id=library_id)
    else:
        status = JOB_CANCELLED if job.is_cancelled else JOB_SUCCEEDED
        job.finish(status, result=result)
        await logger.ainfo(
            "Export job finished",
            job_id=job.job_id,
            library_id=library_id,
            status=status,
            exported=result.exported_count,
            companions=result.companion_count,
            xmp=result.xmp_count,
            missing=result.skipped_missing,
            failed=result.failed_count,
            output_dir=result.output_dir,
        )


async def start_export_job(
    db: Database,
    library_id: str,
    body: ExportLibraryRequest,
) -> ExportJob:
    """校验请求并启动一个后台导出任务,立刻返回句柄。

    预检(路径合法性 / 磁盘空间)在这里同步做完 —— 失败要以 4xx 当场回给用户,
    而不是先建 job 再从进度流里报错。真正的文件复制交给后台 worker,HTTP 请求
    不再需要撑到导出结束(历史 bug:964 张 / 80 GB 要跑两小时,前端 60s 超时后
    UI 报"导出失败",后端却毫不知情地继续复制,用户重试又叠一个并发导出)。
    """
    lib_id, library_name, root_path, photos = await _load_export_context(db, library_id)

    running = _running_job_for_library(library_id)
    if running is not None:
        msg = "An export for this library is already running"
        raise ExportError("export_already_running", msg, job_id=running.job_id)

    selected, _, _ = await asyncio.to_thread(
        _prepare_export,
        root_path=root_path,
        target_dir=body.target_dir,
        photos=photos,
        body=body,
    )
    total_bytes = await asyncio.to_thread(_estimate_export_bytes, selected, body)

    job = ExportJob(
        job_id=uuid.uuid4().hex,
        library_id=library_id,
        total=len(selected),
        total_bytes=total_bytes,
    )
    _register_job(job)
    await logger.ainfo(
        "Export job started",
        job_id=job.job_id,
        library_id=library_id,
        selected=len(selected),
        total_bytes=total_bytes,
        target_dir=body.target_dir,
        layout=body.layout,
        copy_files=body.copy_files,
        include_companions=body.include_companions,
        include_xmp_sidecars=body.include_xmp_sidecars,
    )

    task = asyncio.create_task(
        _run_job(
            job,
            library_id=lib_id,
            library_name=library_name,
            root_path=root_path,
            body=body,
            photos=photos,
        )
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return job


async def export_library(
    db: Database,
    library_id: str,
    body: ExportLibraryRequest,
) -> ExportLibraryResponse:
    """同步导出(等待完成) — 保留给测试与不需要进度流的调用方。"""
    lib_id, library_name, root_path, photos = await _load_export_context(db, library_id)
    return await asyncio.to_thread(
        _run_export,
        library_id=lib_id,
        library_name=library_name,
        root_path=root_path,
        target_dir=body.target_dir,
        photos=photos,
        body=body,
    )
