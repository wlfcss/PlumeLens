# PlumeLens ONNX Models

本目录包含 PlumeLens 鸟类照片分析管线所使用的 ONNX 模型与配套元数据。

## 模型总览

| 模型 | 文件 | 大小 | 用途 |
|------|------|------|------|
| YOLOv26l-bird-det v1.0 | `yolo26l-bird-det.onnx` | 99.9 MB | 鸟类目标检测 |
| bird_visibility v1.0 | `bird_visibility.onnx` | 98.0 MB | 头部/眼睛关键点 + 可见性判定 |
| CLIPIQA+ | `clipiqa_plus.onnx` | 1.2 MB | 语义画质评估 |
| HyperIQA | `hyperiqa.onnx` | 0.4 MB | 技术画质评估 |
| DINOv3 backbone | `dinov3_backbone.onnx` | 1.2 GB | 鸟种分类特征提取（frozen，**不入 git**，见下文） |
| DINOv3 ensemble heads | `species_ensemble.onnx` | 83 MB | 7-head 集成 → 1516 种 softmax |

配套元数据：

| 文件 | 大小 | 内容 |
|------|------|------|
| `bird_visibility_config.json` | 1 KB | 姿态模型校准阈值 |
| `species_taxonomy.parquet` | 68 KB | 1516 种鸟类分类表（中/拉丁/英文名 + IUCN + 保护等级） |
| `species_wiki.parquet` | 925 KB | 1516 种 Wikipedia 首段介绍（zh + en + 缩略图 URL，zh 99.3% / en 99.9% 覆盖） |
| `*.MODEL_CARD.md` | — | 各模型交付文档 |

`species_wiki.parquet` schema：`canonical_sci` (主键与 taxonomy 对齐) + `zh_title/zh_extract/zh_url` + `en_title/en_extract/en_url` + `image_url` + `updated_at`。由 [`scripts/fetch_species_wiki.py`](../../scripts/fetch_species_wiki.py) 通过 MediaWiki action API 批量爬取。

**合计：~1.5 GB**

## 管线调用顺序

```
原图
  ↓ YOLO det (1280, conf=0.5, letterbox 114) → 鸟类 bbox 列表
  ↓ 对每个 bbox 裁切 (+10% padding)
  ↓ bird_visibility (640, conf=0.25) → 头部/眼睛关键点 + head_visible / eye_visible
  ↓ 对 head_visible && eye_visible 的鸟
  ↓ CLIPIQA+ + HyperIQA → 综合画质分 → 4 档分级
  ↓ DINOv3 backbone (双尺度 512 + 640) → 2048-d 特征
  ↓ species_ensemble (7-head) → 1516 种 top-K
```

## 各模型详情

### YOLOv26l-bird-det v1.0

完整规格见 [`yolo26l-bird-det.MODEL_CARD.md`](./yolo26l-bird-det.MODEL_CARD.md)。

- **架构**：YOLO26l（26.2M 参数，NMS-free end-to-end）
- **输入**：float32 [1, 3, 1280, 1280] RGB 0-1，letterbox 114/255 填充
- **输出**：float32 [1, 300, 6] top-k 槽位 (x1,y1,x2,y2,conf,cls)
- **推荐 conf**：0.5（摄影场景）
- **Test mAP@0.5**：0.9364，**Recall**：0.9021（353 张独立测试集）
- **训练**：49,236 张，覆盖 1,495 种鸟类（China-bird-YOLO + dino 40w + 用户自拍 + hard negatives）

### bird_visibility v1.0

完整规格见 [`bird_visibility.MODEL_CARD.md`](./bird_visibility.MODEL_CARD.md)。

- **架构**：YOLO26l-pose（28.6M 参数）
- **输入**：float32 [1, 3, 640, 640]
- **输出**：float32 [1, 300, 21]，每槽位 = 6 检测字段 + 5 关键点×3 (x, y, conf)
- **关键点顺序**：`bill, crown, nape, left_eye, right_eye`
- **flip_idx**：`[0, 1, 2, 4, 3]`
- **校准阈值**（[`bird_visibility_config.json`](./bird_visibility_config.json)）：
  - `box_threshold` = 0.05（单鸟集校准值，crop 输入下直接用此值取最高置信度）
  - `eye_threshold` = 0.45
  - `head_threshold` = 0.35
  - `head_eye_threshold` = 0.10
  - `expanded_box_margin` = 0.15
- **Val F1**：Eye 99.31%，Head 99.88%
- **训练**：NABirds 48,562 张，555 种北美鸟类

### DINOv3 鸟种分类

完整规格见 [`dinov3_species.MODEL_CARD.md`](./dinov3_species.MODEL_CARD.md)。

- **架构**：DINOv3-ViT-L/16 (frozen) + 7-head ensemble
- **训练数据**：photos_v4_full + GBIF + eBird/Macaulay + 多学术数据集
- **Test top-1**：91.93% / top-3 95.20% / top-5 95.52%
- **覆盖**：1,018 种中国鸟类（名录 1,516 种，训练过滤 `min_images_per_species=75` 后剩 1,018）

**推理流程**：

```
bbox crop → square pad → 双尺度 Resize+CenterCrop (512 & 640)
  → ImageNet normalize → dinov3_backbone.onnx × 2
  → 两个 2048-d 特征
  → species_ensemble.onnx(feat_512, feat_640)
  → (1, 1516) softmax 概率
  → top-K → species_taxonomy.parquet 查询元数据
```

**分类表字段**（`species_taxonomy.parquet`）：
- `canonical_sci` / `canonical_zh` / `canonical_en` — 拉丁名/中文名/英文名
- `order_sci` / `family_sci` / `family_zh` — 目/科（拉丁 + 中文）
- `iucn` — LC/NT/VU/EN/CR/NR/DD
- `protect_level` — 一级 / 二级 / null
- `note` — 备注

**重要**：species_head 输出 1516 维，但只有 **1018 种有训练数据**。未训练的 498 类权重保持初始化状态，logit 很低不会误预测，但前端 top-K 时建议过滤 confidence < 0.01 的结果。

**ONNX 导出说明**：

- Backbone 使用 **dynamic H/W**（同一个 ONNX 文件支持 512 和 640 输入）
- 精度：**fp32**（纯 fp16 在 ViT-L 的 LayerNorm/Softmax 处会溢出，精度崩坏；原项目用 `torch.autocast` 混合精度规避）
- 推理后端：**CPU EP（当前）**，Mac 上实测 ~1.6 秒/张
- CoreML EP 暂时不可用：NeuralNetwork 格式只支持 30% 节点反而更慢；MLProgram 格式要求固定形状，与动态 backbone 不兼容。等 onnxruntime 1.26+ 或有更好方案再优化。

**为什么 `dinov3_backbone.onnx` 不入 git**：

文件大小 1.2 GB，超过 GitHub 单文件 100 MB 限制。我们选择不用 LFS（速度太慢），改用"按需导出"策略：

- 首次开发需要物种识别功能时，运行 [`scripts/export_dinov3_backbone.py`](../../scripts/export_dinov3_backbone.py) 从原始 PyTorch 权重导出
- 分发阶段：由 CI 在打包前导出一次，`electron-builder` 通过 `extraResources` 打包进安装包
- 该文件已在 `.gitignore` 中排除

导出前提：需要 `dino_bird_classifier` 原始包（`models/dinov3-vitl16/` + `checkpoints/*.pt` + `bird_classifier/model.py`）。具体用法见脚本 docstring。

### CLIPIQA+ / HyperIQA

基于公开 IQA 研究模型（CLIPIQA+、HyperIQA）导出的 ONNX。

- **输入**：float32 [1, 3, H, W] 动态尺寸
- **输出**：[1, 1] score 0-1
- **融合权重**：0.35 × CLIPIQA+ + 0.65 × HyperIQA（在 `engine/core/config.py`）
- **分级阈值**：`<0.33` 淘汰 / `0.33-0.43` 记录 / `0.43-0.60` 可用 / `≥0.60` 精选

## 版权说明

- **yolo26l-bird-det.onnx** / **bird_visibility.onnx** / **DINOv3 鸟种分类 heads**：由 [wlfcss](https://github.com/wlfcss) 个人训练产出，他人使用需注明来源
- **DINOv3 backbone**：Meta 的 DINOv3 LVD-1689M 预训练权重，遵循 [DINOv3 License](./dinov3_species.MODEL_CARD.md)（非商业限制，商业使用需与 Meta 确认）
- **CLIPIQA+** / **HyperIQA**：基于公开 IQA 研究模型的 ONNX 导出，遵循原始论文及代码仓库的许可协议
- **species_taxonomy.parquet**：基于《中国鸟类名录 v12.0》整理
