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

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "build"

# DMG 窗口逻辑大小 (logical points / @1× pixels)。
W_LOGICAL = 640
H_LOGICAL = 400

# 与 build-dmg.cjs 内 .DS_Store 写入坐标保持一致;128 px 图标中心点 (logical)。
LEFT_ICON_CENTER = (180, 176)
RIGHT_ICON_CENTER = (460, 176)
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


def _layer(size: tuple[int, int]) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def _accent_band(draw: ImageDraw.ImageDraw, *, width: int, scale: int) -> None:
    """顶部一条很轻的品牌色细线,保留原风格但降低存在感。"""
    band_h = 2 * scale
    for x in range(width):
        t = x / max(width - 1, 1)
        r = int(0x5F + (0x7E - 0x5F) * t)
        g = int(0x83 + (0xB8 - 0x83) * t)
        b = int(0xD8 + (0xC7 - 0xD8) * t)
        draw.line([(x, 0), (x, band_h)], fill=(r, g, b))


def _curved_arrow(draw: ImageDraw.ImageDraw, *, scale: int) -> None:
    """两图标之间的弧形箭头(quadratic Bezier + 三角箭头),坐标按 scale 放大。"""
    start_x = (LEFT_ICON_CENTER[0] + ICON_RADIUS + 18) * scale
    end_x = (RIGHT_ICON_CENTER[0] - ICON_RADIUS - 18) * scale
    arrow_y = (LEFT_ICON_CENTER[1] - 2) * scale
    ctrl_x = (start_x + end_x) // 2
    ctrl_y = arrow_y - 22 * scale

    shadow = (255, 255, 255, 190)
    color = (86, 99, 132)
    width = 2 * scale
    # @2× 翻倍采样段数,弧线更平滑
    n = 120 if scale >= 2 else 60
    prev = (start_x, arrow_y)
    segments = []
    for i in range(1, n + 1):
        t = i / n
        x = int((1 - t) ** 2 * start_x + 2 * (1 - t) * t * ctrl_x + t**2 * end_x)
        y = int((1 - t) ** 2 * arrow_y + 2 * (1 - t) * t * ctrl_y + t**2 * arrow_y)
        segments.append((prev, (x, y)))
        prev = (x, y)

    for segment in segments:
        draw.line(segment, fill=shadow, width=width + scale)
    for segment in segments:
        draw.line(segment, fill=color, width=width)

    head_len = 12 * scale
    head_w = 8 * scale
    head = [
        (end_x, arrow_y),
        (end_x - head_len, arrow_y - head_w),
        (end_x - head_len + 3 * scale, arrow_y),
        (end_x - head_len, arrow_y + head_w),
    ]
    draw.polygon(head, fill=color)


def _soft_panel(
    base: Image.Image,
    *,
    scale: int,
    center: tuple[int, int],
    width: int = 168,
    height: int = 174,
) -> None:
    """Icon landing area. Finder draws the actual icons on top."""
    panel_w = width * scale
    panel_h = height * scale
    x0 = center[0] * scale - panel_w // 2
    y0 = center[1] * scale - panel_h // 2 - 2 * scale
    x1 = x0 + panel_w
    y1 = y0 + panel_h
    radius = 22 * scale

    shadow, shadow_draw = _layer(base.size)
    shadow_draw.rounded_rectangle(
        (x0, y0 + 5 * scale, x1, y1 + 5 * scale),
        radius=radius,
        fill=(38, 49, 75, 26),
    )
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(12 * scale)))

    panel, panel_draw = _layer(base.size)
    panel_draw.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=radius,
        fill=(255, 255, 255, 132),
        outline=(255, 255, 255, 190),
        width=max(scale, 1),
    )
    panel_draw.rounded_rectangle(
        (x0 + scale, y0 + scale, x1 - scale, y1 - scale),
        radius=radius - scale,
        outline=(170, 180, 205, 45),
        width=max(scale, 1),
    )
    base.alpha_composite(panel)


def _feather_lines(base: Image.Image, *, scale: int) -> None:
    """Subtle decorative feather contour in the top-right background."""
    layer, draw = _layer(base.size)
    color = (83, 103, 143, 30)
    ox = 424 * scale
    oy = 54 * scale
    for i in range(7):
        y = oy + i * 10 * scale
        draw.arc(
            (ox - 30 * scale, y - 42 * scale, ox + 116 * scale, y + 44 * scale),
            start=194,
            end=336,
            fill=color,
            width=max(1, scale),
        )
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.2 * scale)))


def _bottom_rule(base: Image.Image, *, scale: int) -> None:
    layer, draw = _layer(base.size)
    y = 284 * scale
    draw.line(
        [(132 * scale, y), (508 * scale, y)],
        fill=(136, 149, 178, 64),
        width=max(1, scale),
    )
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.15 * scale)))


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
    img = Image.new("RGBA", (width, height), (248, 249, 252, 255))
    draw = ImageDraw.Draw(img)

    # 1) 主背景 vertical gradient(米白 → 浅紫灰)
    _vertical_gradient(
        draw,
        width=width,
        height=height,
        top=(249, 251, 254),
        bottom=(234, 238, 246),
    )

    glow, glow_draw = _layer((width, height))
    glow_draw.ellipse(
        (54 * scale, -138 * scale, 586 * scale, 226 * scale),
        fill=(255, 255, 255, 96),
    )
    glow_draw.ellipse(
        (384 * scale, 120 * scale, 780 * scale, 520 * scale),
        fill=(95, 131, 196, 28),
    )
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(34 * scale)))

    # 2) 顶部品牌色细带 + 轻羽形纹理
    _accent_band(draw, width=width, scale=scale)
    _feather_lines(img, scale=scale)

    # 3) 标题 + 副标题
    _text(
        draw,
        "鉴翎",
        width=width,
        y=38 * scale,
        size=27 * scale,
        color=(35, 45, 69),
    )
    _text(
        draw,
        "PlumeLens 0.7.0",
        width=width,
        y=72 * scale,
        size=12 * scale,
        color=(112, 124, 150),
    )

    # 4) 图标承托区域 + 弧形箭头
    _soft_panel(img, scale=scale, center=LEFT_ICON_CENTER)
    _soft_panel(img, scale=scale, center=RIGHT_ICON_CENTER)
    _curved_arrow(draw, scale=scale)

    # 5) 底部安装提示
    _bottom_rule(img, scale=scale)
    _text(
        draw,
        "拖拽安装",
        width=width,
        y=302 * scale,
        size=15 * scale,
        color=(55, 66, 92),
    )
    _text(
        draw,
        "将 PlumeLens 拖入 Applications",
        width=width,
        y=329 * scale,
        size=10 * scale,
        color=(126, 137, 160),
    )

    return img.convert("RGB")


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
