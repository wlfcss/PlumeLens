# 鸟类全身姿态 + 可见性检测模型 v2.0 — 完整集成手册

> **PlumeLens 集成笔记**(本仓库特定):
> - 模型文件:`engine/models/bird_visibility11.{onnx,_config.json}`
> - 推理走自实现 raw onnxruntime 后处理(`engine/pipeline/pose.py`),不依赖 ultralytics package(已从 PyInstaller 排除以缩 packaged binary)
> - PoseInfo schema:`engine/pipeline/models.py` 含全部 11 关键点 + 5 visibility + 3 posture(view_angle / facing / posture)字段
> - **产品规则:飞版自动升档**
>   - grader 在头眼齐全(head_visible AND eye_visible)且 posture=='flying' 时,自动 +1 档
>   - 实现:`engine/pipeline/grader.py::apply_pose_adjustment`
>   - 鸟摄精选惯例:飞版需要技术 + 抓拍 + 运气,在画质相同时应给予更高认可
>   - flying 判定故意严格(aspect>1.3 + 双翼可见 + 翼跨度 ≥ bbox 宽 50%),宁愿误判 perched 也不污染精选墙

---

## 1. 概述

### 1.1 模型能力

输入一张照片，每只检测到的鸟输出：

- bbox（检测框 + 置信度）
- 11 个关键点（坐标 + 置信度）
- 5 项可见性判定：头 / 眼 / 身 / 尾 / 翼
- 视角方向（正面 / 侧面 / 背面）
- 朝向（左 / 右）
- 姿态（栖息 / 飞行）
- 大小分级（tiny / small / medium / large）

### 1.2 不能做什么

- ❌ 鸟类物种识别（仅识别"鸟"这一类）
- ❌ 像素级分割（输出 bbox，不是 mask）
- ❌ 密集鸟群中每只鸟的精确分析（NABirds 训练数据为单鸟标注）

---

## 2. 模型规格

| 项 | 值 |
|----|-----|
| 架构 | YOLO26l-pose |
| 参数量 | 25.6M（fused，推理时） |
| **关键点** | **11**（5 头 + 6 身）|
| 类别 | 1 类（`bird`） |
| 训练数据 | NABirds（48,562 张，555 种）|
| 训练分辨率 | 640 |
| flip_idx | `[0, 1, 2, 4, 3, 5, 6, 7, 8, 10, 9]` |

### 关键点顺序与对称对

| Idx | 名称 | 翻转后 | 备注 |
|-----|------|------|------|
| 0 | bill | 0 | 中线 |
| 1 | crown | 1 | 中线 |
| 2 | nape | 2 | 中线 |
| 3 | left_eye | 4 | 与 right_eye 对称 |
| 4 | right_eye | 3 | 与 left_eye 对称 |
| 5 | belly | 5 | 中线 |
| 6 | breast | 6 | 中线 |
| 7 | back | 7 | 中线 |
| 8 | tail | 8 | 中线 |
| 9 | left_wing | 10 | 与 right_wing 对称 |
| 10 | right_wing | 9 | 与 left_wing 对称 |

### 验证集表现（NABirds 24,633 张）

| 指标 | v2.0（11 kpt） | v1.x（5 kpt）| 备注 |
|------|---------------|---------------|------|
| Pose mAP50 | 99.45% | 99.41% | ≈ 持平 |
| **Pose mAP50-95** | **88.83%** | 98.92% | v2 多 6 个躯干点更难 |
| Det mAP50 | 99.39% | 99.35% | 略升 |
| **Det mAP50-95** | **80.55%** | 79.92% | **+0.6** |

### 校准阈值（自动加载于 config JSON）

| 属性 | 阈值 | F1 |
|------|------|-----|
| eye_visible | 0.45 | 99.28% |
| head_visible | head=0.45, eye=0.40 | 99.91% |
| body_visible | 0.30 | 99.84% |
| tail_visible | 0.40 | 96.90% |
| wings_visible | 0.40 | 97.55% |

---

## 3. 决策规则

### 3.1 可见性

```
eye_visible:
  box_conf >= box_threshold
  AND (left_eye 或 right_eye 任一 conf >= eye_threshold 且在框内)

head_visible:
  box_conf >= box_threshold
  AND (
    {bill, crown, nape} 中至少 2 个 conf >= head_threshold 在框内
    OR
    {bill, crown, nape} 中至少 1 个 + {left_eye, right_eye} 中至少 1 个
  )

body_visible:
  box_conf >= box_threshold
  AND ({belly, breast, back} 任一 conf >= body_threshold 在框内)

tail_visible:
  box_conf >= box_threshold
  AND tail conf >= tail_threshold 在框内

wings_visible:
  box_conf >= box_threshold
  AND ({left_wing, right_wing} 任一 conf >= wing_threshold 在框内)

"在框内" 定义：
  margin = 0.15
  关键点 (x, y) 满足：
    bbox_x1 - margin*w <= x <= bbox_x2 + margin*w
    bbox_y1 - margin*h <= y <= bbox_y2 + margin*h
```

### 3.2 视角方向（基于关键点几何）

```
frontal:  双眼可见 + bill 在两眼水平之间
back:     双眼不可见 + crown + nape 都可见
side:     仅一只眼可见
unknown:  其他
```

### 3.3 朝向（仅在 view_angle == "side" 时有效）

```
若 bill.x < nape.x  → facing = "left"
若 bill.x > nape.x  → facing = "right"
否则                 → "unknown"
```

### 3.4 姿态（启发式规则，无 GT 标签）

```
flying:   bbox aspect (w/h) > 1.3
          且双翼都可见
          且翼跨度 / bbox 宽度 >= 0.5
perched:  aspect < 1.05
          或翼不全可见
unknown:  其他
```

### 3.5 大小分级

```
tiny    : ratio < 2%
small   : 2% ≤ ratio < 10%
medium  : 10% ≤ ratio < 30%
large   : ratio >= 30%
其中 ratio = bbox_area / image_area
```

---

## 4. 集成代码

### 4.1 推荐方式：auto-detect

```python
from bird_visibility import BirdVisibilityDetector

detector = BirdVisibilityDetector.auto(models_dir="models")

for bird in detector.detect("photo.jpg"):
    # 关键判定
    if bird.head_visible and bird.eye_visible:
        # 适合下游物种识别
        x1, y1, x2, y2 = bird.box_xyxy
        # 裁剪 + 喂分类器...
```

### 4.2 显式指定

```python
# Mac 强制 PyTorch + MPS
detector = BirdVisibilityDetector(
    weights="models/bird_visibility11.pt",
    config="models/bird_visibility11_config.json",
    device="mps",
)

# Windows 强制 ONNX + CPU
detector = BirdVisibilityDetector(
    weights="models/bird_visibility11.onnx",
    config="models/bird_visibility11_config.json",
    device="cpu",
)
```

### 4.3 阈值定制

```python
# 提高检测灵敏度（捕获更多但可能假阳性）
detector = BirdVisibilityDetector.auto(box_threshold=0.10)

# 严格筛选（只要高置信度）
detector = BirdVisibilityDetector.auto(
    box_threshold=0.50,
    iou_threshold=0.2,  # 更激进的 NMS 去重
)

# 推理时改 imgsz（不需要重训）
detector = BirdVisibilityDetector.auto(imgsz=1024)
```

---

## 5. 完整输出样例

```python
{
    "box_conf": 0.927,
    "box_xyxy": [491.0, 269.0, 697.0, 459.0],
    "keypoints_xy": {
        "bill":      [543.7, 333.4],
        "crown":     [566.5, 305.2],
        "nape":      [589.0, 303.0],
        "left_eye":  [566.0, 320.4],
        "right_eye": [0.0, 0.0],            # 未检测到 → 坐标置零
        "belly":     [582.7, 462.4],
        "breast":    [465.6, 356.0],
        "back":      [593.8, 201.2],
        "tail":      [926.5, 461.5],
        "left_wing": [684.6, 298.2],
        "right_wing": [613.3, 294.9],
    },
    "keypoints_conf": {
        "bill":      0.953,
        "crown":     0.977,
        "nape":      0.988,
        "left_eye":  0.997,
        "right_eye": 0.004,                 # 接近 0 = 不可见
        "belly":     0.997,
        "breast":    0.995,
        "back":      0.969,
        "tail":      0.925,
        "left_wing": 0.991,
        "right_wing": 0.052,
    },
    "head_visible": True,
    "eye_visible": True,
    "body_visible": True,
    "tail_visible": True,
    "wings_visible": True,
    "view_angle": "side",
    "facing": "left",
    "posture": "perched",
    "bird_pixel_area_ratio": 0.457,
    "bird_size_category": "large"
}
```

---

## 6. 性能

| Backend | 中位延迟 | 吞吐 | 备注 |
|---------|---------|------|------|
| PyTorch CPU | ~340 ms | 3 img/s | 通用，慢 |
| **PyTorch MPS** | **~30 ms** | 33 img/s | Mac 首选 |
| **ONNX CPU** | **~170 ms** | 6 img/s | Win/Linux 首选 |
| ONNX CUDA GPU | ~12 ms | 80 img/s | 需 onnxruntime-gpu |

> 测试：Apple M5 Max，imgsz=640，batch=1

---

## 7. 常见问题

### 7.1 ONNX 加载报错 `Unable to automatically guess model task`

`BirdVisibilityDetector` 内部已显式指定 `task="pose"`。如果你直接用 Ultralytics：

```python
from ultralytics import YOLO
m = YOLO("bird_visibility11.onnx", task="pose")  # ← 必须加 task
```

### 7.2 view_angle 总是返回 unknown

可能原因：
- 关键点置信度太低（鸟体过小、模糊、遮挡严重）
- 不满足 frontal / side / back 的几何条件

可以通过单独检查 `eye_visible` 和 `head_visible` 来做更宽松的判定。

### 7.3 posture 总是 unknown 或 perched

`flying` 判定很严格（要求 aspect > 1.3 + 双翼可见 + 翼跨度大）。如果你的应用场景多飞鸟，可以读取原始关键点自行判断；或修改 `_derive_posture` 方法降低阈值。

### 7.4 想用其他视觉特征做物种识别

模型只产出 11 关键点 + bbox。物种识别建议用：

```
YOLO26 检测 → 取 bbox+10% padding 裁剪 → DINOv3 / ViT 分类器
```

`examples/filter_usable_photos.py` 已经做了筛选 + 裁剪的完整 pipeline。

### 7.5 同一张图 PyTorch 和 ONNX 结果不一致

通常关键点位置漂移 ~10⁻⁵ 像素（浮点精度），可视为完全等价。如果差异大于 1 像素，检查：
- imgsz 是否一致
- 是否两边都用了 `task="pose"` 加载

---

## 8. 完全脱离 PyTorch（raw onnxruntime）

Windows 服务器可仅装 onnxruntime + numpy + pillow（无 torch）。但需要自己实现预/后处理：

```python
import json
import numpy as np
import onnxruntime as ort
from PIL import Image

PART_NAMES = ("bill", "crown", "nape", "left_eye", "right_eye",
              "belly", "breast", "back", "tail", "left_wing", "right_wing")


class RawOnnxDetector:
    def __init__(self, onnx_path, imgsz=640):
        self.imgsz = imgsz
        self.sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
        self.input_name = self.sess.get_inputs()[0].name

    def detect(self, image_path, box_threshold=0.25):
        img = Image.open(image_path).convert("RGB")
        orig_w, orig_h = img.size
        img = img.resize((self.imgsz, self.imgsz), Image.BILINEAR)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        chw = arr.transpose(2, 0, 1)[np.newaxis, ...]
        out = self.sess.run(None, {self.input_name: chw})[0]  # (1, 300, 39)
        sx, sy = orig_w / self.imgsz, orig_h / self.imgsz

        results = []
        for row in out[0]:
            conf = float(row[4])
            if conf < box_threshold:
                continue
            x1, y1, x2, y2 = (float(row[0])*sx, float(row[1])*sy,
                              float(row[2])*sx, float(row[3])*sy)
            kp = row[6:].reshape(11, 3)
            kpts_xy = {n: (float(kp[i, 0])*sx, float(kp[i, 1])*sy)
                       for i, n in enumerate(PART_NAMES)}
            kpts_conf = {n: float(kp[i, 2]) for i, n in enumerate(PART_NAMES)}
            results.append({
                "box_conf": conf,
                "box_xyxy": (x1, y1, x2, y2),
                "keypoints_xy": kpts_xy,
                "keypoints_conf": kpts_conf,
            })
        return results
```

ONNX 输出形状 `(1, 300, 39)`：300 个候选检测，每个 39 维 = 4 (xyxy) + 1 (conf) + 1 (cls) + 33 (11 kpts × 3)。

---

## 9. 限制与已知问题

1. **单鸟训练偏差**：NABirds 每图 1 只鸟，多鸟场景检测多但训练时未优化区分
2. **鸟种偏差**：仅北美 555 种，热带、水禽等可能弱
3. **姿态偏差**：站立/栖息为主，极端姿态置信度偏低
4. **躯干关键点不如头部精确**：背、腹的位置标注本身有歧义
5. **posture 判定是启发式**：无 GT 标签，仅依赖几何规则
6. **小目标**：rationale 占图 < 2% 时检测可能漏掉，可推理时传 `imgsz=1024`

---

## 10. 版本信息

| 项 | 值 |
|----|----|
| 包版本 | v2.0.0 |
| 训练完成 | 2026-05-08 |
| 训练时长 | 7 小时（60 epoch + RTX 5090）|
| 起点权重 | v1 best.pt（5kpt → 11kpt 迁移）|
| Ultralytics 版本 | 8.4.47 |
| ONNX opset | 13 |

---

## 11. 完整校准 JSON

`models/bird_visibility11_config.json` 内容：

```json
{
  "num_keypoints": 11,
  "part_names": ["bill", "crown", "nape", "left_eye", "right_eye",
                 "belly", "breast", "back", "tail", "left_wing", "right_wing"],
  "box_threshold": 0.05,
  "expanded_box_margin": 0.15,
  "best_eye":   { "threshold": 0.45, "f1": 0.9928 },
  "best_head":  { "head_threshold": 0.45, "eye_threshold": 0.40, "f1": 0.9991 },
  "best_body":  { "threshold": 0.30, "f1": 0.9984 },
  "best_tail":  { "threshold": 0.40, "f1": 0.9690 },
  "best_wings": { "threshold": 0.40, "f1": 0.9755 }
}
```

> `box_threshold=0.05` 是单鸟验证集校准值；生产环境 `BirdVisibilityDetector` 默认覆盖为 **0.25** 以适配多鸟场景。
