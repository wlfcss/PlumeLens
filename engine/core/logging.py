"""Structured logging setup with structlog.

双输出（stderr console + 文件 JSON）+ 崩溃 traceback 捕获。

为什么需要文件日志：
process-manager.ts 监听 engine 子进程 stderr 只用于解析 PORT/READY 字符串，
内容丢弃 → packaged 应用崩溃后没有任何 trace 可查。本模块把 structlog
事件同时写到 ~/Library/Application Support/plumelens/logs/engine.jsonl
（10MB × 5 轮转），未捕获异常额外写到 logs/crash/engine-{ts}.txt。

PyInstaller binary 自身的 stderr（uvicorn 启动错误 / segfault / OS 错误）
则由 Electron 的 process-manager.ts 单独转发到 logs/engine.stderr.{ts}.log。
"""

from __future__ import annotations

import atexit
import contextlib
import logging
import logging.handlers
import sys
import traceback
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    from types import TracebackType


_FILE_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
_FILE_LOG_BACKUP_COUNT = 5


def setup_logging(
    *,
    log_level: str = "INFO",
    logs_dir: Path | None = None,
) -> None:
    """Configure structlog with stderr (human-readable) + optional file (JSON) outputs.

    Args:
        log_level: 根 logger 级别(INFO/DEBUG/WARNING/ERROR)
        logs_dir: 给值就启用文件日志和 crash hook(写入 logs_dir/engine.jsonl 与
            logs_dir/crash/engine-{ts}.txt)。pytest / standalone 不传 → 仅 stderr。
    """
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
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

    console_formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.dev.ConsoleRenderer(),
        ],
    )
    json_formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
    )

    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(console_formatter)

    handlers: list[logging.Handler] = [stderr_handler]

    if logs_dir is not None:
        logs_dir.mkdir(parents=True, exist_ok=True)
        crash_dir = logs_dir / "crash"
        crash_dir.mkdir(parents=True, exist_ok=True)

        file_handler = logging.handlers.RotatingFileHandler(
            filename=logs_dir / "engine.jsonl",
            maxBytes=_FILE_LOG_MAX_BYTES,
            backupCount=_FILE_LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setFormatter(json_formatter)
        handlers.append(file_handler)

        # 进程退出前 flush 所有 handler — 防止 SIGTERM / 崩溃前 buffer 内日志丢失
        def _flush_handlers() -> None:
            for h in handlers:
                with contextlib.suppress(Exception):
                    h.flush()

        atexit.register(_flush_handlers)

        # 捕获未处理异常 → 写 crash/engine-{ts}.txt
        _install_crash_hook(crash_dir)

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    for handler in handlers:
        root_logger.addHandler(handler)
    root_logger.setLevel(log_level.upper())

    # Quieten noisy loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def _install_crash_hook(crash_dir: Path) -> None:
    """Capture uncaught exceptions to crash/engine-{ts}.txt with full traceback."""
    previous_hook = sys.excepthook

    def _crash_handler(
        exc_type: type[BaseException],
        exc_value: BaseException,
        exc_tb: TracebackType | None,
    ) -> None:
        # KeyboardInterrupt 是用户主动 Ctrl-C，不算崩溃
        if issubclass(exc_type, KeyboardInterrupt):
            previous_hook(exc_type, exc_value, exc_tb)
            return
        try:
            ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            crash_path = crash_dir / f"engine-{ts}.txt"
            with crash_path.open("w", encoding="utf-8") as f:
                f.write(f"# PlumeLens engine crash @ {datetime.now(UTC).isoformat()}\n")
                f.write(f"# Python {sys.version}\n")
                f.write(f"# Exception: {exc_type.__name__}: {exc_value}\n\n")
                traceback.print_exception(exc_type, exc_value, exc_tb, file=f)
            # 同时让结构化 logger 留一条记录（如果 file handler 还活着会进 jsonl）
            logger = structlog.stdlib.get_logger()
            logger.error(
                "Uncaught exception — engine crashing",
                exc_type=exc_type.__name__,
                exc_message=str(exc_value),
                crash_dump=str(crash_path),
            )
        except Exception:  # noqa: BLE001
            # crash hook 自己也挂掉就 fallback 到原 hook（通常打印到 stderr）
            pass
        previous_hook(exc_type, exc_value, exc_tb)

    sys.excepthook = _crash_handler
