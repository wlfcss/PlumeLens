"""Render the DMG installer window background to ``build/dmg-background.png``.

The DMG mount window is laid out as 640×400 logical points. **Finder treats the
background image as 1 pixel = 1 logical point**, ignoring PNG @2x conventions —
so we render at 640×400 native (1×) and rely on Finder's bilinear upscale on
retina displays. Going 2× (1280×800) makes Finder show only the top-left
quadrant of the image (经测试: 标题与提示会被裁出窗口外)。

Background design:
- Soft top→bottom gradient (鉴翎 brand: 浅蓝紫色调 → 接近白)
- 顶部一条品牌渐变细带 (蓝→紫)
- 中央一条手绘风格弧形箭头,从 .app 图标位置指向 Applications 位置
- 顶部标题 "欢迎使用 鉴翎",底部一行中文安装提示

App + Applications 图标由 Finder 通过 AppleScript 定位叠加上去 — 这张背景
不画图标,只在它们的预留位置之间画箭头与文字。改图标坐标(scripts/build-dmg.cjs
里 osascript 段)请同步更新这里的 LEFT_ICON_CENTER / RIGHT_ICON_CENTER。

regenerate: ``uv run python scripts/build_dmg_background.py``
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "build"

# 与 DMG 窗口逻辑大小 1:1 — Finder 不识别 @2x。
W = 640
H = 400

# 与 build-dmg.cjs 内 AppleScript 的图标坐标保持一致;128 px 图标中心点。
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


def _vertical_gradient(draw: ImageDraw.ImageDraw, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> None:
    """Fill the canvas with a smooth vertical gradient."""
    for y in range(H):
        t = y / max(H - 1, 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))


def _accent_band(draw: ImageDraw.ImageDraw) -> None:
    """顶部一条品牌色细带,模糊横向渐变。"""
    band_h = 4
    for x in range(W):
        t = x / max(W - 1, 1)
        # 蓝(#5a7adf)→ 紫(#a072e8)
        r = int(0x5A + (0xA0 - 0x5A) * t)
        g = int(0x7A + (0x72 - 0x7A) * t)
        b = int(0xDF + (0xE8 - 0xDF) * t)
        draw.line([(x, 0), (x, band_h)], fill=(r, g, b))


def _curved_arrow(draw: ImageDraw.ImageDraw) -> None:
    """两图标之间的弧形箭头(quadratic Bezier + 三角箭头)。"""
    start_x = LEFT_ICON_CENTER[0] + ICON_RADIUS + 16
    end_x = RIGHT_ICON_CENTER[0] - ICON_RADIUS - 16
    arrow_y = LEFT_ICON_CENTER[1]
    ctrl_x = (start_x + end_x) // 2
    ctrl_y = arrow_y - 28  # 向上拱起

    color = (90, 100, 130)
    width = 2
    n = 60
    prev = (start_x, arrow_y)
    for i in range(1, n + 1):
        t = i / n
        x = int((1 - t) ** 2 * start_x + 2 * (1 - t) * t * ctrl_x + t**2 * end_x)
        y = int((1 - t) ** 2 * arrow_y + 2 * (1 - t) * t * ctrl_y + t**2 * arrow_y)
        draw.line([prev, (x, y)], fill=color, width=width)
        prev = (x, y)

    # 箭头三角(指向 +x 方向,稍微顺着切线倾斜)
    head_len = 14
    head_w = 9
    head = [
        (end_x, arrow_y),
        (end_x - head_len, arrow_y - head_w),
        (end_x - head_len + 3, arrow_y),
        (end_x - head_len, arrow_y + head_w),
    ]
    draw.polygon(head, fill=color)


def _text(draw: ImageDraw.ImageDraw, text: str, y: int, size: int, color: tuple[int, int, int]) -> None:
    font = _load_font(size)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((W - tw) // 2, y), text, fill=color, font=font)


def render() -> Image.Image:
    img = Image.new("RGB", (W, H), (248, 249, 252))
    draw = ImageDraw.Draw(img)

    # 1) 主背景 vertical gradient(米白 → 浅紫灰)
    _vertical_gradient(draw, top=(248, 249, 253), bottom=(232, 235, 244))

    # 2) 顶部品牌色细带 — 视觉上一眼区分"这是 PlumeLens 的安装窗口"
    _accent_band(draw)

    # 3) 标题 + 副标题
    _text(draw, "欢迎使用 鉴翎", y=42, size=22, color=(40, 48, 76))
    _text(
        draw,
        "PlumeLens · 鸟类摄影智能选片",
        y=72,
        size=12,
        color=(120, 130, 160),
    )

    # 4) 弧形箭头(图标在 Finder 端覆盖上来,这里只在两个图标之间画引导线)
    _curved_arrow(draw)

    # 5) 底部安装提示
    _text(
        draw,
        "将左侧「鉴翎」拖入右侧「应用程序」即可完成安装",
        y=292,
        size=14,
        color=(70, 80, 110),
    )
    _text(
        draw,
        "首次启动需在「系统设置 → 隐私与安全」允许运行(应用未做公证签名)",
        y=326,
        size=10,
        color=(150, 160, 185),
    )

    return img


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img = render()
    out_path = OUT_DIR / "dmg-background.png"
    # 显式写 144 DPI 元数据(PNG pHYs chunk):部分 macOS Finder 版本会按
    # 像素密度反推 logical 大小;72 DPI 是默认每像素 1 点,144 DPI 把每像素当
    # 0.5 点 — 兼容性是有限的,主流情况仍按"1 px = 1 point"渲染,所以画布也
    # 就只能 640×400 native。
    # 不写 DPI 元数据 — Finder 会按 (img_dpi / 72) 反推 logical 大小,144 DPI 会被
    # 当成"image is 320 logical points wide",最终窗口里背景只覆盖左上 320×200 区域
    # (实测过)。72 DPI 或不写则正确按 1px=1point 处理。
    img.save(out_path, optimize=True)
    print(f"Wrote {out_path} ({W}x{H})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
