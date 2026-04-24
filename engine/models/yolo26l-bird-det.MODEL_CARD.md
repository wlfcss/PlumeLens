# YOLO26l-bird — 模型卡片与集成指南

> 单类鸟类检测模型,供其他项目集成使用。替换 VLM 裁切的快速 detector。

**版本**:v1.0(2026-04-24)
**训练 commit**:best_ep63
**作者**:yolo-split-new 项目

---

## 1. 模型基本信息

| 项 | 值 |
|---|---|
| **架构** | YOLO26l(Ultralytics YOLO 26 系列,L 变体)|
| **参数量** | 26,177,886(26.2 M)|
| **FLOPs** | 86.1 G @ imgsz=1280 |
| **任务** | 单类目标检测(detection)|
| **类别数** | 1 |
| **类别名** | `bird` |
| **输入** | RGB 图像(任意尺寸,内部 letterbox 到 imgsz × imgsz)|
| **输出** | 变长 bbox 列表,每个 `[x1, y1, x2, y2, conf, cls]`(cls 恒为 0)|
| **推理分辨率** | 1280(训练 imgsz)|
| **特性** | NMS-free end-to-end(YOLO26 架构,无传统 NMS 开销)|

---

## 2. 精度指标

### 验证集(Val,354 张,训练时使用)

| 指标 | 值 |
|---|---:|
| mAP@0.5 | 0.9741 |
| mAP@0.5:0.95 | 0.8016 |
| Precision | 0.961 |
| Recall | 0.919 |

### 独立测试集(Test,353 张,训练从未见过)

| 指标 | 值 |
|---|---:|
| **mAP@0.5** | **0.9364** |
| **mAP@0.5:0.95** | **0.6920** |
| **Precision** | **0.9246** |
| **Recall** | **0.9021** |
| **F1** | 0.9132 |

Test 分布 = 部署场景代表(用户自拍照,ysn observation-level split),可视作**线上预期精度**。

### 人工验证(摄影场景)

用户在 **inference_web** 界面拖放多张未见过的图,**conf=0.5 阈值下**:
- bbox 精准定位鸟身体(不把花朵、建筑装饰、纹理误识别)
- 裁切结果可直接用于下游流水线(如物种分类)
- 多鸟场景检测全 / 无鸟场景不乱框

---

## 3. 速度基准

| 硬件 | 后端 | 推理时间(单图,imgsz=1280)|
|---|---|---:|
| **RTX 5090**(cloud)| PyTorch CUDA | **5.2 ms** |
| M5 Max(本地)| PyTorch MPS | 34.9 ms |
| M5 Max(本地)| ONNX Runtime CPU | 534 ms |
| Linux + TensorRT | 预期 | 2-5 ms(未实测)|
| M5 Max + CoreML ANE | 预期 | 5-10 ms(未导出) |

加上 preprocess(图像解码、resize、letterbox)和 postprocess(bbox 还原):
- **端到端(本地 M5 MPS)**:~100-400 ms/图(取决于原图大小)
- **端到端(RTX 5090)**:~10-30 ms/图

---

## 4. 训练数据

**总计 49,236 张**(48,529 train + 354 val + 353 test),涵盖:

| 来源 | 比例 | 特点 |
|---|---|---|
| **dino 40w**(筛后)| 32,583 张 | 多数据集聚合,1,018 物种,长边 ≥ 1280 筛选 |
| **China-bird-YOLO** | 10,073 张 | 人工精标 YOLO,1,458 物种,近景特写 |
| **ysn 自拍** | 3,432 张 | 用户自拍(Canon 相机),真实部署场景 |
| **hard_neg** | 2,441 张 | 用户精选无鸟图(花朵/建筑/风景,PlumeLens 翻车场景)|

- **物种覆盖**:1,495 种鸟类(单类训练,但数据覆盖广)
- **bbox 面积分布**:4 场景均衡 — 远景 18% / 中景 48% / 近景 18% / 特写 16%
- **Hard negative 比例**:train/val/test ~6%(YOLO 官方推荐区间)

---

## 5. 部署资产

### 文件清单

```
<this-repo>/runs/yolo26l_1280_full/weights/
├── best.pt     51 MB   PyTorch,首选部署权重(最高精度)
├── last.pt     51 MB   最后一个 epoch(训练恢复用)
└── best.onnx   95 MB   ONNX opset 17,simplify 过,Linux/TensorRT 部署
```

**⚠ 注意**:
- `.pt` 和 `.onnx` 输出数值有 1-2 pp 的差异(数值实现差异,onnxslim 可能做了优化)
- ONNX 适合 Linux GPU + TensorRT 部署 → 推理 2-5ms
- **macOS 本地最佳路径是重新导出 CoreML**(`yolo export format=coreml`),可启用 ANE 加速

### 集成复制路径

把以下文件复制到你的项目(建议 `models/` 或 `weights/` 目录):
```
weights/best.pt    (必需)
weights/best.onnx  (可选,Linux 部署用)
```

---

## 6. 推荐推理参数

| 参数 | **推荐值** | 范围 | 说明 |
|---|---|---|---|
| **imgsz** | **1280** | 640 / 960 / 1280 / 1440 | 匹配训练尺寸;降到 640 推理快 3× 但精度降 3-5 pp |
| **conf** | **0.5**(摄影场景)/ 0.25(高召回场景) | 0.05-0.95 | 摄影/自动裁切建议 0.5,追求 recall 降到 0.25 |
| **iou**(NMS IoU)| **0.7**(默认) | 0.45-0.75 | YOLO26 NMS-free 但 API 仍暴露此参数 |
| **device** | GPU > MPS > CPU | — | GPU 快 7×,CPU 可行但慢 |
| **augment (TTA)** | **False** | — | YOLO26 NMS-free,TTA 无效果 |
| **half (fp16)** | True(GPU)/ False(CPU)| — | fp16 GPU 快 20%,CPU 不支持 |

---

## 7. 推理代码示例

### 7.1 PyTorch(Ultralytics API,最简)

```python
from ultralytics import YOLO

# 加载
model = YOLO('weights/best.pt')  # 或 'weights/best.onnx'

# 单图推理
result = model.predict(
    'path/to/image.jpg',
    conf=0.5,        # 摄影推荐
    iou=0.7,
    imgsz=1280,
    device=0,        # GPU 或 'mps' 或 'cpu'
    verbose=False,
)[0]  # 取第一个(单图)

# 解析结果
if result.boxes is not None and len(result.boxes) > 0:
    boxes = result.boxes.xyxy.cpu().numpy()  # (N, 4) [x1, y1, x2, y2] 原图像素
    confs = result.boxes.conf.cpu().numpy()  # (N,) 置信度
    for box, conf in zip(boxes, confs):
        x1, y1, x2, y2 = box.astype(int)
        print(f'bird at [{x1},{y1}]-[{x2},{y2}] conf={conf:.2f}')
else:
    print('no birds')
```

### 7.2 裁切鸟图(含 padding)

```python
import cv2
from pathlib import Path
from ultralytics import YOLO

model = YOLO('weights/best.pt')

def detect_and_crop(img_path, pad_pct=0.10, conf=0.5):
    """Detect birds and return list of cropped images (np arrays, BGR)."""
    img = cv2.imread(str(img_path))
    H, W = img.shape[:2]

    r = model.predict(str(img_path), conf=conf, imgsz=1280, verbose=False)[0]
    if r.boxes is None or len(r.boxes) == 0:
        return []

    crops = []
    for box, c in zip(r.boxes.xyxy.cpu().numpy(),
                      r.boxes.conf.cpu().numpy()):
        x1, y1, x2, y2 = box.astype(int)
        # pad
        px = int((x2 - x1) * pad_pct)
        py = int((y2 - y1) * pad_pct)
        crop = img[max(0, y1-py):min(H, y2+py),
                   max(0, x1-px):min(W, x2+px)]
        crops.append({
            'img': crop,
            'bbox': (x1, y1, x2, y2),
            'conf': float(c),
        })
    return crops

crops = detect_and_crop('bird.jpg', pad_pct=0.1, conf=0.5)
for i, c in enumerate(crops):
    cv2.imwrite(f'crop_{i}_conf{c["conf"]:.2f}.jpg', c['img'])
```

### 7.3 批量推理

```python
from ultralytics import YOLO
from pathlib import Path

model = YOLO('weights/best.pt')
image_list = list(Path('input_dir').glob('*.jpg'))

# Ultralytics 内部会 batch + GPU 并行
results = model.predict(
    [str(p) for p in image_list],
    conf=0.5,
    imgsz=1280,
    stream=True,  # 生成器,省内存
    verbose=False,
)

for path, r in zip(image_list, results):
    n_birds = len(r.boxes) if r.boxes is not None else 0
    print(f'{path.name}: {n_birds} birds')
```

### 7.4 ONNX(onnxruntime,跨平台)

```python
import onnxruntime as ort
import cv2
import numpy as np

# 加载
sess = ort.InferenceSession(
    'weights/best.onnx',
    providers=['CUDAExecutionProvider', 'CPUExecutionProvider'],  # 自动选
)
input_name = sess.get_inputs()[0].name  # 通常 'images'
IMGSZ = 1280

def letterbox(img, size=IMGSZ):
    """Resize long side to `size`, pad to (size, size) with gray (114)."""
    h, w = img.shape[:2]
    s = size / max(h, w)
    nh, nw = int(h * s), int(w * s)
    resized = cv2.resize(img, (nw, nh))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    top = (size - nh) // 2
    left = (size - nw) // 2
    canvas[top:top+nh, left:left+nw] = resized
    return canvas, s, (left, top)

def predict_onnx(img_path, conf_thresh=0.5):
    img = cv2.imread(str(img_path))  # BGR
    lb, scale, (px, py) = letterbox(img)
    # BGR -> RGB, HWC -> CHW, 归一化到 [0,1], batch 维
    x = lb[..., ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
    x = x[None]
    # 推理 → 输出形状 (1, N, 6) [x1,y1,x2,y2,conf,cls] 在 letterbox 坐标系
    out = sess.run(None, {input_name: x})[0][0]
    # 置信度过滤
    keep = out[:, 4] > conf_thresh
    out = out[keep]
    # 坐标还原到原图
    out[:, [0, 2]] = (out[:, [0, 2]] - px) / scale
    out[:, [1, 3]] = (out[:, [1, 3]] - py) / scale
    return out  # shape (N, 6)

boxes = predict_onnx('bird.jpg')
for b in boxes:
    x1, y1, x2, y2, conf, cls = b
    print(f'bird [{int(x1)},{int(y1)}]-[{int(x2)},{int(y2)}] conf={conf:.2f}')
```

**注意**:ONNX 输出格式可能和上面略有差异(YOLO26 NMS-free 输出),**建议先用 PyTorch API 跑对照验证**再迁移。

---

## 8. 已知限制 / 边界情况

| 场景 | 表现 | 建议 |
|---|---|---|
| **极小鸟**(bbox < 0.1% 图面积)| 偶有漏检 | 若关注小目标,降 conf 到 0.2 |
| **模糊 / 失焦鸟** | 判为"无鸟"(训练时这是预期标签)| 下游如需物种分类,模糊鸟本就用不了,符合预期 |
| **非中国常见鸟**(国外少见物种)| 仍可检到,但信心略低 | 训练数据以中国鸟种为主 |
| **人造鸟类装饰**(雕塑、绘画)| 视觉相似可能误识 | 依赖下游过滤 |
| **夜间 / 红外** | 未覆盖 | 不推荐用于夜拍 |
| **鸟群密集**(>20 只)| 表现良好(训练有多鸟图,最多 9-13 只/图)| — |
| **近景超大**(> 70% 画面) | 略弱(训练池该桶样本少,<1%)| 一般摄影中罕见 |

---

## 9. 依赖环境

### PyTorch 推理(`best.pt`)

```
ultralytics >= 8.4.37  (推荐 8.4.41+,原训练版本)
torch >= 2.4
torchvision 对应版本
# 可选:pillow, opencv-python (绝大多数安装里都有)
```

安装:
```bash
pip install ultralytics
```

### ONNX 推理(`best.onnx`)

```
onnxruntime >= 1.20        # CPU-only
onnxruntime-gpu >= 1.20    # CUDA
# 或:onnxruntime-coreml    # macOS ANE
```

### 硬件推荐

| 场景 | 硬件 | 说明 |
|---|---|---|
| 云端批处理 | RTX 3090 / 4090 / 5090 / A100 | 5-10ms/图 |
| 边缘/服务器 | RTX 3060+ | 10-20ms/图 |
| 本地 macOS | M3+ Max 32GB+ | MPS 30-50ms,建议 CoreML |
| CPU 服务器(备选)| 可行但 500ms+/图 | 仅低 QPS 场景 |

---

## 10. 版本 & 复现信息

| 项 | 值 |
|---|---|
| 训练开始 | 2026-04-23 01:15(UTC+8) |
| 训练结束 | 2026-04-24 17:38(UTC+8) |
| 训练硬件 | AutoDL RTX 5090 32GB(Blackwell) |
| 训练软件 | PyTorch 2.8.0+cu128, Ultralytics 8.4.41, CUDA 12.8 |
| 总训练时长 | ~40h wall(含 1 次 crash + auto-resume) |
| 总 epoch | 88(EarlyStopping,patience=25)|
| **Best epoch** | **63** |
| 训练命令 | 见 `scripts/cloud/train_yolo26.sh` |
| 训练超参 | `dataset_yolo/dataset.yaml`,args 存于 `runs/yolo26l_1280_full/args.yaml` |
| 数据准备 | 见 `scripts/prepare_training_data.py` + `scripts/export_yolo_dataset.py` |

### 复现训练

```bash
# 1. 准备 dataset_yolo/(需要 sources/ 原图和 annotations.jsonl)
python3 scripts/prepare_training_data.py
python3 scripts/export_yolo_dataset.py

# 2. 启动训练(AutoDL 或本地 RTX GPU)
bash scripts/cloud/train_yolo26.sh all
```

---

## 11. 下游建议

### 接入"VLM 裁切"替换场景

原来的流水线:
```
VLM bbox(~4s) → crop → DINOv3 分类
```

替换为:
```
YOLO26l best.pt(~10-50ms)→ crop → DINOv3 分类
```

**加速 ~100-400×**,精度预期:
- bbox IoU vs VLM:> 0.85(两者都用 VLM 弱监督训练,分布接近)
- 端到端 top-1 分类精度:预期 ≥ VLM-based baseline(因 YOLO 定位更稳定,减少"裁错框"导致的分类失败)

**未来可做的优化**:
- CoreML 导出 + ANE 部署(本地推理 < 10ms)
- fp16 量化(进一步减小到 ~25 MB)
- TensorRT 优化(Linux GPU < 3ms)
- Two-stage fine-tune(关 augmentation + 低 lr 精调 20 epoch,可能再 +0.5-1 pp)

### 不要做的事

- ❌ 不要开 `augment=True` TTA(对 YOLO26 无效,只会慢)
- ❌ 不要把输入 imgsz 改成小于 640(精度大降)
- ❌ 不要把 conf 设为 0.001(那是训 mAP 的阈值,生产乱框)

---

## 12. 联系 / 参考

- **原项目**:`yolo-split-new`
- **训练日志**:`TRAINING_JOURNAL.md`(完整踩坑过程、规则演进、bug 清单)
- **原始 PLAN**:`YOLO_DETECTOR_PLAN.md`
- **推理 playground**:`scripts/inference_web.py`(Flask 本地 web UI,http://127.0.0.1:8765)

---

_last updated 2026-04-24_
