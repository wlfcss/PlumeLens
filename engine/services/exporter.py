# pyright: basic
"""Library export service.

The source library is treated as read-only. Export writes into a newly-created
subdirectory under the user-selected target directory, copies selected source
files, optionally copies JPG/RAW companions, and emits JSON/CSV manifests.
"""

from __future__ import annotations

import asyncio
import csv
import errno
import hashlib
import io
import json
import os
import re
import shutil
import stat
import threading
import time
import unicodedata
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
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
from engine.core.file_identity import file_change_time_ns
from engine.pipeline.preprocess import IMAGE_EXTENSIONS, RAW_EXTENSIONS
from engine.services.photo_input import source_fingerprint as analysis_input_fingerprint
from engine.services.xmp import (
    MAX_SIDECAR_BYTES,
    ExistingXmpError,
    merge_jpeg_xmp,
    merge_xmp_sidecar,
)

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
    file_hash: str | None = None
    input_revision: int | None = None
    pipeline_version: str | None = None
    analysis_source_path: str | None = None
    analysis_source_hash: str | None = None
    analysis_source_fingerprint: str | None = None
    source_fingerprint: tuple[int, int, int, int, int] | None = None
    companion_fingerprint: tuple[int, int, int, int, int] | None = None
    frozen: bool = False


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

    ``cancel_event`` 是 worker 与外界唯一的中断通道。复制按块检查取消，先写同目录
    临时文件，校验并同步后才原子发布最终名称；取消和故障都不会发布半截照片。
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
    projection_revision: str | None = None
    scope: Literal["library", "selection"] = "library"
    snapshot_path: Path | None = field(default=None, repr=False)
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
        self.persist()

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
        self.persist()

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
        self.persist()

    def persist(self) -> None:
        """Persist a replaceable snapshot; interrupted jobs remain discoverable after restart."""
        if self.snapshot_path is not None:
            try:
                _write_text_file(
                    self.snapshot_path,
                    json.dumps(self.snapshot(), ensure_ascii=False),
                )
            except OSError:
                logger.warning("Unable to persist export job snapshot", job_id=self.job_id)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.job_id,
                "library_id": self.library_id,
                "scope": self.scope,
                "projection_revision": self.projection_revision,
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
        existing = _JOBS.get(job_id)
    if existing is not None:
        return existing
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job_id):
        return None
    path = _job_snapshot_path(job_id)
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(saved, dict) or saved.get("status") not in {
            JOB_RUNNING,
            JOB_SUCCEEDED,
            JOB_FAILED,
            JOB_CANCELLED,
        }:
            return None
        job = ExportJob(
            job_id=job_id,
            library_id=str(saved["library_id"]),
            total=int(saved["total"]),
            total_bytes=int(saved["total_bytes"]),
            scope="selection" if saved.get("scope") == "selection" else "library",
            projection_revision=saved.get("projection_revision"),
            snapshot_path=path,
        )
        for name in (
            "processed",
            "exported",
            "companions",
            "xmp",
            "missing",
            "failed",
            "copied_bytes",
        ):
            setattr(job, name, int(saved.get(name, 0)))
        job.output_dir = saved.get("output_dir")
        result = saved.get("result")
        job.result = ExportLibraryResponse.model_validate(result) if result is not None else None
        job.status = str(saved["status"])
        saved_error = saved.get("error")
        error = saved_error if isinstance(saved_error, dict) else {}
        job.error_code = error.get("code")
        job.error_message = error.get("message")
        job.error_context = {k: v for k, v in error.items() if k not in ("code", "message")}
        if job.status == JOB_RUNNING:
            job.finish(
                JOB_FAILED,
                code="job_interrupted",
                message="Export was interrupted by an engine restart; completed files were kept",
            )
    except (OSError, ValueError, KeyError, TypeError):
        return None
    with _JOBS_LOCK:
        return _JOBS.setdefault(job_id, job)


def _job_snapshot_path(job_id: str) -> Path:
    from engine.core.config import settings

    return settings.data_dir / "export_jobs" / f"{job_id}.json"


def _write_job_inputs(
    job: ExportJob, photos: list[ExportPhoto], body: ExportLibraryRequest
) -> None:
    """Write immutable membership once; progress snapshots stay small even for huge folders."""
    path = _job_snapshot_path(job.job_id).with_suffix(".inputs.json")
    _write_text_file(
        path,
        json.dumps(
            {
                "job_id": job.job_id,
                "library_id": job.library_id,
                "request": body.model_dump(),
                "photos": [
                    {
                        "id": p.id,
                        "file_path": p.file_path,
                        "file_hash": p.file_hash,
                        "input_revision": p.input_revision,
                        "pipeline_version": p.pipeline_version,
                        "species": p.species,
                        "analysis_source_path": p.analysis_source_path,
                        "analysis_source_hash": p.analysis_source_hash,
                        "analysis_source_fingerprint": p.analysis_source_fingerprint,
                        "source_fingerprint": p.source_fingerprint,
                        "companion_path": p.companion_path,
                        "companion_fingerprint": p.companion_fingerprint,
                    }
                    for p in photos
                ],
            },
            ensure_ascii=False,
        ),
    )


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


def clear_export_job_history(data_dir: Path) -> None:
    """Clear in-memory export job records and persisted job snapshots on disk."""
    with _JOBS_LOCK:
        _JOBS.clear()
    jobs_dir = data_dir / "export_jobs"
    if jobs_dir.exists():
        shutil.rmtree(jobs_dir, ignore_errors=True)


def _register_job(job: ExportJob, *, check_running: bool = False) -> None:
    with _JOBS_LOCK:
        if check_running:
            for existing in _JOBS.values():
                if existing.library_id == job.library_id and existing.status == JOB_RUNNING:
                    raise ExportError(
                        "export_already_running",
                        "An export for this library is already running",
                        job_id=existing.job_id,
                    )
        finished = [jid for jid, existing in _JOBS.items() if existing.status != JOB_RUNNING]
        overflow = len(finished) - _JOB_HISTORY_LIMIT
        for jid in finished[:overflow] if overflow > 0 else []:
            _JOBS.pop(jid, None)
        _JOBS[job.job_id] = job
    job.persist()


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
    "source_changed": "源文件在导出期间发生变化，请重新扫描后重试",
    "xmp_preserved": "已原样导出 JPEG，鉴翎评级与关键词未写入，以保留原有 XMP",
    "sidecar_xmp_preserved": "已原样保留原有 XMP 边车，鉴翎评级与关键词未写入",
    "copy_failed": "文件复制或元数据写入失败",
    "permission_denied": "没有读取源文件或写入目标目录的权限",
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
_JPEG_EXTENDED_XMP_HEADER = b"http://ns.adobe.com/xmp/extension/\x00"
_JPEG_STANDALONE_MARKERS = {*range(0xD0, 0xD8), 0x01, 0xD8, 0xD9}
_BSD_FILE_LOCK_FLAGS = (
    stat.UF_IMMUTABLE
    | stat.SF_IMMUTABLE
    | stat.UF_APPEND
    | stat.SF_APPEND
    | stat.UF_NOUNLINK
    | stat.SF_NOUNLINK
)


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
    if body.scope == "library" and grade not in body.grades:
        return False
    score = _score_percent(photo)
    if (
        body.scope == "library"
        and score is not None
        and body.min_score is not None
        and score < body.min_score
    ):
        return False
    if (
        body.scope == "library"
        and score is not None
        and body.max_score is not None
        and score > body.max_score
    ):
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
    base_stem = rel.stem
    base_ext = rel.suffix
    base_parent = rel.parent
    candidate = rel
    suffix = 1
    while candidate in used or (output_dir / candidate).exists():
        candidate = base_parent / f"{base_stem}-{suffix}{base_ext}"
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


class _ExportCancelled(Exception):
    """Internal control signal; a cancelled file is never published."""


def _fingerprint(path: Path) -> tuple[int, int, int, int, int]:
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, file_change_time_ns(path, stat)


def _temporary_path(dest: Path) -> Path:
    return dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.plumelens-part")


def _clear_bsd_lock_flags(path: Path) -> None:
    chflags = getattr(os, "chflags", None)
    if chflags is None:
        return
    info = path.stat(follow_symlinks=False)
    flags = getattr(info, "st_flags", 0)
    if stat.S_ISREG(info.st_mode) and flags & _BSD_FILE_LOCK_FLAGS:
        chflags(path, flags & ~_BSD_FILE_LOCK_FLAGS, follow_symlinks=False)


def _copy_file(
    source: Path,
    dest: Path,
    *,
    cancel_event: threading.Event | None = None,
    expected_fingerprint: tuple[int, int, int, int, int] | None = None,
    expected_hash: str | None = None,
    jpeg_xmp: str | None = None,
) -> Literal["embedded", "preserved"] | None:
    """Verify the source copy and merge optional JPEG metadata before publication."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = _temporary_path(dest)
    before = _fingerprint(source)
    if expected_fingerprint is not None and before != expected_fingerprint:
        raise ExportError("source_changed", "Source file changed since export started")
    digest = (
        hashlib.sha256() if expected_hash and re.fullmatch(r"[0-9a-f]{64}", expected_hash) else None
    )
    xmp_status = None
    try:
        with source.open("rb") as src, temp.open("xb") as out:
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise _ExportCancelled
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                if digest is not None:
                    digest.update(chunk)
            out.flush()
            os.fsync(out.fileno())
        if _fingerprint(source) != before or temp.stat().st_size != before[2]:
            raise ExportError("source_changed", "Source file changed while copying")
        if digest is not None and digest.hexdigest() != expected_hash:
            raise ExportError("source_changed", "Source file no longer matches its input hash")
        if cancel_event is not None and cancel_event.is_set():
            raise _ExportCancelled
        if jpeg_xmp is not None:
            try:
                embedded = _jpeg_with_embedded_xmp(temp.read_bytes(), jpeg_xmp)
            except ExistingXmpError as exc:
                xmp_status = "preserved"
                logger.warning("Preserved JPEG XMP", filename=source.name, reason=str(exc))
            except ValueError:
                pass  # Keep the existing sidecar fallback for a non-JPEG source.
            else:
                with temp.open("wb") as out:
                    out.write(embedded)
                    out.flush()
                    os.fsync(out.fileno())
                xmp_status = "embedded"
        # Windows can refuse to replace an existing read-only file. Embed into
        # the staging file before inheriting the source attributes and publishing.
        shutil.copystat(source, temp)
        # Finder's Locked flag is copied by copystat on macOS. An immutable
        # temporary file cannot be renamed or removed after a failed export.
        _clear_bsd_lock_flags(temp)
        if cancel_event is not None and cancel_event.is_set():
            raise _ExportCancelled
        os.replace(temp, dest)
    finally:
        _unlink_silent(temp)
    return xmp_status


def _write_text_file(path: Path, body: str) -> None:
    _write_bytes_file(path, body.encode("utf-8"))


def _write_bytes_file(path: Path, body: bytes) -> None:
    """Publish sidecars and reports atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = _temporary_path(path)
    try:
        with temp.open("xb") as out:
            out.write(body)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        _unlink_silent(temp)


def _unlink_silent(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink()
    except PermissionError:
        # Only app-owned staging/rollback files come here. Clear copied
        # flags that may prevent removing them on Windows or macOS.
        with suppress(OSError):
            if os.name == "nt":
                info = path.stat(follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and (
                    info.st_file_attributes & stat.FILE_ATTRIBUTE_READONLY
                ):
                    path.chmod(stat.S_IWRITE)
            else:
                _clear_bsd_lock_flags(path)
            path.unlink()
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
    if photo.frozen and photo.companion_path is None:
        return None
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


def _discover_existing_xmp_sidecar(media_path: Path) -> Path | None:
    """Read-only lookup for an existing `.xmp`/`.XMP` sidecar next to the source photo."""
    for suffix in (".xmp", ".XMP"):
        candidate = media_path.with_suffix(suffix)
        if candidate.is_file():
            return candidate
    return None


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


_XML_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _xml_safe(value: str) -> str:
    return _XML_CONTROL_CHAR_RE.sub("", value)


def _xmp_packet(photo: ExportPhoto, source: Path) -> str:
    grade = _effective_grade(photo)
    rating = str(_xmp_rating(grade))
    label = _xmp_label(grade)
    metadata_date = datetime.now(UTC).isoformat()
    subject_items = "\n".join(
        f"        <rdf:li>{escape(_xml_safe(keyword))}</rdf:li>" for keyword in _xmp_keywords(photo)
    )
    hierarchical_items = "\n".join(
        f"        <rdf:li>{escape(_xml_safe(keyword))}</rdf:li>"
        for keyword in ["PlumeLens", f"PlumeLens|{_grade_label(grade) or '未评级'}"]
    )
    description = _xml_safe(
        f"PlumeLens 导出评级：{_grade_label(grade) or '未评级'}"
        + (f"；鸟种：{photo.species}" if photo.species else "")
    )
    nickname = _xml_safe(source.name)
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
        f"      xmp:Nickname={quoteattr(nickname)}>\n"
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
    """Merge one standard XMP segment without rewriting other JPEG bytes."""

    if not data.startswith(_JPEG_SOI):
        msg = "not a JPEG file"
        raise ValueError(msg)

    offset = len(_JPEG_SOI)
    standard: tuple[int, int, bytes] | None = None

    while offset < len(data):
        marker_start = offset
        if data[offset] != 0xFF:
            raise ExistingXmpError("Invalid JPEG marker before the image scan")

        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            raise ExistingXmpError("Truncated JPEG marker")

        marker = data[offset]
        offset += 1
        if marker == 0x00:
            raise ExistingXmpError("Unexpected JPEG byte stuffing before the image scan")
        if marker in (0xDA, 0xD9):  # Stop before the image scan or the end of image.
            offset = marker_start
            break
        if marker in _JPEG_STANDALONE_MARKERS:
            continue

        if offset + 2 > len(data):
            raise ExistingXmpError("Truncated JPEG segment length")
        segment_len = int.from_bytes(data[offset : offset + 2], "big")
        if segment_len < 2:
            raise ExistingXmpError("Invalid JPEG segment length")
        segment_end = offset + segment_len
        if segment_end > len(data):
            raise ExistingXmpError("Truncated JPEG segment payload")

        if marker == 0xE1:
            payload = data[offset + 2 : segment_end]
            if payload.startswith(_JPEG_EXTENDED_XMP_HEADER):
                raise ExistingXmpError("JPEG uses extended XMP")
            if payload.startswith(_JPEG_XMP_HEADER):
                if standard is not None:
                    raise ExistingXmpError("JPEG contains multiple standard XMP packets")
                standard = (offset - 2, segment_end, payload[len(_JPEG_XMP_HEADER) :])
        offset = segment_end

    if standard is None:
        segment = _jpeg_app1_segment(_JPEG_XMP_HEADER + packet.encode("utf-8"))
        return data[:offset] + segment + data[offset:]

    offset, end, existing = standard
    merged = merge_jpeg_xmp(existing, packet)
    try:
        segment = _jpeg_app1_segment(_JPEG_XMP_HEADER + merged)
    except ValueError as exc:
        raise ExistingXmpError("Merged XMP exceeds an APP1 segment") from exc
    return data[:offset] + segment + data[end:]


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
        return Path(path).relative_to(output_dir).as_posix()
    except ValueError:
        return path


def _rel_to_source_root(path: str | None, root: Path) -> str | None:
    if path is None:
        return None
    try:
        return Path(path).resolve().relative_to(root).as_posix()
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
    with io.StringIO() as f:
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
        _write_text_file(json_path, f.getvalue())
    with io.StringIO(newline="") as f:
        writer = csv.DictWriter(f, fieldnames=_CHINESE_MANIFEST_FIELDNAMES)
        writer.writeheader()
        for row in rows:
            writer.writerow(_manifest_row_to_chinese(row, output_dir, root))
        _write_text_file(csv_path, f.getvalue())
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


def _analysis_source_slot(photo: ExportPhoto) -> int | None:
    """Map the actual inference source even after a legitimate folder relink."""
    if photo.analysis_source_path is None:
        return None
    for slot, path in enumerate((photo.file_path, photo.companion_path)):
        if photo.analysis_source_path == path:
            return slot
    if photo.analysis_source_fingerprint:
        try:
            inputs = json.loads(photo.analysis_source_fingerprint)
            for slot, item in enumerate(inputs):
                if isinstance(item, list) and item and item[0] == photo.analysis_source_path:
                    return slot
        except (ValueError, TypeError):
            pass
    return None


def _expected_copy_hash(photo: ExportPhoto, slot: int) -> str | None:
    if _analysis_source_slot(photo) == slot and photo.analysis_source_hash:
        return photo.analysis_source_hash
    return photo.file_hash if slot == 0 else None


def _hash_matches(path: Path, expected_hash: str | None) -> bool:
    if not expected_hash or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest() == expected_hash


def _validate_analysis_inputs(photo: ExportPhoto, source: Path, companion: Path | None) -> None:
    """Reject changed inference inputs before applying their old species/grade.

    Normal inputs require only stat. A relink or a metadata-only change may
    preserve the actual bytes; allow that case only after verifying the known
    full hash, outside all SQL transactions. Legacy results without provenance
    retain their existing primary-hash check during copying.
    """
    if not photo.analysis_source_fingerprint:
        return
    # Missing files are handled per-photo during _run_export (source_missing /
    # companion_missing) rather than aborting the whole export at preflight.
    if not source.exists():
        return
    source_slot = _analysis_source_slot(photo)
    active_companion = companion if (companion is not None and companion.exists()) else None
    current = analysis_input_fingerprint(source, active_companion)
    try:
        previous_inputs = json.loads(photo.analysis_source_fingerprint)
        current_inputs = json.loads(current)
        if not isinstance(previous_inputs, list) or len(previous_inputs) != 2:
            raise ValueError("Invalid inference input identity")
        slots_to_check = (source_slot,) if source_slot in (0, 1) else (0, 1)
        for slot in slots_to_check:
            previous = previous_inputs[slot]
            present = current_inputs[slot]
            if previous == present:
                continue
            if (
                isinstance(previous, list)
                and isinstance(present, list)
                and previous[1:] == present[1:]
            ):
                continue  # A renamed parent directory, with the same physical file.
            path = source if slot == 0 else active_companion
            if slot == 1 and path is None and previous is not None:
                # Inference actually ran on the companion RAW which is now missing;
                # let per-photo missing handling or source_changed apply.
                if source_slot == 1:
                    raise ExportError(
                        "source_changed", "Inference input missing or changed; rescan before export"
                    )
                continue
            if path is None or not _hash_matches(path, _expected_copy_hash(photo, slot)):
                raise ExportError("source_changed", "Inference input changed; rescan before export")
        if current != analysis_input_fingerprint(source, active_companion):
            raise ExportError("source_changed", "Inference input changed while freezing export")
        if (
            source_slot == 0
            and photo.analysis_source_hash
            and photo.file_hash
            and photo.analysis_source_hash != photo.file_hash
        ):
            raise ExportError("source_changed", "Analysis no longer matches the scanned input hash")
    except (OSError, ValueError, TypeError) as exc:
        raise ExportError(
            "source_changed", "Inference input cannot be verified before export"
        ) from exc


def _freeze_file_inputs(photos: list[ExportPhoto]) -> None:
    """Freeze physical inputs before the job starts; discovery is never repeated mid-job."""
    for photo in photos:
        if photo.frozen:
            continue
        source = Path(photo.file_path)
        companion = _discover_companion_path(photo, source)
        if companion is not None:
            photo.companion_path = str(companion)
        _validate_analysis_inputs(photo, source, companion)
        with suppress(OSError):
            photo.source_fingerprint = _fingerprint(source)
        if companion is not None:
            with suppress(OSError):
                photo.companion_fingerprint = _fingerprint(companion)
        photo.frozen = True


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
    _freeze_file_inputs(selected)

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
        # 每张照片和文件复制块均可取消；一张照片的任一成员失败会清理已发布成员。
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
        jpeg_packet: str | None = None
        jpeg_xmp_status: Literal["embedded", "preserved"] | None = None
        error: str | None = None
        created_paths: list[Path] = []
        try:
            if not source.exists() or photo.source_fingerprint is None:
                missing += 1
                error = "source_missing"
            else:
                if _fingerprint(source) != photo.source_fingerprint:
                    raise ExportError("source_changed", "Source file changed since export started")
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
                    if (
                        body.include_xmp_sidecars
                        and companion_source is None
                        and _is_jpeg_path(source)
                    ):
                        jpeg_packet = _xmp_packet(photo, source)
                    jpeg_xmp_status = _copy_file(
                        source,
                        dest_path,
                        cancel_event=job.cancel_event if job is not None else None,
                        expected_fingerprint=photo.source_fingerprint,
                        expected_hash=_expected_copy_hash(photo, 0),
                        jpeg_xmp=jpeg_packet,
                    )
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
                    if photo.companion_fingerprint is None:
                        raise ExportError("source_changed", "Companion appeared after snapshot")
                    _copy_file(
                        companion_source,
                        companion_dest,
                        cancel_event=job.cancel_event if job is not None else None,
                        expected_fingerprint=photo.companion_fingerprint,
                        expected_hash=_expected_copy_hash(photo, 1),
                    )
                    created_paths.append(companion_dest)
                    exported_companion = True

                if error is None and body.include_xmp_sidecars:
                    xmp_source = (
                        companion_source
                        if companion_source is not None and companion_source.exists()
                        else source
                    )
                    if jpeg_xmp_status == "embedded":
                        xmp_dest = dest_path
                    elif jpeg_xmp_status == "preserved":
                        # A new sidecar could shadow the existing packet in a
                        # metadata reader. Report the skipped write explicitly.
                        error = "xmp_preserved"
                        failed += 1
                    else:
                        xmp_base = (
                            companion_dest
                            or dest_path
                            or _dest_rel(
                                xmp_source,
                                root,
                                _effective_grade(photo),
                                body.layout,
                                body.preserve_structure,
                            )
                        )
                        xmp_dest = _xmp_dest_for(output_dir, xmp_base, used)
                        generated_xmp = jpeg_packet or _xmp_packet(photo, xmp_source)
                        existing_sidecar = _discover_existing_xmp_sidecar(xmp_source)
                        if existing_sidecar is None and photo.companion_path:
                            existing_sidecar = _discover_existing_xmp_sidecar(
                                Path(photo.companion_path)
                            )
                        if existing_sidecar is not None:
                            sidecar_size = _file_size(existing_sidecar)
                            if sidecar_size > MAX_SIDECAR_BYTES:
                                _copy_file(
                                    existing_sidecar,
                                    xmp_dest,
                                    cancel_event=job.cancel_event if job is not None else None,
                                )
                                created_paths.append(xmp_dest)
                                error = "sidecar_xmp_preserved"
                                failed += 1
                            else:
                                existing_bytes = existing_sidecar.read_bytes()
                                try:
                                    merged_bytes = merge_xmp_sidecar(existing_bytes, generated_xmp)
                                except ExistingXmpError:
                                    _write_bytes_file(xmp_dest, existing_bytes)
                                    created_paths.append(xmp_dest)
                                    error = "sidecar_xmp_preserved"
                                    failed += 1
                                else:
                                    _write_bytes_file(xmp_dest, merged_bytes)
                                    created_paths.append(xmp_dest)
                                    exported_xmp = True
                        else:
                            _write_text_file(xmp_dest, generated_xmp)
                            created_paths.append(xmp_dest)
                            exported_xmp = True
                    if jpeg_xmp_status == "embedded":
                        exported_xmp = xmp_dest is not None

                if exported_main:
                    exported += 1
                if exported_companion:
                    companions += 1
                if exported_xmp:
                    xmp_count += 1
        except Exception as exc:
            reserved_paths = [p for p in (dest_path, companion_dest, xmp_dest) if p is not None]
            for path in reversed(list(dict.fromkeys([*created_paths, *reserved_paths]))):
                _unlink_silent(path)
                _release_dest(path, output_dir, used)
                _prune_empty_dirs(path.parent, output_dir)
            if isinstance(exc, _ExportCancelled):
                cancelled = True
                break
            failed += 1
            error = (
                exc.code
                if isinstance(exc, ExportError)
                else "insufficient_space"
                if isinstance(exc, OSError) and exc.errno == errno.ENOSPC
                else "permission_denied"
                if isinstance(exc, OSError) and exc.errno in (errno.EACCES, errno.EPERM)
                else "copy_failed"
            )
            logger.warning("Photo export failed", photo_id=photo.id, code=error, error=str(exc))
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
                "任务状态": (
                    "已取消（仅含取消前已导出的部分）"
                    if cancelled
                    else "部分失败"
                    if failed or missing
                    else "已完成"
                ),
                "导出范围": "当前筛选" if body.scope == "selection" else "整个文件夹",
                "筛选修订": body.projection_revision if body.scope == "selection" else None,
                "筛选条件": (
                    body.selection_query.model_dump()
                    if body.scope == "selection" and body.selection_query is not None
                    else None
                ),
                "输入快照": [
                    {
                        "照片ID": p.id,
                        "输入修订": p.input_revision,
                        "输入哈希": p.file_hash,
                        "推理源哈希": p.analysis_source_hash,
                        "推理源": (
                            "同伴文件"
                            if _analysis_source_slot(p) == 1
                            else "主文件"
                            if _analysis_source_slot(p) == 0
                            else "历史记录未提供"
                        ),
                        "管线版本": p.pipeline_version,
                        "有效物种": p.species,
                    }
                    for p in selected
                ],
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
) -> None:
    """Check source availability without holding a database transaction across file IO."""
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
        async with db.transaction() as conn:
            await conn.execute(
                "UPDATE libraries SET status = 'path_missing' WHERE id = ?",
                (library_id,),
            )
        msg = "Library source path is missing; relink the folder before export"
        raise ExportError("source_path_missing", msg)
    if str(library["status"]) == "path_missing":
        async with db.transaction() as conn:
            await conn.execute(
                "UPDATE libraries SET status = 'ready' WHERE id = ?",
                (library_id,),
            )


async def _load_export_photos(
    db: Database, library_id: str, *, connection: Any | None = None
) -> list[ExportPhoto]:
    """Read only database metadata; safe inside the caller's short snapshot transaction."""
    conn = connection if connection is not None else db.conn
    async with conn.execute(
        "SELECT p.id, p.file_path, p.file_name, p.file_mtime, p.exif_json, "
        "p.companion_path, p.file_hash, p.input_revision, ar.pipeline_version, "
        "ar.source_path, ar.source_hash, ar.source_fingerprint AS analysis_source_fingerprint, "
        "pd.decision, ar.grade, ar.quality_score, ar.bird_count, ar.species "
        "FROM photos p "
        "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "AND ar.input_revision = p.input_revision "
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
            file_hash=(str(row["file_hash"]) if row["file_hash"] is not None else None),
            input_revision=int(row["input_revision"]),
            pipeline_version=(
                str(row["pipeline_version"]) if row["pipeline_version"] is not None else None
            ),
            analysis_source_path=(str(row["source_path"]) if row["source_path"] else None),
            analysis_source_hash=(str(row["source_hash"]) if row["source_hash"] else None),
            analysis_source_fingerprint=(
                str(row["analysis_source_fingerprint"])
                if row["analysis_source_fingerprint"]
                else None
            ),
        )
        for row in rows
    ]
    return photos


async def _freeze_export_photos(
    db: Database, library_id: str, body: ExportLibraryRequest
) -> tuple[str, str, list[ExportPhoto]]:
    """Freeze effective identities and input metadata under one transaction revision."""
    from engine.services.library_projection import load_library_photos
    from engine.services.selection import (
        SelectionLibraryNotFound,
        SelectionRevisionConflict,
        freeze_selection,
    )

    async with db.read_snapshot() as conn:
        async with conn.execute(
            "SELECT display_name, root_path FROM libraries WHERE id = ?", (library_id,)
        ) as cursor:
            library = await cursor.fetchone()
        if library is None:
            raise ExportError("library_not_found", "Library not found")
        try:
            if body.scope == "selection":
                assert body.selection_query is not None and body.projection_revision is not None
                snapshot = await freeze_selection(
                    db, library_id, body.selection_query, body.projection_revision
                )
                projected = list(snapshot.photos)
                ids = list(snapshot.photo_ids)
            else:
                projected = await load_library_photos(db, library_id)
                ids = [p.id for p in projected]
        except SelectionRevisionConflict as exc:
            raise ExportError(
                "selection_changed",
                "Selection changed since preview; refresh the results before exporting",
            ) from exc
        except SelectionLibraryNotFound as exc:
            raise ExportError("library_not_found", "Library not found") from exc
        raw = {p.id: p for p in await _load_export_photos(db, library_id, connection=conn)}
        effective = {p.id: p for p in projected}
        photos: list[ExportPhoto] = []
        for photo_id in ids:
            photo = raw.get(photo_id)
            display = effective.get(photo_id)
            if photo is None or display is None:
                raise ExportError("selection_changed", "Selection member no longer exists")
            detections = display.detections or (
                [display.best_detection] if display.best_detection is not None else []
            )
            names = list(dict.fromkeys(d.species for d in detections if d.species))
            photo.species = "；".join(names) if names else display.species
            photos.append(photo)
    return str(library["display_name"]), str(library["root_path"]), photos


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


async def wait_for_export_jobs(wait_seconds: float = 3.0) -> bool:
    """Allow cancelled workers to publish their terminal snapshots before closing the loop."""
    tasks = list(_BACKGROUND_TASKS)
    if not tasks:
        return True
    _, pending = await asyncio.wait(tasks, timeout=wait_seconds)
    return not pending


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
    export_t0 = time.perf_counter()
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
            "export_job_failed",
            category="task_metric",
            job_id=job.job_id,
            library_id=library_id,
            code=exc.code,
            stages_ms={"total": round((time.perf_counter() - export_t0) * 1000, 1)},
            **exc.context,
        )
    except Exception as exc:
        job.finish(JOB_FAILED, code="internal_error", message=str(exc))
        await logger.aexception(
            "export_job_failed",
            category="task_metric",
            job_id=job.job_id,
            library_id=library_id,
            code="internal_error",
            stages_ms={"total": round((time.perf_counter() - export_t0) * 1000, 1)},
        )
    else:
        status = (
            JOB_CANCELLED
            if job.is_cancelled
            else JOB_FAILED
            if result.failed_count > 0
            else JOB_SUCCEEDED
        )
        job.finish(
            status,
            result=result,
            code="partial_export" if status == JOB_FAILED else None,
            message="Some photos could not be exported" if status == JOB_FAILED else None,
        )
        await logger.ainfo(
            "export_job_done",
            category="task_metric",
            job_id=job.job_id,
            library_id=library_id,
            status=status,
            exported=result.exported_count,
            companions=result.companion_count,
            xmp=result.xmp_count,
            missing=result.skipped_missing,
            failed=result.failed_count,
            stages_ms={"total": round((time.perf_counter() - export_t0) * 1000, 1)},
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
    body = body.model_copy(deep=True)
    await _load_export_context(db, library_id)

    running = _running_job_for_library(library_id)
    if running is not None:
        msg = "An export for this library is already running"
        raise ExportError("export_already_running", msg, job_id=running.job_id)

    library_name, root_path, photos = await _freeze_export_photos(db, library_id, body)
    selected, _, _ = await asyncio.to_thread(
        _prepare_export,
        root_path=root_path,
        target_dir=body.target_dir,
        photos=photos,
        body=body,
    )
    await asyncio.to_thread(_freeze_file_inputs, selected)
    total_bytes = await asyncio.to_thread(_estimate_export_bytes, selected, body)

    job = ExportJob(
        job_id=uuid.uuid4().hex,
        library_id=library_id,
        total=len(selected),
        total_bytes=total_bytes,
        scope=body.scope,
        projection_revision=body.projection_revision if body.scope == "selection" else None,
    )
    job.snapshot_path = _job_snapshot_path(job.job_id)
    try:
        await asyncio.to_thread(_write_job_inputs, job, selected, body)
        _register_job(job, check_running=True)
    except ExportError:
        _unlink_silent(_job_snapshot_path(job.job_id).with_suffix(".inputs.json"))
        raise
    except OSError as exc:
        raise ExportError(
            "snapshot_write_failed", "Unable to record export input snapshot"
        ) from exc
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
            library_id=library_id,
            library_name=library_name,
            root_path=root_path,
            body=body,
            photos=selected,
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
    await _load_export_context(db, library_id)
    library_name, root_path, photos = await _freeze_export_photos(db, library_id, body)
    return await asyncio.to_thread(
        _run_export,
        library_id=library_id,
        library_name=library_name,
        root_path=root_path,
        target_dir=body.target_dir,
        photos=photos,
        body=body,
    )
