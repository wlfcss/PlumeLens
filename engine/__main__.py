"""Entry point for `python -m engine` and PyInstaller-frozen binary.

本模块拉起 uvicorn 服务 PlumeLens Engine（FastAPI app），由 Electron 主进程
作为子进程启动。通过 stdout 打印 `PLUMELENS_PORT <port>` 让主进程读到实际
绑定的端口号（port=0 → 内核分配空闲端口）。
"""
from __future__ import annotations

import os
import socket
import sys

import uvicorn


def _find_free_port(host: str) -> int:
    """Bind a socket to port 0 to have the kernel pick a free port, then close it.

    Small race window between close and uvicorn re-bind — for a single-user desktop
    app this is acceptable and simpler than passing a socket handle to uvicorn.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def main() -> None:
    host = os.environ.get("PLUMELENS_HOST", "127.0.0.1")
    # PLUMELENS_PORT=0 或未设 → 随机端口；Electron 主进程从 stdout 读
    requested = int(os.environ.get("PLUMELENS_PORT", "0"))
    port = requested if requested > 0 else _find_free_port(host)

    # 提前把端口打到 stdout，让 Electron 进程管理器能在 uvicorn 完全启动前
    # 就拿到端口（简化握手协议）
    print(f"PLUMELENS_PORT {port}", flush=True)

    uvicorn.run(
        "engine.main:app",
        host=host,
        port=port,
        log_level=os.environ.get("PLUMELENS_LOG_LEVEL", "info"),
        access_log=False,
    )


if __name__ == "__main__":
    sys.exit(main() or 0)
