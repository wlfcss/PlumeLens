"""Tests for engine.core.logging — file output + crash hook 持久化。"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import pytest
import structlog

from engine.core.logging import setup_logging


@pytest.fixture(autouse=True)
def _restore_logging():
    """每个 test 后清空 root logger handlers 与 sys.excepthook，避免 cross-test 污染。"""
    original_hook = sys.excepthook
    yield
    sys.excepthook = original_hook
    root = logging.getLogger()
    root.handlers.clear()


def test_setup_without_logs_dir_only_writes_stderr(tmp_path: Path) -> None:
    setup_logging(log_level="DEBUG")
    handlers = logging.getLogger().handlers
    assert len(handlers) == 1
    assert isinstance(handlers[0], logging.StreamHandler)
    # 不该创建 logs 目录
    assert not (tmp_path / "logs").exists()


def test_setup_with_logs_dir_creates_dir_and_jsonl(tmp_path: Path) -> None:
    logs_dir = tmp_path / "logs"
    setup_logging(log_level="DEBUG", logs_dir=logs_dir)

    # logs/ + crash/ 都应该被创建
    assert logs_dir.exists()
    assert (logs_dir / "crash").exists()

    # 写一条结构化日志
    logger = structlog.stdlib.get_logger()
    logger.info("smoke test", photo_id="abc-123", count=42)

    # flush（RotatingFileHandler 默认 buffering）
    for h in logging.getLogger().handlers:
        h.flush()

    log_file = logs_dir / "engine.jsonl"
    assert log_file.exists()
    content = log_file.read_text(encoding="utf-8").strip()
    # 至少一条 JSON 行
    lines = [line for line in content.split("\n") if line]
    assert len(lines) >= 1
    # 最后一条应该能解析为 JSON 且包含我们的字段
    last = json.loads(lines[-1])
    assert last["event"] == "smoke test"
    assert last["photo_id"] == "abc-123"
    assert last["count"] == 42
    assert last["level"] == "info"
    assert "timestamp" in last


def test_crash_hook_writes_traceback_to_crash_dir(tmp_path: Path) -> None:
    logs_dir = tmp_path / "logs"
    setup_logging(log_level="INFO", logs_dir=logs_dir)
    crash_dir = logs_dir / "crash"
    assert crash_dir.exists()

    # 模拟未捕获异常 — 直接调 sys.excepthook（这就是 Python 在异常未处理时做的事）
    try:
        raise ValueError("test crash payload")
    except ValueError:
        exc_type, exc_value, exc_tb = sys.exc_info()
        sys.excepthook(exc_type, exc_value, exc_tb)  # type: ignore[arg-type]

    crash_files = list(crash_dir.glob("engine-*.txt"))
    assert len(crash_files) == 1, f"expected exactly one crash dump, got {crash_files}"
    content = crash_files[0].read_text(encoding="utf-8")
    assert "ValueError: test crash payload" in content
    assert "Traceback" in content


def test_crash_hook_passes_through_keyboard_interrupt(tmp_path: Path) -> None:
    """Ctrl-C 不算崩溃，不应生成 crash dump。"""
    logs_dir = tmp_path / "logs"
    setup_logging(log_level="INFO", logs_dir=logs_dir)
    crash_dir = logs_dir / "crash"

    try:
        raise KeyboardInterrupt()
    except KeyboardInterrupt:
        exc_type, exc_value, exc_tb = sys.exc_info()
        # KeyboardInterrupt 应该走 previous_hook（默认 print），不写文件
        sys.excepthook(exc_type, exc_value, exc_tb)  # type: ignore[arg-type]

    crash_files = list(crash_dir.glob("engine-*.txt"))
    assert crash_files == []
