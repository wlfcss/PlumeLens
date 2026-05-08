# pyright: basic
"""生成 e2e 测试用的纯色 JPEG fixture photos。

用途:e2e-electron spec 启动 Electron app 后会调 /library/import 指向这个目录,
扫描入库 + 跑分析(birds=0 走 YOLO 一遍,~300ms 一张)。这些图片**不入 git**
(.gitignore 已忽略),首次跑 e2e 时由 playwright global setup 自动生成。

运行:`uv run python tests/e2e-electron/fixtures/generate_photos.py`
或被 e2e setup 自动 spawn。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

OUTPUT_DIR = Path(__file__).parent / "sample_photos"
# 5 张不同色调,文件名仿真相机命名让 EXIF 解析路径走完
COLORS: tuple[tuple[str, tuple[int, int, int]], ...] = (
    ("IMG_0001.JPG", (40, 100, 60)),    # 深绿
    ("IMG_0002.JPG", (180, 90, 50)),    # 砖红
    ("IMG_0003.JPG", (70, 130, 200)),   # 天蓝
    ("IMG_0004.JPG", (200, 200, 160)),  # 米黄
    ("IMG_0005.JPG", (90, 70, 110)),    # 暗紫
)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, color in COLORS:
        path = OUTPUT_DIR / name
        # 256×192 是常见 4:3 比例,够大让 PIL/scanner 不当成 thumb 跳过,
        # 又足够小(<5 KB)让分析飞快。
        Image.new("RGB", (256, 192), color).save(path, "JPEG", quality=85)
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
