# PlumeLens ONNX Models

本目录包含 PlumeLens 鸟类照片分析管线所使用的 ONNX 模型。

## 模型列表

| 模型 | 文件 | 大小 | 用途 |
|------|------|------|------|
| YOLOv26l-bird-det (v1.0) | `yolo26l-bird-det.onnx` | 99.9 MB | 鸟类目标检测 |
| CLIPIQA+ | `clipiqa_plus.onnx` | 1.2 MB | 语义画质评估 |
| HyperIQA | `hyperiqa.onnx` | 0.4 MB | 技术画质评估 |

## YOLOv26l-bird-det v1.0

完整模型卡片见 [`yolo26l-bird-det.MODEL_CARD.md`](./yolo26l-bird-det.MODEL_CARD.md)。

**核心规格**：

| 项 | 值 |
|---|---|
| 架构 | YOLO26l (Ultralytics, L 变体, NMS-free end-to-end) |
| 参数量 | 26.2M |
| 训练分辨率 | **imgsz = 1280** |
| 推荐 conf | **0.5**（摄影场景）/ 0.25（高召回场景） |
| 输入 | float32 [1, 3, 1280, 1280] RGB 0-1，letterbox 114 填充 |
| 输出 | float32 [1, N, 6] → (x1, y1, x2, y2, conf, class_id)，N 变长 |
| 类别 | 单类 `bird` |

**精度指标（独立测试集 353 张，训练从未见过）**：

| 指标 | 值 |
|------|---:|
| mAP@0.5 | 0.9364 |
| mAP@0.5:0.95 | 0.6920 |
| Precision | 0.9246 |
| Recall | 0.9021 |
| F1 | 0.9132 |

**训练数据**：49,236 张，覆盖 1,495 种鸟类
- dino 40w（多数据集聚合）32,583 张
- China-bird-YOLO（人工精标）10,073 张
- 用户自拍（Canon 真实部署场景）3,432 张
- Hard negatives（花朵/建筑/风景）2,441 张

**训练信息**：
- 训练硬件：AutoDL RTX 5090 32GB
- 训练软件：PyTorch 2.8.0 + CUDA 12.8 + Ultralytics 8.4.41
- 训练日期：2026-04-23 → 2026-04-24
- Best epoch：63 / 88 (EarlyStopping patience=25)

## 版权说明

- **yolo26l-bird-det.onnx**：由 [wlfcss](https://github.com/wlfcss) 个人训练产出（原项目 `yolo-split-new`），他人使用需注明来源。
- **clipiqa_plus.onnx** / **hyperiqa.onnx**：基于公开 IQA 研究模型（CLIPIQA+、HyperIQA）导出的 ONNX 格式，遵循原始论文及代码仓库的许可协议。
