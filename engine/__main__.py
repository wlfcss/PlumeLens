"""Entry point for `python -m engine` and PyInstaller-frozen binary.

本模块拉起 uvicorn 服务 PlumeLens Engine（FastAPI app），由 Electron 主进程
作为子进程启动。通过 stdout 打印 `PLUMELENS_PORT <port>` 让主进程读到实际
绑定的端口号（port=0 → 内核分配空闲端口）。

⚠ 关键修复（2026-04-27）：
1. multiprocessing.freeze_support() 必须最先调用 — PyInstaller frozen 二进制 +
   macOS 'spawn' 模式下，torch/transformers/pyarrow 等库内部 spawn 子进程时会
   重新执行整个二进制；没有 freeze_support()，子进程会跑完整 main() →
   加载完整模型 + 启动 uvicorn 听新端口 → **每次实际启动 N 个 engine** →
   每个吃 2GB+ MPS 内存 → 系统秒爆。
2. TOKENIZERS_PARALLELISM=false 关掉 HF tokenizers 内部的并行 worker，
   减少 fork 概率（即便 freeze_support 兜底了，也能少一层）。
3. uvicorn 显式 workers=1 防止意外被 env 覆盖到 multi-worker。
"""

from __future__ import annotations

import multiprocessing
import os
import socket
import sys


def _find_free_port(host: str) -> int:
    """Bind a socket to port 0 to have the kernel pick a free port, then close it.

    Small race window between close and uvicorn re-bind — for a single-user desktop
    app this is acceptable and simpler than passing a socket handle to uvicorn.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def main() -> None:
    # 关掉 transformers tokenizers 的并行（不需要，会 fork worker）
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    host = os.environ.get("PLUMELENS_HOST", "127.0.0.1")
    # PLUMELENS_PORT=0 或未设 → 随机端口；Electron 主进程从 stdout 读
    requested = int(os.environ.get("PLUMELENS_PORT", "0"))
    port = requested if requested > 0 else _find_free_port(host)

    # 提前把端口打到 stdout，让 Electron 进程管理器能在 uvicorn 完全启动前
    # 就拿到端口（简化握手协议）
    print(f"PLUMELENS_PORT {port}", flush=True)

    # 延迟 import uvicorn — freeze_support 必须先于任何会 spawn 子进程的代码
    import uvicorn

    uvicorn.run(
        "engine.main:app",
        host=host,
        port=port,
        log_level=os.environ.get("PLUMELENS_LOG_LEVEL", "info").lower(),
        access_log=False,
        workers=1,  # 显式单进程；Electron 子进程模型不需要多 worker
    )


if __name__ == "__main__":
    # ⚠ 必须最先调用：让 PyInstaller frozen 二进制的子进程（multiprocessing 自动
    # 创建的 helper / resource_tracker）能识别自己是 child，立即 return 而不是
    # 跑完整 main() 重新加载所有模型。
    multiprocessing.freeze_support()
    sys.exit(main() or 0)
