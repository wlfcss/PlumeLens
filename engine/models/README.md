# PlumeLens Model Assets

本目录包含 PlumeLens 鸟类照片分析管线所使用的 ONNX 模型、torch species v3 资产与配套元数据。

## 模型总览

| 模型 | 文件 | 大小 | 用途 |
|------|------|------|------|
| YOLOv26l-bird-det v1.0 | `yolo26l-bird-det.onnx` | 99.9 MB | 鸟类目标检测 |
| bird_visibility v1.1 | `bird_visibility.onnx` | 98.0 MB | 头部/眼睛关键点 + 可见性判定 |
| CLIPIQA+ | `clipiqa_plus.onnx` | 293 MB | 语义画质评估（含 CLIP ViT backbone） |
| HyperIQA | `hyperiqa.onnx` | 104 MB | 技术画质评估（含 ResNet50 backbone + HyperNet forward_patch） |
| DINOv3 species v3 backbone | `species/backbone/model.safetensors` | 578 MB | torch/transformers 鸟种特征提取（**不入 git**） |
| DINOv3 species v3 heads | `species/heads/seed*.pt` × 8 | 267 MB | 8-head 集成 → 1535 类 softmax（1301 训练类） |

配套元数据：

| 文件 | 大小 | 内容 |
|------|------|------|
| `bird_visibility_config.json` | 1 KB | 姿态模型校准阈值 |
| `species/canonical_extended.parquet` | 44 KB | 1535 类鸟类分类表（中/拉丁/英文名 + IUCN + 保护等级） |
| `species/species_list_1301.parquet` | 52 KB | 1301 个有训练数据的 model_output_id mask |
| `species_wiki.parquet` | 925 KB | 1535 种 Wikipedia 首段介绍（zh + en + 缩略图 URL，zh 99%+ 覆盖） |
| `*.MODEL_CARD.md` | — | 各模型交付文档 |

`species_wiki.parquet` schema：`canonical_sci` (主键与 taxonomy 对齐) + `zh_title/zh_extract/zh_url` + `en_title/en_extract/en_url` + `image_url` + `updated_at`。由 [`scripts/fetch_species_wiki.py`](../../scripts/fetch_species_wiki.py) 通过 MediaWiki action API 批量爬取。

**合计：~1.4 GB**

## 管线调用顺序

```
原图
  ↓ YOLO det (1280, conf=0.5, letterbox 114) → 鸟类 bbox 列表
  ↓ 对每个 bbox 裁切（均基于原片）
  ├─ bbox +10% padding → bird_visibility (640) → 头部/眼睛关键点 + head_visible / eye_visible
  ├─ bbox 2.5× 语义裁切 → CLIPIQA+
  ├─ bbox +10% 技术裁切 → HyperIQA → 综合画质分 → 4 档分级
  └─ head_visible && eye_visible 时：
     ↓ DINOv3 ViT-L/16 torch backbone (480px) → 2048-d 特征
     ↓ 8 个 torch head softmax 平均 → 1535 类 top-K（ghost 类由 trained_mask 清零）
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

### bird_visibility v1.1

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

- **架构**：DINOv3-ViT-L/16 (frozen) + 8-head ensemble
- **训练数据**：photos_v4_full + GBIF + eBird/Macaulay + 多学术数据集
- **Test top-1**：约 91.5%
- **覆盖**：1535 类输出，其中 1301 类有训练数据；234 个 ghost 类由 trained mask 清零防误命中

**推理流程**：

```
bbox crop → square expand(+15%, min side 30%) → Resize(short edge=480)+CenterCrop
  → ImageNet normalize → transformers AutoModel(DINOv3 ViT-L/16)
  → CLS token ⊕ mean(patch tokens) = 2048-d 特征
  → 8 个 HeadOnlyClassifier(.pt) softmax 平均
  → trained_mask 清零 ghost 类
  → top-K → species/canonical_extended.parquet 查询元数据
```

**分类表字段**（`species/canonical_extended.parquet`）：
- `canonical_sci` / `canonical_zh` / `canonical_en` — 拉丁名/中文名/英文名
- `order_sci` / `family_sci` / `family_zh` — 目/科（拉丁 + 中文）
- `iucn` — LC/NT/VU/EN/CR/NR/DD
- `protect_level` — 一级 / 二级 / null
- `note` — 备注

**重要**：species_head 输出 1535 维，但只有 **1301 种有训练数据**。未训练的 ghost 类由 `species_list_1301.parquet` 生成的 trained mask 清零，前端 top-K 仍建议过滤 confidence < 0.01。

**为什么 species v3 不走 ONNX**：

- RoPE fp16 路径会 NaN，纯 ONNX 导出后准确率明显退化
- CoreML EP 对 ViT 覆盖度差，且旧双尺度 ONNX 路线在 Mac 上慢
- 当前正式路线：torch + transformers，MPS/CUDA 用 bf16，CPU 用 fp32

**为什么 species v3 大文件不入 git**：

`species/backbone/model.safetensors`（578 MB）与 `species/heads/*.pt`（共 267 MB）超过 GitHub 常规体积预期。我们选择不用 LFS，分发时由 `electron-builder` 通过 `extraResources` 打包：

- 开发机本地放在 `engine/models/species/`
- 打包后放在 `Resources/models/species/`
- `.gitignore` 排除 backbone safetensors 与 head ckpt

### CLIPIQA+ / HyperIQA

由 `scripts/export_iqa_onnx.py` 从 [pyiqa](https://github.com/chaofengc/IQA-PyTorch) 预训练权重导出。

- **输入**：float32 [1, 3, 224, 224]，RGB raw 0-1
- **输出**：[1, 1] score 0-1
- **裁切口径**：CLIPIQA+ 使用 bbox 2.5× 语义/构图裁切；HyperIQA 使用 bbox +10% padding 的主体技术裁切
- **融合权重**：0.35 × CLIPIQA+ + 0.65 × HyperIQA（在 `engine/core/config.py`）
- **分级阈值**：`<0.45` 淘汰 / `0.45-0.60` 记录 / `0.60-0.75` 可用 / `≥0.75` 精选

**重要**：`engine/pipeline/quality.py` 的 `QualityAssessor` 只做 resize + CHW。
PyIQA 导出的 ONNX 图内部已经做各自所需的 normalization（CLIPIQA+ 使用 CLIP mean/std，
HyperIQA 使用 ImageNet mean/std）。传入任意 `[H, W, 3] float32 0-1` 的 crop 即可，
不要在 ONNX 外部再次标准化。

**历史教训**：2026-04-12 ~ 2026-04-25 期间项目携带的 IQA ONNX 是 external-data
格式 (`.onnx.data` 伴随文件缺失)，所有 pytest 都 mock 了 ONNX session 导致这个
bug 从未被发现。本次修复 (commit `3daec3f`+) 重新导出为 inline-weights 并新增
`test_integration.py` 加载真实 ONNX 做 smoke test，避免同类 regression。

## 版权说明

- **yolo26l-bird-det.onnx** / **bird_visibility.onnx** / **DINOv3 鸟种分类 heads**：由 [wlfcss](https://github.com/wlfcss) 个人训练产出，他人使用需注明来源
- **DINOv3 backbone**：Meta 的 DINOv3 LVD-1689M 预训练权重，遵循 [DINOv3 License](./dinov3_species.MODEL_CARD.md)（非商业限制，商业使用需与 Meta 确认）
- **CLIPIQA+** / **HyperIQA**：基于公开 IQA 研究模型的 ONNX 导出，遵循原始论文及代码仓库的许可协议
- **species/canonical_extended.parquet**：基于《中国鸟类名录 v12.0》整理
