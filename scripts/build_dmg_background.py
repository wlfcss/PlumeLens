"""Render the DMG installer window background as a HiDPI multi-rep TIFF.

DMG 窗口是 640×400 logical points。Finder 早期版本只识别 1px=1pt 的 PNG/JPEG,
导致 retina 设备上靠 bilinear 升采样,看上去文字 + 箭头都软糊。新版 Finder 支持
**multi-representation TIFF**(每个表示带不同 DPI),会按显示器选最匹配的那个 —
做法 = ``tiffutil -cathidpicheck base@1x.tiff base@2x.tiff -out background.tiff``,
其中 @1x 是 72 DPI 的 640×400,@2x 是 144 DPI 的 1280×800。

本脚本:
1. 用 PIL 分别渲染两个分辨率的 PNG (font / 线宽 / 坐标全部按 scale 等比放大)
2. 用 sips 把 PNG 转 TIFF 并打标 DPI
3. 用 tiffutil 合成一个 background.tiff(同时含 1× + 2× 表示)

retina 用户挂载时 Finder 取 144 DPI 的 1280×800,字体清晰;1× 屏幕取 640×400 直接
按 1:1 渲染,也是清晰。

regenerate: ``uv run python scripts/build_dmg_background.py``
失败兜底:多 rep TIFF 没生成时(系统缺 sips/tiffutil),build-dmg.cjs 会回落到
单 rep PNG。
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "build"

# DMG 窗口逻辑大小 (logical points / @1× pixels)。
W_LOGICAL = 640
H_LOGICAL = 400

# 与 build-dmg.cjs 内 AppleScript 的图标坐标保持一致;128 px 图标中心点 (logical)。
LEFT_ICON_CENTER = (180, 188)
RIGHT_ICON_CENTER = (460, 188)
ICON_RADIUS = 64

# 字体优先级:macOS 系统字体即可。无中文 fallback 时降级到 default,生成的图
# 仍可用,只是中文显示成方块 — 提示开发者装一份 PingFang。
FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
]


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _vertical_gradient(
    draw: ImageDraw.ImageDraw,
    *,
    width: int,
    height: int,
    top: tuple[int, int, int],
    bottom: tuple[int, int, int],
) -> None:
    for y in range(height):
        t = y / max(height - 1, 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        draw.line([(0, y), (width, y)], fill=(r, g, b))


def _accent_band(draw: ImageDraw.ImageDraw, *, width: int, scale: int) -> None:
    """顶部一条品牌色细带,模糊横向渐变。"""
    band_h = 4 * scale
    for x in range(width):
        t = x / max(width - 1, 1)
        r = int(0x5A + (0xA0 - 0x5A) * t)
        g = int(0x7A + (0x72 - 0x7A) * t)
        b = int(0xDF + (0xE8 - 0xDF) * t)
        draw.line([(x, 0), (x, band_h)], fill=(r, g, b))


def _curved_arrow(draw: ImageDraw.ImageDraw, *, scale: int) -> None:
    """两图标之间的弧形箭头(quadratic Bezier + 三角箭头),坐标按 scale 放大。"""
    start_x = (LEFT_ICON_CENTER[0] + ICON_RADIUS + 16) * scale
    end_x = (RIGHT_ICON_CENTER[0] - ICON_RADIUS - 16) * scale
    arrow_y = LEFT_ICON_CENTER[1] * scale
    ctrl_x = (start_x + end_x) // 2
    ctrl_y = arrow_y - 28 * scale

    color = (90, 100, 130)
    width = 2 * scale
    # @2× 翻倍采样段数,弧线更平滑
    n = 120 if scale >= 2 else 60
    prev = (start_x, arrow_y)
    for i in range(1, n + 1):
        t = i / n
        x = int((1 - t) ** 2 * start_x + 2 * (1 - t) * t * ctrl_x + t**2 * end_x)
        y = int((1 - t) ** 2 * arrow_y + 2 * (1 - t) * t * ctrl_y + t**2 * arrow_y)
        draw.line([prev, (x, y)], fill=color, width=width)
        prev = (x, y)

    head_len = 14 * scale
    head_w = 9 * scale
    head = [
        (end_x, arrow_y),
        (end_x - head_len, arrow_y - head_w),
        (end_x - head_len + 3 * scale, arrow_y),
        (end_x - head_len, arrow_y + head_w),
    ]
    draw.polygon(head, fill=color)


def _text(
    draw: ImageDraw.ImageDraw,
    text: str,
    *,
    width: int,
    y: int,
    size: int,
    color: tuple[int, int, int],
) -> None:
    font = _load_font(size)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((width - tw) // 2, y), text, fill=color, font=font)


def render(scale: int) -> Image.Image:
    """Render the background at the given pixel scale (1 → 640×400, 2 → 1280×800)."""
    width = W_LOGICAL * scale
    height = H_LOGICAL * scale
    img = Image.new("RGB", (width, height), (248, 249, 252))
    draw = ImageDraw.Draw(img)

    # 1) 主背景 vertical gradient(米白 → 浅紫灰)
    _vertical_gradient(
        draw,
        width=width,
        height=height,
        top=(248, 249, 253),
        bottom=(232, 235, 244),
    )

    # 2) 顶部品牌色细带
    _accent_band(draw, width=width, scale=scale)

    # 3) 标题 + 副标题
    _text(
        draw,
        "欢迎使用 鉴翎",
        width=width,
        y=42 * scale,
        size=22 * scale,
        color=(40, 48, 76),
    )
    _text(
        draw,
        "PlumeLens · 鸟类摄影智能选片",
        width=width,
        y=72 * scale,
        size=12 * scale,
        color=(120, 130, 160),
    )

    # 4) 弧形箭头
    _curved_arrow(draw, scale=scale)

    # 5) 底部安装提示
    _text(
        draw,
        "将左侧「鉴翎」拖入右侧「应用程序」即可完成安装",
        width=width,
        y=292 * scale,
        size=14 * scale,
        color=(70, 80, 110),
    )
    _text(
        draw,
        "首次启动需在「系统设置 → 隐私与安全」允许运行(应用未做公证签名)",
        width=width,
        y=326 * scale,
        size=10 * scale,
        color=(150, 160, 185),
    )

    return img


def _png_to_tiff(png_path: Path, tiff_path: Path, dpi: int) -> None:
    """sips: 把 PNG 转成 TIFF 并打 DPI 标记。 tiffutil 用 DPI 区分 1×/2× rep。"""
    subprocess.run(
        [
            "sips",
            "-s",
            "format",
            "tiff",
            "-s",
            "dpiHeight",
            str(dpi),
            "-s",
            "dpiWidth",
            str(dpi),
            str(png_path),
            "--out",
            str(tiff_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _build_hidpi_tiff(low_png: Path, high_png: Path, out_tiff: Path) -> bool:
    """合成 multi-rep TIFF;失败返回 False(系统缺 sips/tiffutil)。"""
    if not (shutil.which("sips") and shutil.which("tiffutil")):
        return False
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        low_tiff = td_path / "low.tiff"
        high_tiff = td_path / "high.tiff"
        try:
            _png_to_tiff(low_png, low_tiff, dpi=72)
            _png_to_tiff(high_png, high_tiff, dpi=144)
            subprocess.run(
                [
                    "tiffutil",
                    "-cathidpicheck",
                    str(low_tiff),
                    str(high_tiff),
                    "-out",
                    str(out_tiff),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except subprocess.CalledProcessError:
            return False
    return True


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # @1× 与 @2× 各渲一份 — PIL freetype 直接按对应像素大小绘制字体,不是简单
    # upsample,所以两份都是矢量级清晰。
    png_1x = OUT_DIR / "dmg-background.png"
    png_2x = OUT_DIR / "dmg-background@2x.png"
    render(scale=1).save(png_1x, optimize=True)
    render(scale=2).save(png_2x, optimize=True)
    print(f"Wrote {png_1x} ({W_LOGICAL}x{H_LOGICAL})")
    print(f"Wrote {png_2x} ({W_LOGICAL * 2}x{H_LOGICAL * 2})")

    # 合成 HiDPI multi-rep TIFF — Finder 在 retina 设备上按 144 DPI rep 渲染。
    tiff_path = OUT_DIR / "dmg-background.tiff"
    if _build_hidpi_tiff(png_1x, png_2x, tiff_path):
        print(f"Wrote {tiff_path} (multi-rep 1× + 2× HiDPI)")
    else:
        print("WARN: sips/tiffutil unavailable, skipping HiDPI TIFF; build-dmg falls back to PNG")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
