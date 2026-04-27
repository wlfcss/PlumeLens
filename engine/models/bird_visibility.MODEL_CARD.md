# Bird Visibility Detector v1.1

鸟类头部/眼睛可见性检测 — 跨平台部署包。

> **本包同时提供 PyTorch (.pt) 和 ONNX (.onnx) 两种权重文件。**
> 通过 `BirdVisibilityDetector.auto()` 自动按平台选择最优组合：
> - macOS Apple Silicon → `.pt + MPS`（最快，~26 ms/图）
> - Windows / Linux / 其他 → `.onnx + CPU`（跨平台，~170 ms/图）

---

## 1. 快速开始（30 秒上手）

### 1.1 解压并安装依赖

**macOS（Apple Silicon）：**

```bash
pip install -r requirements.txt
```

**Windows / Linux（不需要 PyTorch）：**

```bash
pip install -r requirements_onnx.txt
```

### 1.2 命令行测试

```bash
python -m bird_visibility path/to/bird.jpg
```

输出样例：

```
Detected 1 bird(s):
  #1  conf=0.927  head=YES  eye=YES  bbox=(303, 142, 964, 652)
      keypoints: bill=1.00  crown=1.00  nape=1.00  left_eye=1.00  right_eye=0.00
```

### 1.3 三行代码集成

```python
from bird_visibility import BirdVisibilityDetector

detector = BirdVisibilityDetector.auto()  # 自动选 .pt+mps 或 .onnx+cpu
for bird in detector.detect("photo.jpg"):
    print(bird.head_visible, bird.eye_visible, bird.box_conf)
```

---

## 2. 包结构

```
bird_visibility_pkg/
├── README.md                            ← 本文件
├── INTEGRATION_GUIDE.md                 ← 完整集成手册
├── requirements.txt                     ← 全功能依赖（含 PyTorch）
├── requirements_onnx.txt                ← 仅 ONNX 推理依赖（更小）
├── bird_visibility/                     ← Python 包本体
│   ├── __init__.py
│   ├── detector.py                      ← 核心 BirdVisibilityDetector 类
│   └── __main__.py                      ← CLI 入口
├── models/
│   ├── bird_visibility.pt               ← 161 MB · PyTorch 权重（Mac 推荐）
│   ├── bird_visibility.onnx             ← 98 MB · ONNX 权重（Windows 推荐）
│   └── bird_visibility_config.json      ← 校准阈值配置
└── examples/
    ├── basic_usage.py                   ← 最小示例（auto-detect）
    ├── batch_inference.py               ← 批量处理
    └── filter_usable_photos.py          ← 实战：筛选可用图 + 裁剪
```

---

## 3. 选哪个文件？

### 3.1 决策矩阵

| 平台 | 文件 | 设备 | 中位延迟 | 备注 |
|------|------|------|----------|------|
| **macOS Apple Silicon** | `.pt` | `mps` | **~26 ms** | 最快 |
| Windows / Linux x86 CPU | `.onnx` | `cpu` | ~170 ms | 跨平台首选 |
| NVIDIA GPU 服务器 | `.onnx` | `cuda` | ~10-15 ms | 需装 onnxruntime-gpu |
| iOS / iPadOS | `.onnx` 或自行转 CoreML | — | — | 移动端 |

> 表中"中位延迟"为单图前向推理耗时，imgsz=640，batch=1，不含图像加载/前处理。

### 3.2 自动选择（推荐）

让 `auto()` 替你决定：

```python
detector = BirdVisibilityDetector.auto(models_dir="models")
```

内部逻辑：

```
是 macOS Apple Silicon 且找到 .pt？  → .pt + mps
否则找到 .onnx？                     → .onnx + cpu
否则找到 .pt？                       → .pt + cpu  (回退)
都没有？                              → 抛 FileNotFoundError
```

### 3.3 显式指定

```python
# 强制 PyTorch
detector = BirdVisibilityDetector(
    weights="models/bird_visibility.pt",
    device="mps",  # 或 "cpu" / "cuda:0"
)

# 强制 ONNX
detector = BirdVisibilityDetector(
    weights="models/bird_visibility.onnx",
    device="cpu",  # ONNX 只支持 cpu/cuda 通过 onnxruntime 的 provider
)
```

---

## 4. 核心 API

### 4.1 `BirdVisibilityDetector`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `weights` | str \| Path | — | 权重文件路径（`.pt` 或 `.onnx`） |
| `config` | str \| Path \| None | None | 校准配置路径 |
| `device` | str | `"cpu"` | `cpu` / `mps` / `cuda:0` |
| `imgsz` | int | 640 | 推理分辨率 |
| `box_threshold` | float \| None | None（用配置） | 检测置信度阈值（建议 0.25） |
| `iou_threshold` | float | 0.3 | NMS IoU |

### 4.2 类方法

| 方法 | 返回 | 说明 |
|------|------|------|
| `BirdVisibilityDetector.auto(models_dir, config, **kwargs)` | `BirdVisibilityDetector` | 自动选最优配置 |

### 4.3 实例方法

| 方法 | 返回 | 说明 |
|------|------|------|
| `detect(source)` | `List[BirdDetection]` | 单张图（路径/PIL/numpy 均可） |
| `detect_batch(sources)` | `List[List[BirdDetection]]` | 批量 |
| `get_config()` | `Dict` | 当前阈值（调试） |

### 4.4 `BirdDetection` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `box_conf` | float | 检测置信度 |
| `box_xyxy` | tuple(x1,y1,x2,y2) | 像素坐标 |
| `keypoints_xy` | dict | 5 关键点像素坐标 |
| `keypoints_conf` | dict | 5 关键点置信度 |
| `head_visible` | bool | 头部可见 |
| `eye_visible` | bool | 眼睛可见 |
| `to_dict()` | dict | 序列化为 JSON 兼容字典 |

---

## 5. 完整示例

### 5.1 单图分析

```python
from bird_visibility import BirdVisibilityDetector

detector = BirdVisibilityDetector.auto()
print("Active config:", detector.get_config())

results = detector.detect("photo.jpg")
print(f"Detected {len(results)} bird(s)")

for i, bird in enumerate(results, 1):
    print(f"\nBird #{i}")
    print(f"  Confidence:    {bird.box_conf:.3f}")
    print(f"  Head visible:  {bird.head_visible}")
    print(f"  Eye visible:   {bird.eye_visible}")
    print(f"  BBox:          {bird.box_xyxy}")
    print(f"  Keypoints:")
    for name in ("bill", "crown", "nape", "left_eye", "right_eye"):
        x, y = bird.keypoints_xy[name]
        c = bird.keypoints_conf[name]
        print(f"    {name:10s} ({x:.0f}, {y:.0f})  conf={c:.3f}")
```

### 5.2 批量处理

```python
from pathlib import Path
from bird_visibility import BirdVisibilityDetector

detector = BirdVisibilityDetector.auto()

photo_dir = Path("input_photos")
photos = sorted(photo_dir.glob("*.jpg"))

print(f"Processing {len(photos)} photos...")
results = []
for path in photos:
    detections = detector.detect(path)
    results.append({
        "path": str(path),
        "num_birds": len(detections),
        "any_usable": any(d.head_visible and d.eye_visible for d in detections),
        "detections": [d.to_dict() for d in detections],
    })

# 统计
total = len(results)
usable = sum(1 for r in results if r["any_usable"])
print(f"\nUsable photos: {usable}/{total} ({usable/total*100:.1f}%)")
```

### 5.3 集成到下游物种分类

```python
from PIL import Image
from bird_visibility import BirdVisibilityDetector

detector = BirdVisibilityDetector.auto(box_threshold=0.30)

def extract_usable_birds(image_path):
    """筛选可用于物种分类的鸟体裁剪图。"""
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    crops = []
    for bird in detector.detect(image_path):
        if not (bird.head_visible and bird.eye_visible):
            continue
        x1, y1, x2, y2 = bird.box_xyxy
        # 加 10% padding 给后续分类器更多上下文
        bw, bh = x2 - x1, y2 - y1
        x1 = max(0, int(x1 - bw * 0.1))
        y1 = max(0, int(y1 - bh * 0.1))
        x2 = min(w, int(x2 + bw * 0.1))
        y2 = min(h, int(y2 + bh * 0.1))
        crops.append(img.crop((x1, y1, x2, y2)))
    return crops

# 用例
for img_path in input_images:
    bird_crops = extract_usable_birds(img_path)
    for crop in bird_crops:
        species = your_species_classifier(crop)  # 下游 DINOv3 等
        print(f"{img_path}: {species}")
```

---

## 6. 性能基准（实测）

测试硬件：Apple M5 Max，128 GB RAM。50 张验证图，imgsz=640，warmup 5 次。

| Backend | 中位延迟 | P95 延迟 | 吞吐 | 相对 PyTorch CPU | 精度（Box IoU vs 基准）|
|---------|---------|----------|------|----------------|--------------------|
| PyTorch CPU | 343.7 ms | 395.8 ms | 2.8 img/s | 1.0x | 1.0（基准） |
| PyTorch MPS | 26.0 ms | 27.6 ms | 38.7 img/s | **13.2x** | 0.99999963 |
| **ONNX CPU** | **170.9 ms** | **179.6 ms** | **5.8 img/s** | **2.0x** | **0.99999951** |

> ONNX 与 PyTorch 的精度漂移仅 ~10⁻⁵ 像素（纯浮点噪声），可视为完全等价。

详细 benchmark 数据见 [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) 第 8 节。

---

## 7. 阈值调优

### 7.1 默认值（生产推荐）

| 阈值 | 默认 | 说明 |
|------|------|------|
| `box_threshold` | **0.25** | 检测置信度（多鸟场景的合理起点） |
| `eye_threshold` | 0.45 | 眼睛关键点（校准最优） |
| `head_threshold` | 0.35 | 头部关键点（校准最优） |
| `head_eye_threshold` | 0.10 | head_visible 中辅助验证用 |
| `margin` | 0.15 | 关键点几何检查边界 |

### 7.2 不同场景

```python
# 单鸟特写 / 高质量照片
detector = BirdVisibilityDetector.auto(box_threshold=0.05)

# 多鸟野外照片（默认）
detector = BirdVisibilityDetector.auto(box_threshold=0.25)

# 鸟群密集场景
detector = BirdVisibilityDetector.auto(box_threshold=0.35, iou_threshold=0.2)

# 监控视频低分辨率
detector = BirdVisibilityDetector.auto(box_threshold=0.15, imgsz=1024)
```

---

## 8. 故障排查

### 8.1 ONNX 加载报错 `Unable to automatically guess model task`

ONNX 模型缺少 task 元数据，必须显式指定 `task="pose"`。本包已在 `BirdVisibilityDetector` 内部处理。如果你直接使用 Ultralytics：

```python
from ultralytics import YOLO
model = YOLO("models/bird_visibility.onnx", task="pose")  # ← 必须加 task
```

### 8.2 macOS 上 `MPSGraphExecutable: MLIR pass manager failed`

只发生在 CoreML 模型上。本包**不使用 CoreML**，应该不会遇到。如果你自行导出了 CoreML 模型遇到此问题，强制 CPU-only：

```python
import coremltools as ct
model = ct.models.MLModel("model.mlpackage", compute_units=ct.ComputeUnit.CPU_ONLY)
```

### 8.3 推理速度比预期慢

检查：

- `device` 是否正确（Mac 上应是 `"mps"`，Windows 应是 `"cpu"`）
- `imgsz` 是否为 640（更高分辨率会等比例变慢）
- 是否有 warmup（首次推理含编译开销）
- ONNX Runtime provider 是否优化（CPU 上可设 `intra_op_num_threads`）

### 8.4 检测不到鸟

`box_threshold` 默认 0.25 过滤了较弱的检测。试着降低：

```python
detector.box_threshold = 0.05
```

或检查图片质量（极小目标、严重模糊都会降低置信度）。

---

## 9. 版本

- **v1.1.0** — 2026-04-26
  - 新增 ONNX 权重和跨平台 `auto()` 自动选择
  - 详细的部署性能基准
- **v1.0.0** — 2026-04-21
  - 首次发布，单 PyTorch 权重
- 基础模型：YOLO26l-pose（28.6M 参数）
- 训练数据：NABirds（48,562 张，555 种北美鸟类）
- 验证集指标：Pose mAP50-95 = 98.92%, Eye F1 = 99.31%, Head F1 = 99.88%

完整集成、调优、部署方案见 [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md)。
