# YOLO26l-bird v1.1 — 单类鸟类检测模型

> 用于摄影作品中鸟类目标的高精度检测与裁切。基于 Ultralytics YOLO26l(Large)在 49,236 张鸟类图像上端到端训练,包含 800 张人工 hard-negative。**v1.1 在 v1.0 基础上做了一轮 fine-tune**(20 epoch,~22K 数据),针对绶带鸟密枝场景实测 holdout recall 从 **59% → 87%**(+28pp)。
>
> **本包内为生产推理产物 — 仅 ONNX 模型 + 原生推理代码,不依赖 Ultralytics 运行时。**

---

## 1 · 模型概览

| 项 | 值 |
|---|---|
| 架构 | YOLO26l (NMS-free, end-to-end) |
| 类别数 | 1 (`bird`) |
| 输入分辨率 | **1280 × 1280** (letterbox 填充) |
| 输入张量 | `(1, 3, 1280, 1280)` `float32` `[0,1]` `RGB` |
| 输出张量 | `(1, 300, 6)` `float32` |
| 输出布局 | `[x1, y1, x2, y2, conf, cls]`(letterbox 空间像素) |
| ONNX opset | 17 |
| 模型大小 | **95 MB** (best.onnx, simplified) |
| 训练日期 | 2026-04-23 → 2026-04-25 (88 epoch base) + 2026-05-08 (fine-tune 20 epoch) |
| 训练 GPU | NVIDIA RTX 5090 32 GB |
| Fine-tune 数据 | +1.4K 用户实拍(绶带专题)+ 1.3K dino 林鸟科属 + 18K 防遗忘留样 |
| 推荐 confidence | **0.5**(摄影场景,见 §6) |
| 推荐 IoU | 0.7(NMS-free 模型其实不需要,仅用于二次去重) |

---

## 2 · 性能指标

### 2.1 Test set (4,924 张,v1.0 与 v1.1 同 test 集)

| 指标 | v1.0 | **v1.1** |
|---|---|---|
| mAP@0.5 | 0.927 | (fine-tune val 不在原 test 上重测,见下方 holdout)|
| mAP@0.5:0.95 | 0.672 | |
| Precision (conf=0.5) | 0.961 | |
| Recall (conf=0.5) | 0.919 | |
| F1 (conf=0.5) | 0.940 | |

### 2.2 Real-world holdout (150 张未见用户实拍,fine-tune 关键评测)

**v1.1 在用户摄影场景上大幅领先 v1.0** — 这才是部署关心的指标:

| bucket(bbox 占图比) | n | v1.0 recall | **v1.1 recall** | 提升 |
|---|---|---|---|---|
| 0 (<0.1%, 极远景) | 2 | 0% | 0% | · |
| 1 (0.1-0.5%, 远景小鸟) | 6 | 0% | 16.7% | +16.7 ↑ |
| 2 (0.5-1%) | 12 | 83.3% | 75.0% | -8.3(1 张差,噪声) |
| 3 (1-2.5%) | 26 | 84.6% | 92.3% | +7.7 ↑ |
| 4 (2.5-5%) | 18 | 77.8% | 88.9% | +11.1 ↑ |
| 5 (5-10%) | 21 | 61.9% | 95.2% | +33.3 ↑↑ |
| **6 (10-20%, 林鸟肖像)** | 19 | 42.1% | **100%** | **+57.9 ↑↑↑** |
| **7 (20-40%, 特写)** | 13 | 15.4% | **100%** | **+84.6 ↑↑↑** |
| **OVERALL bbox recall** | **117** | **59.0%** | **87.2%** | **+28.2 pp** |

> 远景小鸟(bucket 0/1)仍是短板 — 这是 small-object detection 难题,fine-tune 改善有限,需专门小目标检测技术。其他场景全部大幅提升或持平。

### 推理速度(单张 1280×1280)

| 平台 | Provider 配置 | 速度 | bbox 正确性 |
|---|---|---|---|
| RTX 5090 | CUDA EP | ~12 ms | ✅ |
| RTX 4090 | CUDA EP | ~14 ms | ✅ |
| **Apple M3 Pro** | **CoreML EP `MLComputeUnits=CPUAndGPU`** | **~126 ms** | **✅ IoU 0.999** |
| Apple M3 Pro | CPU EP | ~523 ms | ✅ |
| Apple M3 Pro | ❌ CoreML EP 默认(含 ANE) | ~99 ms | **❌ bbox 错位** |
| Intel i7-12700H | CPU EP | ~850 ms | ✅ |

**Mac 加速重要发现:** YOLO26 NMS-free head 在 Apple Neural Engine 上出错(实测 IoU 仅 0.45,最差 0.0),但在 Metal GPU 上正确。`build_session()` 默认已配置 `MLComputeUnits=CPUAndGPU` 跳过 ANE,你**什么都不用做**就能拿到 4× over 纯 CPU 的加速 + 正确 bbox。详细原理见 §5.5.9。

(速度均含预处理 + 推理 + 后处理,不含磁盘 I/O。CoreML 首次推理需编译 ~2s,代码已包含 warmup。)

---

## 3 · 文件清单

```
yolo26l-bird-v1.1/
├── MODEL_CARD.md            # 本文档
├── inference_example.py     # 完整推理示例 (~210 行,可直接 CLI 运行)
└── weights/
    └── best.onnx            # 95 MB,opset 17,simplified,batch=1,imgsz=1280
```

---

## 4 · 安装与运行

### 4.1 依赖

```bash
# 通用(CPU + macOS CoreML)
pip install onnxruntime opencv-python numpy

# 如需 NVIDIA GPU
pip install onnxruntime-gpu opencv-python numpy
```

> macOS 用户:
> - 不要装 `onnxruntime-silicon`(已 deprecated),官方 `onnxruntime>=1.17` 已原生包含 CoreML EP。
> - 代码默认会用 CoreML EP 跳过 ANE 的 `CPUAndGPU` 模式(M3 Pro ~126 ms,bbox 正确)。**不要手动改成 `ALL` 模式**,会出错 bbox。详见 §5.5.9。

### 4.2 单图测试

```bash
python inference_example.py weights/best.onnx /path/to/photo.jpg
# 输出:
#   [onnxruntime] active providers: ['CoreMLExecutionProvider', 'CPUExecutionProvider']
#   [result] photo.jpg
#     inference: 102.3 ms
#     detected: 2 bird(s) at conf>=0.5
#       #1  bbox=(1240,892,1845,1394)  size=605x502  conf=0.928
#       #2  bbox=(2104,455,2298,617)   size=194x162  conf=0.673
#     saved crops/photo_bird1.jpg
#     saved crops/photo_bird2.jpg
```

### 4.3 在你的代码中集成(三行)

```python
from inference_example import build_session, predict

sess = build_session('weights/best.onnx')
boxes = predict(sess, '/path/to/img.jpg', conf_thresh=0.5)
# boxes: np.float32 (N, 5),每行 [x1, y1, x2, y2, conf],原图像素坐标
```

---

## 5 · 推理 pipeline 详解

### 5.1 输入要求

| 要求 | 说明 |
|---|---|
| 颜色空间 | **RGB**(注意 cv2.imread 默认是 BGR,需要 `[..., ::-1]` 翻转) |
| 数据类型 | `float32`,值域 `[0.0, 1.0]`(uint8 除以 255) |
| 排列 | **CHW**(通道在前),不是 HWC |
| Batch | 1 (固定,模型导出时 dynamic=False) |
| 尺寸 | **必须 1280×1280**,非 1280 直接推会广播报错 |

### 5.2 Letterbox 预处理

YOLO 系列约定:不直接 resize 到 1280×1280(那会扭曲 aspect ratio),而是:

1. 长边等比缩放到 1280
2. 短边补灰(value=114)到 1280

形式化:

```
scale = 1280 / max(原H, 原W)
new_h = int(round(原H * scale))
new_w = int(round(原W * scale))
canvas = 1280×1280 灰图(全填 114)
canvas 居中粘贴 resize 后的图
```

例 1:水平照片 1920×1080
- scale = 1280/1920 ≈ 0.6667
- new_w=1280, new_h=720
- 上下各 pad (1280-720)/2 = 280 像素灰边
- pad_left=0, pad_top=280

例 2:垂直照片 4500×8000
- scale = 1280/8000 = 0.16
- new_w=720, new_h=1280
- 左右各 pad (1280-720)/2 = 280 像素灰边
- pad_left=280, pad_top=0

### 5.3 推理调用

```python
import onnxruntime as ort
sess = ort.InferenceSession('weights/best.onnx',
                            providers=['CoreMLExecutionProvider', 'CPUExecutionProvider'])
input_name = sess.get_inputs()[0].name        # 'images'
output = sess.run(None, {input_name: x})       # x: (1,3,1280,1280) float32
raw = output[0]                                # (1, 300, 6) float32
```

### 5.4 ONNX 输出格式

模型为 **NMS-free**(YOLO26 特性):内部已经做了 STAL + 1-to-K 匹配,**输出已是最终 300 个候选,按 conf 降序,不需要再跑 NMS**。

```
output[0] 形状 = (1, 300, 6)
output[0][0] 形状 = (300, 6)  ← 单图所有候选
每行 = [x1, y1, x2, y2, conf, cls]
       └────letterbox 1280×1280 空间像素────┘
```

低分行 conf ≈ 0(模型已在 head 内部抑制),所以你做的事就是:**conf 阈值过滤** + **坐标反变换**。

---

### 5.5 坐标变换详解 ⭐

> **本节是部署最容易出错的地方,务必读完再写代码。**

#### 5.5.1 输出布局字节级解释

模型 `output[0]` 是 `float32 (1, 300, 6)`,即 `1 × 300 × 6 × 4 = 7200 bytes`。展开:

```
索引(行 i)  字段    含义                              数值范围
─────────  ──────  ──────────────────────────────  ──────────────────
[i, 0]     x1      bbox 左上角 X(letterbox 空间)    0.0  ~ 1280.0
[i, 1]     y1      bbox 左上角 Y(letterbox 空间)    0.0  ~ 1280.0
[i, 2]     x2      bbox 右下角 X(letterbox 空间)    0.0  ~ 1280.0
[i, 3]     y2      bbox 右下角 Y(letterbox 空间)    0.0  ~ 1280.0
[i, 4]     conf    置信度(已 sigmoid)              0.0  ~ 1.0
[i, 5]     cls     类别 ID                          固定 0(单类)
```

**关键点 1**:坐标已经是 **像素值**,不是归一化的 [0,1] 也不是 [0,1000](VLM 那种风格),而是 `[0, 1280]` 之间的浮点数。

**关键点 2**:坐标处于 **letterbox 后的 1280×1280 空间**,**不是原图坐标**。要拿到原图像素必须做 5.5.4 的反变换。

**关键点 3**:300 行按 conf 降序排列,所以你只要 `arr[arr[:, 4] >= conf_thresh]` 就拿到了所有有效结果,无需排序。

#### 5.5.2 Letterbox 可视化

##### 案例 A:水平照片 1920×1080(典型相机出片)

```
原图 1920×1080:
┌──────────────────────────────────────────┐
│                                          │
│         鸟在 (1500,540) 附近              │  ← 1080 高
│                                          │
└──────────────────────────────────────────┘
                    1920 宽

scale = 1280/1920 ≈ 0.6667
缩放后 1280×720:
┌────────────────────────────┐
│      鸟在 (1000,360) 附近   │  ← 720 高
└────────────────────────────┘
            1280 宽

letterbox 1280×1280(上下 pad 灰):
┌────────────────────────────┐
│  ▓▓▓▓▓ pad_top=280 ▓▓▓▓▓   │
├────────────────────────────┤
│   ↑ 实际图像区域 720 高     │
│     鸟在 (1000, 360+280)   │
│           = (1000, 640)    │
│   ↓                        │
├────────────────────────────┤
│  ▓▓▓ pad_bottom=280 ▓▓▓    │
└────────────────────────────┘
        1280 宽
pad_left=0,pad_top=280
```

模型输出 letterbox 空间的 bbox `(950, 590, 1050, 690)`,反算回原图:

```
x_orig = (x_lb - 0)   / 0.6667
y_orig = (y_lb - 280) / 0.6667

(950, 590, 1050, 690) →
x1 = (950 - 0)   / 0.6667 ≈ 1425
y1 = (590 - 280) / 0.6667 ≈ 465
x2 = (1050 - 0)  / 0.6667 ≈ 1575
y2 = (690 - 280) / 0.6667 ≈ 615
→ 原图 bbox (1425, 465, 1575, 615) ✓
```

##### 案例 B:垂直照片 4500×8000(超高比)

```
scale = 1280/8000 = 0.16
缩放后 720×1280
letterbox:左右各 pad (1280-720)/2 = 280 灰边
pad_left=280,pad_top=0

设鸟在原图 (3000, 5000):
缩放后 (480, 800)
letterbox 空间 (480+280, 800+0) = (760, 800)

模型输出 letterbox 空间 (760, 800),反算:
x_orig = (760 - 280) / 0.16 = 480 / 0.16 = 3000 ✓
y_orig = (800 - 0)   / 0.16 = 800 / 0.16 = 5000 ✓
```

#### 5.5.3 Letterbox 代码逐行解读

```python
def letterbox(img, size=1280):
    h, w = img.shape[:2]               # ① cv2.imread 返回 (H, W, 3),先 H 后 W
    scale = size / max(h, w)           # ② 用 长边 决定缩放比;< 1 是缩小,> 1 是放大
    nh = int(round(h * scale))         # ③ round() 不是 int(),减少 1px 误差
    nw = int(round(w * scale))
    canvas = np.full((size, size, 3),  # ④ 新建灰图,值 114 是 YOLO 系列约定
                     114, dtype=np.uint8)
    pad_top  = (size - nh) // 2        # ⑤ 整除,所以左/右 或 上/下 可能差 1 像素
    pad_left = (size - nw) // 2        #    这就是为什么后面要 clip 到原图边界
    canvas[pad_top:pad_top+nh,
           pad_left:pad_left+nw] = \
        cv2.resize(img, (nw, nh),      # ⑥ 注意 cv2.resize 参数顺序是 (W, H) 不是 (H, W)
                   interpolation=cv2.INTER_LINEAR)
    return canvas, scale, (pad_left, pad_top)  # ⑦ 必须把 scale 和 pad 也带出去给后处理
```

> **常见 bug**: 第 ⑥ 行 `cv2.resize(img, (nh, nw))` 写反 → 图像被旋转 90° → 模型输出全错。

#### 5.5.4 坐标反变换 — 公式推导

正向 letterbox 把原图坐标 `(x_o, y_o)` 映射到 letterbox 空间 `(x_l, y_l)`:

```
x_l = x_o * scale + pad_left
y_l = y_o * scale + pad_top
```

我们手上有 `x_l, y_l`,要反推 `x_o, y_o`:

```
x_o = (x_l - pad_left) / scale
y_o = (y_l - pad_top ) / scale
```

⚠ **顺序很重要**:**先减 pad,再除 scale**。反过来会算错。

直觉解释:letterbox 是"先缩放,再补 pad",反操作就是"先去掉 pad,再放大回原尺寸"。

#### 5.5.5 边界 clip 处理

由于:
- 第 ③ 步的 `int(round(...))` 带 ±0.5 像素误差
- 第 ⑤ 步的 `// 2` 整除带 ±1 像素误差
- 模型预测本身可能略微越界(rare,但要兜底)

反变换后必须 **clip 到原图尺寸**:

```python
H, W = orig_shape
out[:, 0] = np.clip(out[:, 0], 0, W)     # x1
out[:, 2] = np.clip(out[:, 2], 0, W)     # x2
out[:, 1] = np.clip(out[:, 1], 0, H)     # y1
out[:, 3] = np.clip(out[:, 3], 0, H)     # y2
```

> 不 clip 的后果:bbox 可能出现 `x1=-0.3` 或 `y2=H+0.7`,你的下游 `img[y1:y2, x1:x2]` 裁切代码会得到空数组或抛异常。

#### 5.5.6 完整后处理函数(注释版)

```python
def postprocess(raw, scale, pad, orig_shape, conf_thresh=0.5):
    arr = raw[0]                                  # (300, 6)
    if arr.ndim != 2 or arr.shape[1] < 5:
        return np.zeros((0, 5), dtype=np.float32)

    # ① conf 阈值过滤(等价于 NMS,因为 YOLO26 head 内部已去重)
    arr = arr[arr[:, 4] >= conf_thresh]
    if len(arr) == 0:
        return np.zeros((0, 5), dtype=np.float32)

    # ② 反 letterbox(用 copy 避免改动 ORT 内部 buffer)
    out = arr[:, :5].astype(np.float32, copy=True)
    pad_left, pad_top = pad
    out[:, [0, 2]] = (out[:, [0, 2]] - pad_left) / scale     # x1, x2 一起处理
    out[:, [1, 3]] = (out[:, [1, 3]] - pad_top)  / scale     # y1, y2 一起处理

    # ③ clip 到原图边界
    H, W = orig_shape
    out[:, 0] = np.clip(out[:, 0], 0, W)
    out[:, 2] = np.clip(out[:, 2], 0, W)
    out[:, 1] = np.clip(out[:, 1], 0, H)
    out[:, 3] = np.clip(out[:, 3], 0, H)
    return out                                    # (N, 5) [x1,y1,x2,y2,conf]
```

#### 5.5.7 5 个常见集成 bug(踩过别人的坑)

| # | bug | 症状 | 检查 |
|---|---|---|---|
| 1 | 忘了 BGR→RGB | bbox 框在错位置,conf 偏低 | `x = canvas[..., ::-1]` 必须有 |
| 2 | 忘了归一化 / 255 | 模型输出全是 conf<0.001 的垃圾 | `astype(np.float32) / 255.0` |
| 3 | HWC 没转 CHW | InferenceSession 报形状错误 | `.transpose(2, 0, 1)` |
| 4 | 反变换顺序写反:**先除 scale 再减 pad** | bbox 左/上偏移很大(~280px) | 必须 **先减 pad 再除 scale** |
| 5 | 忘了 clip,负坐标传给 cv2 切片 | 切出来空 ndarray 或 IndexError | clip 到 `[0, W]` `[0, H]` |

#### 5.5.8 自检方法(强烈推荐部署前跑一次)

把模型预测 bbox 在原图上画出来,人眼看是否对得上鸟:

```python
import cv2
img = cv2.imread('test.jpg')
boxes = predict(sess, 'test.jpg')
for x1, y1, x2, y2, c in boxes:
    cv2.rectangle(img, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 3)
    cv2.putText(img, f'{c:.2f}', (int(x1), int(y1)-8),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
cv2.imwrite('debug.jpg', img)
```

如果 bbox 整体往左上偏 → 反变换写反了(bug #4)
如果 bbox 旋转 90° → cv2.resize 参数写反了(letterbox 第 ⑥ 行)
如果完全没框 → BGR/RGB 或归一化错了(bug #1, #2)

#### 5.5.9 跨平台一致性 & Mac 加速 bug 详解(重要,必读)

##### 真实测量数据(30 张测试图 vs CPU EP baseline)

| Provider 配置 | 平均 IoU | 最差 IoU | 最大 bbox 偏差 | 速度 | 结论 |
|---|---|---|---|---|---|
| 同 provider run-to-run | 1.000 | 1.000 | 0 px | — | 单 provider 完全确定 |
| **CoreML EP `MLComputeUnits=CPUAndGPU`** | **0.999** | **0.997** | **0.6 px** | **126 ms** | ✅ **生产可用** |
| CoreML EP 默认(`MLComputeUnits=ALL`) | 0.454 | **0.000** | **1379 px** | 99 ms | ❌ **不可用** |
| CoreML EP `CPUOnly` | 0.999 | 0.997 | 0.6 px | 694 ms | ✅ 但慢 |

##### Bug 定位:Apple Neural Engine

通过对比三种 CoreML 计算单元配置(`ALL` / `CPUAndGPU` / `CPUOnly`),可以**精确定位** bug 所在:

```
CoreML EP partition 时把模型切 12 段,分发到不同硬件:
├── 含 ANE: 让 ANE 跑到 NMS-free head 的 advanced indexing → 输出错 bbox
├── CPU+GPU: head 走 Metal GPU shader → 正确 + 快(126 ms)
└── CPU only: head 走 CPU 实现 → 正确但慢(694 ms,比纯 ORT CPU EP 还慢,不推荐)
```

**根因:** YOLO26 的 NMS-free head 包含 `Gather` / `ScatterND` / `TopK` 等 advanced indexing 算子组合(用于 1-to-K 匹配)。
- Metal GPU 走标准 shader,严格按 ONNX spec 实现 → 正确
- ANE 用专用电路,对 dynamic-shape advanced indexing 的精度模型与 ONNX 不完全一致 → 数值漂移在 head 内被放大,选错 anchor grid cell,**bbox 落到画外**(实测 x1=-80 那种)

##### 极端失败案例(供你复现/验证)

某些图在 default CoreML EP(含 ANE)下:

```
图: 5Y3A7448.JPG (同一只鸟,两路 conf 都 ~0.94)
CPU EP / CoreML CPUAndGPU letterbox bbox: (431, 504, 597, 746)  165×242 px ✓
CoreML default (ANE)      letterbox bbox: (-80, 211, 626, 1095) 706×884 px ✗
                                          ↑ 负坐标 = 画布外
```

更典型的 batch 数据(default CoreML 30 张测试图):
- 30 张图里 18 张 IoU < 0.7
- 5 张 IoU < 0.1(几乎完全错位)
- 仅 7 张 IoU > 0.95

##### 你应该怎么用

`inference_example.py` 里 `build_session()` **默认就是 `CPUAndGPU` 模式**,你什么都不用做:

```python
sess = build_session('weights/best.onnx')
# ✓ 默认 CoreML CPUAndGPU,正确 + ~126 ms/img on M3 Pro
```

如果你被人忽悠去开 `MLComputeUnits=ALL` 想再快一点 — **不要**,bbox 会错。
如果你想极端保守跑纯 CPU(例如做 mAP 评估对齐,跨机器位级一致):

```python
sess = build_session('weights/best.onnx', coreml_mode=None)
# 纯 CPU EP,~523 ms/img
```

##### Letterbox `int()` vs `int(round())`

预处理的 1 px rounding 差异在不同 provider 上会被放大,实测在 CPU+GPU 模式下偏差 0–20 px(几张图),不影响 conf=0.5 阈值的检出。代码默认用 `int(round())` 与 Ultralytics 官方 letterbox 一致,这条无需关心。

##### 长期跟踪

- **Apple coremltools / Core ML team:** 已知 ANE advanced indexing 精度问题,**无明确修复时间**。
- **ONNX Runtime team:** CoreML EP partition 策略可能在 1.20+ 改进(让 ANE 不接 advanced indexing 节点)。
- **Ultralytics:** Mac 部署官方推荐 PyTorch MPS(`device='mps'`),不为 ONNX EP bug 兜底。
- **当前部署立场:** 强制 `CPUAndGPU` 是正确选择,**不要等**。

#### 5.5.10 重复 bbox 去重(v1.0.1 新增,自动启用)

**症状:** 一只鸟,YOLO 输出 2 个几乎完全重叠的 bbox(实测 IoU ≥ 0.96,坐标差 1-2 像素),用户看图会以为"识别成 2 只鸟"。

**根因:** YOLO26 NMS-free head 用 1-to-K 匹配训练,每个 ground truth 应该只激活一个 query 输出。但少数情况下 2 个 query 都收敛到同一只鸟,各自输出高 conf bbox。这本来 NMS 一招就能解决,但 YOLO26 的设计哲学是"去掉 NMS",所以模型本身不带这一步。

**实测发病率:**

| 集 | 样本 | 重复框图片 | 比例 |
|---|---|---|---|
| 1950 张未见过的摄影实拍 | 1950 | 24 | 1.23% |

**修复(v1.0.1 已默认开启):**

`postprocess()` 在 conf 过滤 + 反 letterbox + clip 之后,新增第 4 步 `_dedup_nms()`:

```python
def _dedup_nms(boxes, iou_thresh=0.5):
    """boxes 已按 conf 降序排,把 IoU>=阈值 的后框丢弃。"""
    n = len(boxes)
    keep = np.ones(n, dtype=bool)
    for i in range(n):
        if not keep[i]: continue
        ai = (boxes[i,2]-boxes[i,0])*(boxes[i,3]-boxes[i,1])
        for j in range(i+1, n):
            if not keep[j]: continue
            # 计算 IoU(代码省略,见 inference_example.py)
            if iou_ij >= iou_thresh:
                keep[j] = False
    return boxes[keep]
```

**为什么阈值 0.5 安全?**

- 真实重复框(同一只鸟):IoU > 0.95
- 普通并排两只鸟:IoU < 0.2
- 中间地带几乎不存在,所以 0.5 这个阈值非常宽容,不会误杀真的两只鸟

**实测验证:** 24/24 真重复框被正确去重,3 个边缘案例(yolo_n=2 但 IoU 0.05-0.3)保留。

**剩余边缘案例 — 长尾鸟拆框:**

绶带鸟这类**超长尾**鸟,YOLO 偶尔把"鸟身 + 头" 和"长尾巴"分别框出来,两个 bbox 互不重叠(IoU ≈ 0)。dedup NMS 不会(也不应该)合并它们。如果你的下游需要"一只鸟一个 bbox",可以做后处理把同一图里 IoU=0 但中心距离 < bird_size×3 的 bbox 合并成一个。本包不做这个,因为是 case-by-case。

---

### 5.6 Confidence 阈值

| 场景 | 推荐 conf | 备注 |
|---|---|---|
| **摄影/相册裁切**(默认推荐) | **0.5** | 用户验证过,精度+召回都"超预期" |
| 鸟类调查/科研(尽量不漏) | 0.25 | 召回↑,但会有少量假阳性 |
| 预筛选(后接 VLM 复核) | 0.1 | 高召回,假阳性由下游过滤 |
| ❌ 不要用 | 0.001 | 这是训 mAP 用的未校准阈值,产品里全是垃圾框 |

---

## 6 · 部署平台

### 6.1 NVIDIA GPU(Linux / Windows)

```bash
pip install onnxruntime-gpu>=1.17
```

代码自动检测 CUDA EP,无需改动。RTX 3060 ~25ms,RTX 4090 ~14ms,RTX 5090 ~12ms。

### 6.2 macOS (Apple Silicon)

```bash
pip install onnxruntime>=1.17    # 不要装 onnxruntime-silicon(已废弃)
```

代码默认走 **CoreML EP `MLComputeUnits=CPUAndGPU` 模式**(关 ANE,只用 Metal GPU)。M3 Pro ~126 ms,bbox 与 CPU EP IoU 0.999。

⚠ **不要把 `coreml_mode` 改成 `'ALL'`** — 会启用 ANE,导致 NMS-free head 输出错误 bbox(几何偏差可达 1300+ px,部分图直接画外)。详见 §5.5.9。

> **为什么不直接用 CoreML 原生格式 (.mlpackage)?**
> 实测 macOS 26 + coremltools 9.0 export 失败("MLIR pass manager failed")。社区已知系统级 bug,等 Apple 修。ONNX + CoreML EP `CPUAndGPU` 模式是当前最优替代。

> **为什么不用 PyTorch MPS?**
> PyTorch MPS 在 Mac 上跑 YOLO26 是工作的(~80–150 ms),Ultralytics 官方支持。**但需要 ultralytics + torch + torchvision 一整套依赖**(~3 GB),不适合纯部署场景。本包专注零依赖 ONNX 路径。如需 PyTorch MPS 推理,用原始 `best.pt` 权重 + `model.predict(img, device='mps')` 即可。

### 6.3 CPU only(开发/低算力服务器)

```bash
pip install onnxruntime
```

走 CPU EP,Intel i7-12700H ~850ms。够批处理用,不够实时。

### 6.4 移动端(Android / iOS)

- iOS: 把 best.onnx 放进 app bundle,用 `onnxruntime-objc` 加载,走 CoreML EP。
- Android: `onnxruntime-android` + NNAPI EP。

> 移动端推理 imgsz=1280 偏吃资源,如需移动端可重训 imgsz=640 版本(精度 mAP50 大约 -3pp)。

---

## 7 · 训练数据 & 配置

### 7.1 数据规模

| 集 | 张数 | 来源 |
|---|---|---|
| train | **44,312** | 4 个数据桶(远景/中景/近景/特写)均衡采样 |
| val | **5,000** | observation-level split(EXIF 时间聚类) |
| test | **4,924** | 同上,完全独立 |
| **hard negatives** | **800** | 人工挑的"非鸟但容易被误判"图(树枝、岩石、瀑布溅水) |
| **总计** | **49,236** | (train+val+test+neg) |

### 7.2 训练超参(实战版)

```yaml
model: yolo26l.pt           # Ultralytics 官方 large 预训练
imgsz: 1280
batch: 32                   # RTX 5090 32GB,显存峰值 ~30GB
epochs: 100                 # 实际 88 epoch 早停
patience: 25
optimizer: auto             # YOLO26 + >10K iter 自动选 MuSGD
cos_lr: true
close_mosaic: 15
mosaic: 1.0
mixup: 0.05                 # 检测任务 mixup 宜小
erasing: 0.2
scale: 0.9
copy_paste: 0.1
amp: true                   # 5090 bf16+FA
cache: disk                 # 90GB cgroup 不能用 cache=ram
workers: 12
```

### 7.3 训练曲线特点

- ep1-30: 主要 cls loss 下降阶段
- ep30-60: bbox 精修,mAP@0.5:0.95 持续上升
- ep60-67: best epoch 区间
- **ep67 后**: val_cls_loss 缓慢上升(轻度过拟合,bbox loss 仍稳),early stop 触发于 ep88

---

## 8 · 已知限制 & 边界

| 场景 | 表现 | 建议 |
|---|---|---|
| 模糊鸟(失焦/运动模糊) | 多数判 `[]`(无鸟) | **这是正确行为** — 摄影场景模糊鸟用户不要 |
| 远景小鸟(area<32²) | mAP50 ~0.84,稍弱 | 小鸟密集场景考虑降 conf 到 0.3 |
| 鸟群密集(>20 只重叠) | bbox 数量上限 300,不会丢 | NMS-free 模型,不会被 NMS 抑制 |
| 飞行中模糊翼尖 | bbox 偶尔切到鸟身体范围,翼尖外漏 | 用 `crop_with_padding(pad_ratio=0.15)` 外扩 15% |
| 非鸟但形似(风筝/无人机) | 偶有假阳性 | 增加 hard negative 重训,或后接 VLM 复核 |
| 黑白/反色照片 | 未训,精度未知 | 转 RGB 后再喂模型,但效果不保证 |

---

## 9 · 推荐使用场景

✅ **适合**:
- 个人/工作室摄影作品自动鸟类识别 + 裁切
- 鸟类摄影相册策展(大批量预筛选)
- 鸟类调查项目自动化预标注(后接人工复核)

⚠ **不太适合**:
- 实时视频推理(单帧 100ms,30fps 视频要 onnxruntime-gpu + RTX 4090 以上)
- 鸟类细分类(本模型只判"是不是鸟",不区分品种)
- 半身/极特写(只能拿到 bbox,不能 segment)

❌ **不适合**:
- 行为识别(站/飞/啄食 — 需要时序模型)
- 鸟群计数到精确个体(密集重叠时 bbox 可能合并)

---

## 10 · 常见 FAQ

**Q1: 模型能识别多少种鸟?**
A: 模型只输出 `bird` 这一个类,不区分品种。如果你需要细分类(例如 200+ 种),需要在本模型基础上接一个分类 head 或单独训分类模型(用 `crop_with_padding` 裁切后的图当输入)。

**Q2: 输入分辨率为啥固定 1280?**
A: 模型导出时 `dynamic=False`,batch 和 imgsz 都固定。改 dynamic 会损失 ~10% 速度。如果你必须用 640 或 1024,需要重新导出 ONNX(`yolo export model=best.pt format=onnx imgsz=640`)。

**Q3: 输出 300 行是上限吗,会不会漏检?**
A: 300 是 YOLO26 head 的最大 query 数。鸟群密度大于 300 的场景,模型会取 conf 最高的 300 个。实测自然摄影场景 99% 以上图片 < 50 只鸟,300 完全够。

**Q4: 为什么 conf=0.5 推荐,不是 0.25?**
A: 摄影场景下"宁缺毋滥" — 一个错误 bbox 比漏一只远景小鸟更让人头疼(用户人工审片成本)。0.5 在 PR 曲线上接近 F1 最大点,实测精度 0.961,召回 0.919,够用。

**Q5: 我可以 fine-tune 这个模型吗?**
A: 本包内 **只有 ONNX,不含 .pt 权重**。fine-tune 需要原 PyTorch checkpoint,联系作者获取。

**Q6: ONNX 文件 95MB 太大,能压缩吗?**
A: 可以用 `onnxruntime.quantization` 做 int8 量化,大小可降到 ~25MB,速度 +30%,精度 mAP50 大约 -2pp。但摄影场景不建议(精度比速度重要)。

**Q7: 推理时显存/内存占用?**
A:
- CUDA: 单图推理 ~1.5 GB 显存(模型 + activation)
- CoreML: ~800 MB unified memory
- CPU: ~600 MB RAM
首张推理后内存稳定,不会持续增长。

**Q8: 我代码运行没报错但完全检测不到鸟。**
A: 99% 是预处理写错了。按这个顺序自检:
1. cv2.imread 后 print(img.shape) — 正常应该 (H, W, 3)
2. letterbox 后 cv2.imwrite('debug_lb.jpg', canvas) — 看是否横纵正确,灰边对称
3. 检查归一化:`x.max()` 应在 ~1.0 附近不是 ~255
4. 检查 BGR→RGB:`x[0,0,500,500]` 三通道值应类似肉眼看到的颜色
5. 用本仓库的 `inference_example.py` 直接对同一张图跑一遍对比

---

## 11 · 性能基准测试

如何复现表格 §2 的速度数字:

```python
import time, numpy as np, onnxruntime as ort
sess = ort.InferenceSession('weights/best.onnx',
                            providers=['CoreMLExecutionProvider', 'CPUExecutionProvider'])
x = np.random.randn(1, 3, 1280, 1280).astype(np.float32)

# warmup
for _ in range(5):
    sess.run(None, {'images': x})

# benchmark
times = []
for _ in range(50):
    t0 = time.time()
    sess.run(None, {'images': x})
    times.append((time.time() - t0) * 1000)
print(f'mean={np.mean(times):.1f}ms  p50={np.median(times):.1f}ms  p99={np.percentile(times,99):.1f}ms')
```

---

## 12 · 版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| **v1.1** | **2026-05-09** | **Fine-tune 训练**:基于 v1.0 best.pt + 2.6K 新数据(1.4K 用户绶带实拍 + 1.3K dino 林鸟科属)+ 18K 防遗忘留样,共 ~22K 数据。20 epoch / freeze=10 / lr0=0.001 / AdamW。结果:**150 张 holdout 上 bbox-recall 59% → 87% (+28pp)**。绶带肖像 bucket 6/7 从 42%/15% 拉到 100%。详见下方"训练故事"和 §2.2。 |
| v1.0.1 | 2026-05-08 | postprocess 增加 dedup NMS — 修复 NMS-free head 偶发的重复 bbox 问题(实测 1950 张未见数据中 1.23% 受影响,IoU ≥ 0.96)。详见 §5.5.10。**模型权重未变**,仅推理代码升级。 |
| v1.0 | 2026-04-26 | 首次发布。88 epoch 训练 + 800 hard neg |

### v1.1 训练故事(简版)

**起因:** v1.0 部署后用 Qwen3.5-VL 交叉验证 1950 张未见用户实拍,发现 0504-1 文件夹(绶带鸟专题)recall 仅 61%。原训练 49K 数据里 Terpsiphone 仅 144 张,且每物种 40 张硬上限。

**数据准备:** 从 dino 项目 71.7 万张图筛"林鸟科属白名单"(鹟科/莺科/鹎科/绣眼/山雀/鹛科 + 特殊体型 drongo/kingfisher/trogon/treepie),过 长边 ≥ 1280 阈值,得 1,257 张。加上 0504-1 用户实拍 yolo_missed 549 张 + 防遗忘 ~18K(原 ysn/dino/china)。**所有候选用 qwen3.5-4b@q4_k_m 重新跑 VLM 标注**(发现旧 recrop_results 标注 67% 错位,不能复用)。

**对照实验:** 跑了 stage 2(全解冻 lr=0.0003)和 round 2(更激进 fine-tune 配置)做对照,结果都不如 stage 1(详细教训见 TRAINING_JOURNAL)。**v1.1 用的是 stage 1 模型**。

### 已知问题(v1.1 未解)

- **远景小鸟(bucket 0/1, bbox <0.5%)recall 仍低**(0% / 16.7%)— 这是 small-object detection 的固有难题,fine-tune 改善有限。要解决需要专门技术(SAHI 切图推理、HRNet 高分辨率特征等),不在当前模型能力范围。
- **超长尾鸟偶尔被拆成 2 个 bbox**(身体 + 长尾)— IoU = 0,dedup NMS 不会合并(也不应该)。属于训练数据 bbox 标注规范问题,下一轮可专门调整。

---

## 13 · 许可 & 致谢

- **模型权重**:作者自有,内部使用,未明确开源 license。
- **架构**:基于 [Ultralytics YOLO26](https://github.com/ultralytics/ultralytics)(AGPL-3.0)。
- **数据**:全部来自作者及合作伙伴自拍的鸟类摄影作品 + 人工/VLM 标注。
- **训练算力**:[AutoDL](https://www.autodl.com/) 单卡 RTX 5090 ~40h。

---

## 14 · 联系

模型/数据/集成问题:回到原项目 issue 区。

> 部署遇到玄学问题先按 §5.5.7 五大 bug 自检,再按 §10 Q8 五步排查 — 90% 的问题都在这两节里。

_文档版本: 1.0  ·  生成日期: 2026-04-26_
