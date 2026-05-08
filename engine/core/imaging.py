"""Pillow / image decoding hardening.

PIL 默认 ``Image.MAX_IMAGE_PIXELS = 89_478_485`` (≈89 MP) — 这个上限对鸟摄
高分辨率工作流偏低(Sony α7R V 61 MP × 4× 上采样输出会超),但完全不限会让恶意
PNG/TIFF 通过 zlib bomb 在 ``Image.open`` 内分配几个 GB 触发 OOM。

折中:把上限设为 ``IMAGE_MAX_PIXELS`` (256 MP),覆盖到 1.4× 的 Sony α7R V × 4 +
合理 panorama / fine-art print 场景,仍然挡住 100 亿像素级 decompression bomb。
超过上限时 PIL 抛 ``Image.DecompressionBombError``,各 loader 已有 try/except
能优雅降级到"该图无法处理",不会让 worker / API request 直接挂。

调用 ``configure_pil_decompression_bomb_guard()`` 应在进程早期(lifespan startup
或 PyInstaller spawn)做一次,设置过程线程安全(PIL 内部就是模块级常量赋值)。
"""

from __future__ import annotations

import structlog
from PIL import Image

logger = structlog.stdlib.get_logger()

# Sony α7R V (61 MP) × 4× 上采样 = 244 MP;留 5% 缓冲 ≈ 256 MP。
# 改这个数请同步评估:导入旧巨图(全景拼接、扫描底片)是否会被拒绝。
IMAGE_MAX_PIXELS: int = 256_000_000


def configure_pil_decompression_bomb_guard(max_pixels: int = IMAGE_MAX_PIXELS) -> None:
    """Cap ``PIL.Image.MAX_IMAGE_PIXELS`` so decompression bombs raise instead of OOM.

    Idempotent — only updates when the new cap is more permissive than the
    current Pillow default (≈ 89 MP) so unit tests that explicitly lower the
    limit don't get clobbered. Caller invokes once at process startup.
    """
    current = Image.MAX_IMAGE_PIXELS
    if current is not None and current >= max_pixels:
        return
    Image.MAX_IMAGE_PIXELS = max_pixels
    logger.debug(
        "PIL decompression-bomb cap set",
        max_pixels=max_pixels,
        previous=current,
    )
