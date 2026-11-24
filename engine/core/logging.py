"""Structured logging setup with structlog.

双输出（stderr console + 可热开关的文件 JSONL）+ 崩溃 traceback 捕获 +
就地凭证脱敏与文件名哈希匿名。

为什么需要文件日志：
process-manager.ts 监听 engine 子进程 stderr 只用于解析 PORT/READY 字符串，
内容丢弃 → packaged 应用崩溃后没有任何 trace 可查。本模块把 structlog
事件同时写到 {userData}/logs/engine.jsonl（10MB × 5 轮转），未捕获异常
额外写到 logs/crash/engine-{ts}.txt。

用户可在客户端首次启动或「设置 → 日志与诊断」中开启/关闭本地日志，无需重启引擎：
通过 `reconfigure_logging()` 动态增删文件 handler、切换级别与同步 device_id。
"""

from __future__ import annotations

import atexit
import contextlib
import hashlib
import hmac
import logging
import logging.handlers
import re
import sys
import threading
import traceback
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import structlog

if TYPE_CHECKING:
    from types import TracebackType


_FILE_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
_FILE_LOG_BACKUP_COUNT = 5

_LOGGING_LOCK = threading.RLock()


@dataclass
class _LoggingState:
    logs_dir: Path | None = None
    file_handler: logging.Handler | None = None
    device_id: str | None = None
    session_id: str | None = None
    file_logging_enabled: bool = False
    crash_hook_installed: bool = False


_state = _LoggingState()

_SENSITIVE_KEY_RE = re.compile(
    r"(?:^|[_-])(token|key|ak|secret|authorization|password|passwd|cookie|credential)(?:$|[_-])"
    r"|^(amapKey|baiduAk|tencentKey|apiToken|authToken)$",
    re.IGNORECASE,
)
_PHOTO_EXTS = (
    "cr2|cr3|nef|nrw|arw|srf|sr2|orf|rw2|pef|dng|raf|srw|3fr|iiq|"
    "jpg|jpeg|png|webp|tif|tiff|heic|heif|avif"
)
_PHOTO_PATH_RE = re.compile(
    rf"(?:[A-Za-z]:\\|/(?:Users|home|Volumes|mnt|media|private|var|tmp)/)[^\s\"'\]\)}}>,]+?\.({_PHOTO_EXTS})\b",
    re.IGNORECASE,
)
_GENERIC_HOME_RE = re.compile(
    r"(?:/Users/[^/\s\"'`]+|/home/[^/\s\"'`]+|[A-Za-z]:\\Users\\[^\\\s\"'`]+)"
)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{8,}", re.IGNORECASE)
_QUERY_SECRET_RE = re.compile(
    r"([?&](?:token|key|ak|api_key|apikey|secret|access_token)=)([^&\s\"'`]+)",
    re.IGNORECASE,
)
_HOME_STR = str(Path.home())
_HOME_POSIX = _HOME_STR.replace("\\", "/")


def anonymize_filename(path_or_name: str, device_id: str | None = None) -> str:
    """Deterministically anonymize a filename or path into `f_<12-hex>.<ext>`.

    Matches `electron/device-id.ts:anonymizeFileName` byte-for-byte:
    - Key: `{device_id}:file:v1`
    - Message: lowercased file stem (without extension)
    - Paired JPG + RAW share the same anonymized stem.
    """
    salt_id = device_id or _state.device_id or "pl-anonymous"
    normalized = path_or_name.replace("\\", "/").rstrip("/")
    base = normalized.rsplit("/", 1)[-1].strip()
    if not base:
        return "f_empty"
    if "." in base and not base.startswith("."):
        stem, ext = base.rsplit(".", 1)
        ext = ext.lower()
    else:
        stem, ext = base, ""
    digest = hmac.new(
        f"{salt_id}:file:v1".encode(),
        stem.lower().encode(),
        hashlib.sha256,
    ).hexdigest()[:12]
    return f"f_{digest}.{ext}" if ext else f"f_{digest}"


def redact_text(value: str, device_id: str | None = None) -> str:
    """Redact credentials, home directories, and photo filenames in log strings."""
    if not value:
        return value
    out = _BEARER_RE.sub("Bearer [REDACTED]", value)
    out = _QUERY_SECRET_RE.sub(r"\1[REDACTED]", out)
    out = _PHOTO_PATH_RE.sub(
        lambda m: f"<photo>/{anonymize_filename(m.group(0), device_id)}",
        out,
    )
    if len(_HOME_STR) > 1 and _HOME_STR in out:
        out = out.replace(_HOME_STR, "~")
    if len(_HOME_POSIX) > 1 and _HOME_POSIX != _HOME_STR and _HOME_POSIX in out:
        out = out.replace(_HOME_POSIX, "~")
    out = _GENERIC_HOME_RE.sub("~", out)
    return out


def _sanitize_value(value: object, depth: int = 0) -> object:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, Path):
        return redact_text(str(value))
    if isinstance(value, str):
        return redact_text(value)
    if depth >= 4:
        return "[MaxDepth]"
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        out: dict[str, object] = {}
        for k, v in mapping.items():
            key_str = str(k)
            if _SENSITIVE_KEY_RE.search(key_str):
                out[key_str] = "[REDACTED]"
            else:
                out[key_str] = _sanitize_value(v, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        seq = cast(list[object] | tuple[object, ...], value)
        return [_sanitize_value(item, depth + 1) for item in seq[:30]]
    return redact_text(str(value))


def _redact_event_dict(
    _logger: Any,
    _method_name: str,
    event_dict: structlog.types.EventDict,
) -> structlog.types.EventDict:
    """Structlog processor: redact secrets and anonymize photo paths before formatting."""
    for key in list(event_dict.keys()):
        if key in {"timestamp", "level", "logger", "device_id", "session_id", "request_id"}:
            continue
        if _SENSITIVE_KEY_RE.search(key):
            event_dict[key] = "[REDACTED]"
        else:
            event_dict[key] = _sanitize_value(event_dict[key], 0)
    return event_dict


def _make_json_formatter() -> structlog.stdlib.ProcessorFormatter:
    return structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(ensure_ascii=False),
        ],
    )


def _attach_file_handler(root_logger: logging.Logger, logs_dir: Path) -> None:
    logs_dir.mkdir(parents=True, exist_ok=True)
    (logs_dir / "crash").mkdir(parents=True, exist_ok=True)

    file_handler = logging.handlers.RotatingFileHandler(
        filename=logs_dir / "engine.jsonl",
        maxBytes=_FILE_LOG_MAX_BYTES,
        backupCount=_FILE_LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setFormatter(_make_json_formatter())
    root_logger.addHandler(file_handler)
    _state.file_handler = file_handler


def _detach_file_handler(root_logger: logging.Logger) -> None:
    if _state.file_handler is not None:
        with contextlib.suppress(Exception):
            root_logger.removeHandler(_state.file_handler)
        with contextlib.suppress(Exception):
            _state.file_handler.flush()
        with contextlib.suppress(Exception):
            _state.file_handler.close()
        _state.file_handler = None


def _flush_active_handlers() -> None:
    root_logger = logging.getLogger()
    for handler in list(root_logger.handlers):
        with contextlib.suppress(Exception):
            handler.flush()


atexit.register(_flush_active_handlers)


def setup_logging(
    *,
    log_level: str = "INFO",
    logs_dir: Path | None = None,
    enabled: bool = True,
    device_id: str | None = None,
    session_id: str | None = None,
) -> None:
    """Configure structlog with stderr (human-readable) + optional file (JSONL) outputs.

    Args:
        log_level: 根 logger 级别 (INFO/DEBUG/WARNING/ERROR)
        logs_dir: 持久化日志目录。pytest / standalone 不传 → 仅 stderr。
        enabled: 是否允许落盘 engine.jsonl 与 crash dump（受客户端用户开关控制）。
        device_id: 派生后的设备唯一标识（PLUMELENS_DEVICE_ID）。
        session_id: 本次应用启动会话 ID（PLUMELENS_SESSION_ID）。
    """
    with _LOGGING_LOCK:
        _state.logs_dir = logs_dir
        _state.device_id = device_id
        _state.session_id = session_id
        _state.file_logging_enabled = bool(enabled and logs_dir is not None)

        shared_processors: list[structlog.types.Processor] = [
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            _redact_event_dict,
        ]

        structlog.configure(
            processors=[
                *shared_processors,
                structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
            ],
            logger_factory=structlog.stdlib.LoggerFactory(),
            wrapper_class=structlog.stdlib.BoundLogger,
            cache_logger_on_first_use=True,
        )

        bind_fields: dict[str, Any] = {}
        if device_id:
            bind_fields["device_id"] = device_id
        if session_id:
            bind_fields["session_id"] = session_id
        if bind_fields:
            structlog.contextvars.bind_contextvars(**bind_fields)

        console_formatter = structlog.stdlib.ProcessorFormatter(
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                structlog.dev.ConsoleRenderer(),
            ],
        )
        stderr_handler = logging.StreamHandler(sys.stderr)
        stderr_handler.setFormatter(console_formatter)

        root_logger = logging.getLogger()
        _detach_file_handler(root_logger)
        for handler in list(root_logger.handlers):
            with contextlib.suppress(Exception):
                handler.flush()
            with contextlib.suppress(Exception):
                handler.close()
        root_logger.handlers.clear()
        root_logger.addHandler(stderr_handler)

        if _state.file_logging_enabled and logs_dir is not None:
            _attach_file_handler(root_logger, logs_dir)

        if logs_dir is not None:
            _install_crash_hook()

        root_logger.setLevel(log_level.upper())

        # Quieten noisy loggers
        logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def reconfigure_logging(
    *,
    enabled: bool,
    log_level: str | None = None,
    device_id: str | None = None,
    session_id: str | None = None,
    reopen: bool = False,
) -> dict[str, Any]:
    """Hot-toggle file logging, level, or identity without restarting the engine."""
    with _LOGGING_LOCK:
        root_logger = logging.getLogger()
        if device_id:
            _state.device_id = device_id
            structlog.contextvars.bind_contextvars(device_id=device_id)
        if session_id:
            _state.session_id = session_id
            structlog.contextvars.bind_contextvars(session_id=session_id)

        if log_level:
            normalized = log_level.upper()
            if normalized in {"DEBUG", "INFO", "WARNING", "ERROR"}:
                root_logger.setLevel(normalized)

        target_enabled = bool(enabled and _state.logs_dir is not None)
        if target_enabled:
            if reopen or _state.file_handler is None:
                _detach_file_handler(root_logger)
                if _state.logs_dir is not None:
                    _attach_file_handler(root_logger, _state.logs_dir)
        else:
            _detach_file_handler(root_logger)

        _state.file_logging_enabled = target_enabled

        return {
            "enabled": _state.file_logging_enabled,
            "level": logging.getLevelName(root_logger.level),
            "device_id": _state.device_id,
            "session_id": _state.session_id,
        }


def get_logging_state() -> dict[str, Any]:
    root_logger = logging.getLogger()
    return {
        "enabled": _state.file_logging_enabled,
        "level": logging.getLevelName(root_logger.level),
        "device_id": _state.device_id,
        "session_id": _state.session_id,
    }


def _install_crash_hook() -> None:
    """Capture uncaught exceptions to crash/engine-{ts}.txt when logging is enabled."""
    if _state.crash_hook_installed:
        return
    _state.crash_hook_installed = True
    previous_hook = sys.excepthook

    def _crash_handler(
        exc_type: type[BaseException],
        exc_value: BaseException,
        exc_tb: TracebackType | None,
    ) -> None:
        if issubclass(exc_type, KeyboardInterrupt):
            previous_hook(exc_type, exc_value, exc_tb)
            return
        if _state.file_logging_enabled and _state.logs_dir is not None:
            try:
                crash_dir = _state.logs_dir / "crash"
                crash_dir.mkdir(parents=True, exist_ok=True)
                ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
                crash_path = crash_dir / f"engine-{ts}.txt"
                raw_tb = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
                with crash_path.open("w", encoding="utf-8") as f:
                    f.write(f"# PlumeLens engine crash @ {datetime.now(UTC).isoformat()}\n")
                    f.write(f"# DeviceId: {_state.device_id or 'unknown'}\n")
                    f.write(f"# SessionId: {_state.session_id or 'unknown'}\n")
                    f.write(f"# Python {sys.version}\n")
                    f.write(f"# Exception: {exc_type.__name__}: {redact_text(str(exc_value))}\n\n")
                    f.write(redact_text(raw_tb))
                logger = structlog.stdlib.get_logger()
                logger.error(
                    "Uncaught exception — engine crashing",
                    exc_type=exc_type.__name__,
                    exc_message=redact_text(str(exc_value)),
                    crash_dump=f"crash/engine-{ts}.txt",
                )
                _flush_active_handlers()
            except Exception:  # noqa: BLE001
                pass
        previous_hook(exc_type, exc_value, exc_tb)

    sys.excepthook = _crash_handler
