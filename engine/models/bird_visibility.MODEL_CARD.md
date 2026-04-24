# 鸟类头部/眼睛可见性检测模型 — 集成手册

本文档面向**其他项目**集成本模型。读完后即可将模型作为黑盒使用。

---

## 1. 概述

### 1.1 模型能力

输入一张照片，输出：

- 检测到的所有鸟的 bbox
- 每只鸟的 5 个头部关键点（bill / crown / nape / left_eye / right_eye）及置信度
- 每只鸟的 `head_visible` / `eye_visible` 二分类判定

### 1.2 不能做什么

- ❌ 鸟类物种识别（仅知道是"鸟"，不知道是哪种鸟）
- ❌ 鸟身/翅膀/爪等非头部关键点
- ❌ 密集鸟群中每只鸟的独立分析（训练数据为单鸟标注）

---

## 2. 核心产出文件

集成到新项目只需拷贝两个文件：

| 文件 | 大小 | 说明 |
|------|------|------|
| `best.pt` | **161 MB** | YOLO26l-pose 微调权重 |
| `summary.json` | 1.1 KB | 校准阈值 |

源路径：

```
yolo-split/runs/pose/nabirds_pose5_stage1/weights/best.pt
yolo-split/reports/visibility_calibration/summary.json
```

建议在新项目中组织为：

```
your-project/
├── models/
│   ├── bird_visibility.pt          # 改名后的 best.pt
│   └── bird_visibility_config.json # 改名后的 summary.json
```

---

## 3. 模型规格

| 项 | 值 |
|----|-----|
| 架构 | YOLO26l-pose |
| 总参数量 | 28,626,120 (~28.6M) |
| 输入格式 | RGB 图像（PIL.Image / numpy / 文件路径皆可） |
| 训练分辨率 | 640 |
| 推荐推理分辨率 | 640 |
| 检测类别 | 1 类（`bird`） |
| 关键点数 | 5 |
| 关键点顺序 | `bill, crown, nape, left_eye, right_eye` |
| flip_idx | `[0, 1, 2, 4, 3]`（左右眼水平翻转交换） |

### 3.1 训练数据

- **数据集**：NABirds（北美鸟类 555 种，48,562 张）
- **标注**：每张图 1 个 bbox + 5 个头部关键点 + 可见性标志
- **划分**：23,929 train / 24,633 val（官方划分）

### 3.2 验证集表现

| 指标 | 值 |
|------|-----|
| Pose mAP50-95 | 98.92% |
| Pose mAP50 | 99.41% |
| 检测 mAP50-95 | 79.92% |
| 检测 mAP50 | 99.35% |
| Eye 可见性 F1 | 99.31% |
| Head 可见性 F1 | 99.88% |

---

## 4. 校准阈值（已固化到 summary.json）

### 4.1 阈值含义

| 阈值 | 值 | 说明 |
|------|-----|------|
| `box_threshold` | **0.05** | 检测框最低置信度（单鸟场景校准值） |
| `expanded_box_margin` | **0.15** | 关键点几何合理性检查的边界余量 |
| `eye_threshold` | **0.45** | `eye_visible=True` 所需的眼睛关键点最低置信度 |
| `head_threshold` | **0.35** | `head_visible=True` 所需的头部关键点最低置信度 |
| `head_eye_threshold` | **0.10** | `head_visible` 判定中辅助验证用的眼睛阈值 |

### 4.2 决策规则

```
eye_visible = True  当:
  box_conf >= box_threshold
  AND (left_eye.conf >= eye_threshold 且 left_eye 在框内/边缘
       OR right_eye.conf >= eye_threshold 且 right_eye 在框内/边缘)

head_visible = True  当:
  box_conf >= box_threshold
  AND (
    至少 2 个 {bill, crown, nape} 的 conf >= head_threshold 且在框内
    OR
    至少 1 个 {bill, crown, nape} 的 conf >= head_threshold 且在框内
    AND 至少 1 个 {left_eye, right_eye} 的 conf >= head_eye_threshold 且在框内
  )

几何检查（"在框内"的定义）:
  关键点坐标 (x, y) 应满足:
    box_x1 - margin*box_width  <= x <= box_x2 + margin*box_width
    box_y1 - margin*box_height <= y <= box_y2 + margin*box_height
```

### 4.3 ⚠️ 生产部署必改的参数

`box_threshold=0.05` 是**单鸟验证集**上校准的结果。真实多鸟场景下会产生大量低置信度假阳性。

| 部署场景 | 推荐 box_threshold |
|---------|-------------------|
| 已知图中至多 1 只鸟 | 0.05（校准值直接用） |
| 野外多鸟照片 | **0.25-0.35** |
| 鸟群密集场景 | 0.35+，配合 NMS IoU=0.2-0.3 |

---

## 5. 依赖环境

```bash
pip install ultralytics pillow torch
```

### 5.1 版本要求

| 库 | 最低版本 | 说明 |
|----|---------|------|
| ultralytics | 8.4.0+ | YOLO26 支持必需 |
| torch | 2.0+ | — |
| pillow | 9.0+ | — |
| numpy | 1.24+ | — |

### 5.2 支持的推理设备

| 设备 | 配置字符串 | 典型单图延迟 (640) |
|------|-----------|-------------------|
| CPU | `"cpu"` | 200-300 ms |
| CUDA GPU | `"0"` 或 `"cuda:0"` | 10-20 ms |
| Apple Silicon | `"mps"` | 30-50 ms |

---

## 6. 集成代码（开箱即用）

### 6.1 最小调用示例

```python
from ultralytics import YOLO
from PIL import Image

model = YOLO("models/bird_visibility.pt")

# 支持三种输入类型
result = model.predict(
    source="bird.jpg",        # 或 PIL.Image 或 numpy 数组
    imgsz=640,
    conf=0.25,                # box_threshold
    iou=0.3,                  # NMS IoU
    device="mps",             # 或 "cuda:0" 或 "cpu"
    verbose=False,
)[0]

for box, kpts in zip(result.boxes, result.keypoints):
    print(f"bbox: {box.xyxy.tolist()}, conf: {box.conf.item():.3f}")
    print(f"keypoints: {kpts.xy.tolist()}")
```

### 6.2 完整推理类（生产级）

以下代码可直接复制到新项目：

```python
"""Bird head/eye visibility detector - production wrapper."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from PIL import Image
from ultralytics import YOLO


PART_NAMES = ("bill", "crown", "nape", "left_eye", "right_eye")
HEAD_PARTS = ("bill", "crown", "nape")
EYE_PARTS = ("left_eye", "right_eye")


@dataclass
class BirdDetection:
    """Single bird detection result."""

    box_conf: float
    box_xyxy: Tuple[float, float, float, float]  # (x1, y1, x2, y2) in pixels
    keypoints_xy: Dict[str, Tuple[float, float]] = field(default_factory=dict)
    keypoints_conf: Dict[str, float] = field(default_factory=dict)
    head_visible: bool = False
    eye_visible: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "box_conf": self.box_conf,
            "box_xyxy": list(self.box_xyxy),
            "keypoints_xy": {k: list(v) for k, v in self.keypoints_xy.items()},
            "keypoints_conf": self.keypoints_conf,
            "head_visible": self.head_visible,
            "eye_visible": self.eye_visible,
        }


class BirdVisibilityDetector:
    """Detect birds and determine head/eye visibility.

    Usage:
        detector = BirdVisibilityDetector(
            weights="models/bird_visibility.pt",
            config="models/bird_visibility_config.json",
            device="mps",
        )
        results = detector.detect("photo.jpg")
        for bird in results:
            print(bird.to_dict())
    """

    def __init__(
        self,
        weights: Union[str, Path],
        config: Union[str, Path, None] = None,
        device: str = "cpu",
        imgsz: int = 640,
        box_threshold: Optional[float] = None,
        iou_threshold: float = 0.3,
    ):
        self.model = YOLO(str(weights))
        self.device = device
        self.imgsz = imgsz
        self.iou_threshold = iou_threshold

        # Load calibrated thresholds from summary.json
        thresholds = self._load_thresholds(config)
        self.box_threshold = (
            box_threshold if box_threshold is not None else thresholds["box_threshold"]
        )
        self.eye_threshold = thresholds["eye_threshold"]
        self.head_threshold = thresholds["head_threshold"]
        self.head_eye_threshold = thresholds["head_eye_threshold"]
        self.margin = thresholds["margin"]

    @staticmethod
    def _load_thresholds(config_path: Union[str, Path, None]) -> Dict[str, float]:
        defaults = {
            "box_threshold": 0.25,  # Raised from 0.05 for real-world use
            "eye_threshold": 0.45,
            "head_threshold": 0.35,
            "head_eye_threshold": 0.10,
            "margin": 0.15,
        }
        if config_path is None:
            return defaults

        data = json.loads(Path(config_path).read_text())
        return {
            "box_threshold": float(data.get("box_threshold", defaults["box_threshold"])),
            "margin": float(data.get("expanded_box_margin", defaults["margin"])),
            "eye_threshold": float(
                data.get("best_eye", {}).get("eye_threshold", defaults["eye_threshold"])
            ),
            "head_threshold": float(
                data.get("best_head", {}).get("head_threshold", defaults["head_threshold"])
            ),
            "head_eye_threshold": float(
                data.get("best_head", {}).get("eye_threshold", defaults["head_eye_threshold"])
            ),
        }

    def detect(
        self,
        source: Union[str, Path, Image.Image],
    ) -> List[BirdDetection]:
        """Run detection and return one result per detected bird."""
        result = self.model.predict(
            source=source,
            imgsz=self.imgsz,
            conf=self.box_threshold,
            iou=self.iou_threshold,
            device=self.device,
            verbose=False,
            save=False,
        )[0]

        if result.boxes is None or len(result.boxes) == 0:
            return []

        boxes = result.boxes.cpu()
        keypoints = result.keypoints.cpu() if result.keypoints is not None else None

        detections: List[BirdDetection] = []
        for idx in range(len(boxes)):
            box_conf = float(boxes.conf[idx].item())
            box_xyxy = tuple(float(v) for v in boxes.xyxy[idx].tolist())

            kpts_xy: Dict[str, Tuple[float, float]] = {}
            kpts_conf: Dict[str, float] = {}
            if keypoints is not None and keypoints.conf is not None:
                for i, name in enumerate(PART_NAMES):
                    kpts_xy[name] = (
                        float(keypoints.xy[idx][i][0].item()),
                        float(keypoints.xy[idx][i][1].item()),
                    )
                    kpts_conf[name] = float(keypoints.conf[idx][i].item())

            head_visible, eye_visible = self._judge_visibility(
                box_conf, box_xyxy, kpts_conf, kpts_xy
            )

            detections.append(
                BirdDetection(
                    box_conf=box_conf,
                    box_xyxy=box_xyxy,
                    keypoints_xy=kpts_xy,
                    keypoints_conf=kpts_conf,
                    head_visible=head_visible,
                    eye_visible=eye_visible,
                )
            )

        # Sort by confidence descending
        detections.sort(key=lambda d: d.box_conf, reverse=True)
        return detections

    def _judge_visibility(
        self,
        box_conf: float,
        box_xyxy: Tuple[float, float, float, float],
        kpts_conf: Dict[str, float],
        kpts_xy: Dict[str, Tuple[float, float]],
    ) -> Tuple[bool, bool]:
        if box_conf < self.box_threshold:
            return False, False

        def in_box(xy: Tuple[float, float]) -> bool:
            x1, y1, x2, y2 = box_xyxy
            w = max(1e-6, x2 - x1)
            h = max(1e-6, y2 - y1)
            x, y = xy
            return (
                x1 - self.margin * w <= x <= x2 + self.margin * w
                and y1 - self.margin * h <= y <= y2 + self.margin * h
            )

        # Eye visibility
        eye_visible = any(
            kpts_conf[n] >= self.eye_threshold and in_box(kpts_xy[n])
            for n in EYE_PARTS
        )

        # Head visibility
        head_hits = sum(
            1
            for n in HEAD_PARTS
            if kpts_conf[n] >= self.head_threshold and in_box(kpts_xy[n])
        )
        eye_hits_for_head = sum(
            1
            for n in EYE_PARTS
            if kpts_conf[n] >= self.head_eye_threshold and in_box(kpts_xy[n])
        )
        head_visible = head_hits >= 2 or (head_hits >= 1 and eye_hits_for_head >= 1)

        return head_visible, eye_visible
```

### 6.3 使用示例

```python
detector = BirdVisibilityDetector(
    weights="models/bird_visibility.pt",
    config="models/bird_visibility_config.json",
    device="mps",           # Windows CPU 用 "cpu"，NVIDIA GPU 用 "cuda:0"
    box_threshold=0.25,     # 多鸟场景覆盖校准默认值
)

# 单张图
detections = detector.detect("bird_photo.jpg")
print(f"Detected {len(detections)} birds")
for i, bird in enumerate(detections):
    print(f"Bird {i+1}: head={bird.head_visible}, eye={bird.eye_visible}, conf={bird.box_conf:.3f}")

# PIL 图
from PIL import Image
img = Image.open("bird_photo.jpg")
detections = detector.detect(img)

# 批量
results = []
for img_path in image_paths:
    results.append(detector.detect(img_path))
```

---

## 7. 输出数据结构

`detector.detect()` 返回 `List[BirdDetection]`，按置信度降序。每个 `BirdDetection` 对象：

```python
BirdDetection(
    box_conf=0.883,                                           # float: 检测置信度
    box_xyxy=(145.2, 88.7, 489.3, 612.1),                     # tuple: (x1, y1, x2, y2) 像素坐标
    keypoints_xy={                                            # dict: 关键点像素坐标
        "bill":      (285.3, 150.8),
        "crown":     (265.1, 125.4),
        "nape":      (240.7, 135.2),
        "left_eye":  (275.8, 148.1),
        "right_eye": (0.0, 0.0),                              # 未检测到 → (0,0)
    },
    keypoints_conf={                                          # dict: 每个关键点置信度
        "bill":      0.987,
        "crown":     0.972,
        "nape":      0.951,
        "left_eye":  0.823,
        "right_eye": 0.031,
    },
    head_visible=True,                                        # bool: 头部可见
    eye_visible=True,                                         # bool: 眼睛可见
)
```

调用 `.to_dict()` 可序列化为纯 JSON 字典。

---

## 8. 性能基准（实测）

| 设备 | imgsz | 单图推理 | 24,633 张批量 |
|------|-------|----------|---------------|
| M5 Max (MPS) | 640 | ~30 ms | 366 s (67 img/s) |
| M5 Max (CPU) | 640 | ~280 ms | 未实测 |
| NVIDIA T4 (估算) | 640 | ~12 ms | 未实测 |

内存占用：推理 < 2 GB，可安全部署到边缘设备。

---

## 9. 部署建议

### 9.1 Python 服务端

直接使用第 6.2 节的类，配合 FastAPI/Flask 封装 HTTP 接口。

### 9.2 跨平台部署（ONNX）

如需脱离 Python/Ultralytics 依赖，可导出 ONNX：

```python
from ultralytics import YOLO
model = YOLO("models/bird_visibility.pt")
model.export(format="onnx", imgsz=640, opset=17, dynamic=False)
# 生成 models/bird_visibility.onnx
```

ONNX 模型可被 ONNX Runtime（Windows CPU/GPU/CoreML 均支持）加载，但**关键点后处理和可见性判定需要自己实现**（不在 ONNX 图中）。

### 9.3 移动端

使用 Ultralytics 的 CoreML / TFLite 导出：

```python
model.export(format="coreml", imgsz=640)   # iOS
model.export(format="tflite", imgsz=640)   # Android
```

---

## 10. 限制与已知问题

1. **单鸟训练偏差**：NABirds 每张图只标 1 只鸟。多鸟场景模型会检测所有鸟，但训练时未优化"多鸟区分"，密集鸟群召回率可能下降。
2. **鸟种偏差**：训练数据为北美 555 种。对非常见鸟（如某些热带猛禽、水禽）效果可能退化，建议用目标地区数据微调。
3. **姿态偏差**：NABirds 中站立/栖息姿态占多数。飞行、倒挂、异常姿态的检测置信度会偏低（实测飞行鸟 box_conf ~0.28 vs 站立鸟 ~0.77）。
4. **光照与清晰度**：极端逆光、夜景、严重过曝未做针对性增强，这些场景下建议检测置信度阈值放宽到 0.15。
5. **极小目标**：训练分辨率 640，原图中鸟占比 < 2% 时检测可能漏掉，可在部署端传入 imgsz=1024 推理（模型不变，分辨率更高但推理时间翻倍）。

---

## 11. 版本信息

| 项 | 值 |
|----|-----|
| 模型版本 | v1.0 (stage1) |
| 训练完成时间 | 2026-04-21 |
| 训练轮数 | 66 epochs（best=epoch 64） |
| 基础权重 | yolo26l-pose.pt (Ultralytics 官方) |
| 训练数据 | NABirds (官方 train/test split) |
| 源代码仓库 | `yolo-split/` |

---

## 12. 附录：校准阈值完整结果

```json
{
  "box_threshold": 0.05,
  "expanded_box_margin": 0.15,
  "best_eye": {
    "eye_threshold": 0.45,
    "tp": 24112, "fp": 268, "tn": 185, "fn": 68,
    "precision": 0.9890,
    "recall": 0.9972,
    "accuracy": 0.9864,
    "f1": 0.9931
  },
  "best_head": {
    "head_threshold": 0.35,
    "eye_threshold": 0.10,
    "tp": 24209, "fp": 34, "tn": 28, "fn": 22,
    "precision": 0.9986,
    "recall": 0.9991,
    "accuracy": 0.9977,
    "f1": 0.9988,
    "eligible_count": 24293,
    "ambiguous_count": 340
  }
}
```

其中 `ambiguous_count=340` 是 NABirds 中头部可见性无法明确判定的样本（部分可见但不满足 strict 标准），校准时排除。
