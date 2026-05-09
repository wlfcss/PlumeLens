# PlumeLens Model Assets

本目录包含 PlumeLens 鸟类照片分析管线所使用的 ONNX 模型、torch species v4 资产与配套元数据。

## 模型总览

| 模型 | 文件 | 大小 | 用途 |
|------|------|------|------|
| YOLOv26l-bird-det v1.1 | `yolo26l-bird-det.onnx` | 99.9 MB (95 MiB) | 鸟类目标检测 |
| bird_visibility v2.0 | `bird_visibility11.onnx` | 98.1 MB | 11 关键点(头 5 + 身 6) + 5 visibility + view/facing |
| bird flight classifier v1 | `bird_flight_classifier.onnx` | 40 MB | 飞版 / 非飞版二分类，输出 P(fly) |
| CLIPIQA+ | `clipiqa_plus.onnx` | 293 MB | 语义画质评估（含 CLIP ViT backbone） |
| HyperIQA | `hyperiqa.onnx` | 104 MB | 技术画质评估（含 ResNet50 backbone + HyperNet forward_patch） |
| DINOv3 species v4 backbone | `species/backbone/model.safetensors` | 578 MB | torch/transformers 鸟种特征提取（**不入 git**） |
| DINOv3 species v4 adapter | `species/v4/seed42_adapter.pt` | 31.6 MB | LoRA + species head + reject head → 1591 类三态识别（**不入 git**） |

配套元数据：

| 文件 | 大小 | 内容 |
|------|------|------|
| `bird_visibility11_config.json` | 2 KB | v2 校准阈值(eye/head/body/tail/wings 五项 best_*) |
| `bird_flight_classifier_config.json` | 5 KB | 飞版分类器阈值曲线，产品默认 `P(fly) ≥ 0.35` |
| `species/canonical_extended.parquet` | 约 100 KB | 1591 类鸟类分类表（class_id + 中/拉丁/英文名 + IUCN + 保护等级） |
| `species/v4_calibration_policy.json` | 12 KB | `balanced_v1` 三态阈值：recognized / uncertain / unrecognized |
| `species_wiki.parquet` | 925 KB | 旧 1535 种 Wikipedia 首段介绍（v4 extra 物种暂用分类表 fallback） |
| `*.MODEL_CARD.md` | — | 各模型交付文档 |

`species_wiki.parquet` schema：`canonical_sci` (主键与 taxonomy 对齐) + `zh_title/zh_extract/zh_url` + `en_title/en_extract/en_url` + `image_url` + `updated_at`。由 [`scripts/fetch_species_wiki.py`](../../scripts/fetch_species_wiki.py) 通过 MediaWiki action API 批量爬取。

**合计：~1.2 GB**

## 管线调用顺序

```
原图
  ↓ YOLO det (1280, conf=0.5, letterbox 114) → 鸟类 bbox 列表
  ↓ 对每个 bbox 裁切（均基于原片）
  ├─ bbox +10% padding → bird_visibility11 (640) → 11 关键点 + 5 visibility(head/eye/body/tail/wings) + view_angle/facing
  ├─ 同一主体裁切 → bird_flight_classifier (224) → P(fly), posture=flying/perched
  ├─ bbox 2.5× 语义裁切 → CLIPIQA+
  ├─ bbox +10% 技术裁切 → HyperIQA → 综合画质分 → 4 档分级
  └─ grade 满足 species_min_grade 时：
     ↓ DINOv3 ViT-L/16 torch backbone (384px) + LoRA → 2048-d 特征
     ↓ species head + reject head → 1591 类 top-K + 三态识别
```

## 各模型详情

### YOLOv26l-bird-det v1.1

完整规格见 [`yolo26l-bird-det.MODEL_CARD.md`](./yolo26l-bird-det.MODEL_CARD.md)。

- **架构**：YOLO26l（26.2M 参数，NMS-free end-to-end）
- **输入**：float32 [1, 3, 1280, 1280] RGB 0-1，letterbox 114/255 填充
- **输出**：float32 [1, 300, 6] top-k 槽位 (x1,y1,x2,y2,conf,cls)
- **推荐 conf**：0.5（摄影场景）
- **重复框去重**：沿用 v1.0.1 后处理默认 IoU 0.5
- **实拍 holdout**：150 张未见用户实拍 bbox recall 从 v1.0 的 59.0% 提升到 v1.1 的 87.2%
- **原 test baseline**：v1.0 在 4,924 张 test set 上 mAP@0.5=0.927 / Recall=0.919；v1.1 未在该 test set 重新完整评测
- **训练**：v1.0 base 49,236 张 + v1.1 fine-tune 约 22K 数据（绶带鸟用户实拍、DINO 林鸟科属、防遗忘留样）

### bird_visibility v2.0

完整规格见 [`bird_visibility.MODEL_CARD.md`](./bird_visibility.MODEL_CARD.md)。

- **架构**：YOLO26l-pose（25.6M 参数 fused）
- **输入**：float32 [1, 3, 640, 640]
- **输出**：float32 [1, 300, 39],每槽位 = 6 检测字段 + 11 关键点×3 (x, y, conf)
- **关键点顺序**(11):头部 5 `bill, crown, nape, left_eye, right_eye` + 躯干 6 `belly, breast, back, tail, left_wing, right_wing`
- **flip_idx**：`[0, 1, 2, 4, 3, 5, 6, 7, 8, 10, 9]`
- **派生 visibility**(5 项):head / eye / body / tail / wings
- **派生 posture**(3 项):view_angle (frontal/side/back) / facing (left/right) / posture (perched/flying)。当前产品优先使用 `bird_flight_classifier.onnx` 的 `P(fly)`；分类器不可用时才回退到严格的关键点几何启发式。
- **校准阈值**([`bird_visibility11_config.json`](./bird_visibility11_config.json)):
  - `box_threshold` = 0.05(校准值);产品运行默认 `pose_box_threshold` = 0.02,避免遮挡长尾实拍中 box_conf 偏低但关键点可用的结果被整条丢弃
  - `eye_threshold` = 0.45 / `head_threshold` = 0.45 / `head_eye_threshold` = 0.40
  - `body_threshold` = 0.30 / `tail_threshold` = 0.40 / `wing_threshold` = 0.40
  - `expanded_box_margin` = 0.15
- **Val F1**:Eye 99.28%,Head 99.91%,Body 99.84%,Tail 96.90%,Wings 97.55%
- **训练**:NABirds 48,562 张,555 种北美鸟类(60 epoch,起点权重 v1 best.pt 5kpt→11kpt 迁移)
- **下游产品规则**:头眼齐全 + posture=flying → grader 上提一档(飞版自动升档,鸟摄精选惯例)

### bird flight classifier v1

- **架构**：YOLO26m-cls，二分类 `fly / nofly`
- **输入**：主体 crop resize + center crop 到 224,RGB 0-1
- **输出**：`[P(fly), P(nofly)]`
- **产品阈值**：`P(fly) ≥ 0.35` 判定飞版
- **验证集**：290 张，最佳阈值 F1 96.43%（precision 94.74%,recall 98.18%）
- **业务定位**：替代旧的飞版几何启发式，降低长尾鸟、侧飞鸟、局部展翼照片的错判；几何规则仅作为分类器缺失时的保守 fallback。

### DINOv3 鸟种分类

完整规格见 [`dinov3_species.MODEL_CARD.md`](./dinov3_species.MODEL_CARD.md)。

- **架构**：DINOv3-ViT-L/16 (frozen) + q/v LoRA adapter + species head + reject head
- **训练数据**：photos_v4_full + GBIF + eBird/Macaulay + 多学术数据集
- **Test top-1**：seed42 top-1 94.30%，top-5 98.50%，macro 93.90%，reject AUC 0.9106
- **覆盖**：1591 类输出，class_id 与 `canonical_extended.parquet` 一一对应

**推理流程**：

```
bbox crop → square expand(+15%, no forced min side) → Resize(short edge=384)+CenterCrop
  → ImageNet normalize → transformers AutoModel(DINOv3 ViT-L/16)
  → CLS token ⊕ mean(patch tokens) = 2048-d 特征
  → species head softmax + reject head sigmoid
  → balanced_v1 policy → recognized / uncertain / unrecognized
  → top-K → species/canonical_extended.parquet 查询元数据
```

**分类表字段**（`species/canonical_extended.parquet`）：
- `canonical_sci` / `canonical_zh` / `canonical_en` — 拉丁名/中文名/英文名
- `class_id` / `scope` — v4 模型输出下标 / v12 或 extra
- `order_sci` / `family_sci` / `family_zh` — 目/科（拉丁 + 中文）
- `iucn` — LC/NT/VU/EN/CR/NR/DD
- `protect_level` — 一级 / 二级 / null
- `note` — 备注

**重要**：v4 输出是业务三态，不只是 top-1 概率：

- `recognized`：可作为自动物种结论。
- `uncertain`：只作为复核候选，API 标记为 `model_unconfirmed`，不进入羽迹有效物种。
- `unrecognized`：拒识，不返回物种候选。

**为什么 species v4 不走 ONNX**：

- RoPE fp16 路径会 NaN，纯 ONNX 导出后准确率明显退化
- CoreML EP 对 ViT 覆盖度差，且旧双尺度 ONNX 路线在 Mac 上慢
- 当前正式路线：torch + transformers，MPS/CUDA 用 bf16，CPU 用 fp32

**为什么 species v4 大文件不入 git**：

`species/backbone/model.safetensors`（578 MB）与 `species/v4/seed42_adapter.pt`（31.6 MB）超过 GitHub 常规体积预期。我们选择不用 LFS，分发时由 `electron-builder` 通过 `extraResources` 打包：

- 开发机本地放在 `engine/models/species/`
- 打包后放在 `Resources/models/species/`
- `.gitignore` 排除 backbone safetensors 与 adapter ckpt

### CLIPIQA+ / HyperIQA

由 `scripts/export_iqa_onnx.py` 从 [pyiqa](https://github.com/chaofengc/IQA-PyTorch) 预训练权重导出。

- **输入**：float32 [1, 3, 224, 224]，RGB raw 0-1
- **输出**：[1, 1] score 0-1
- **裁切口径**：CLIPIQA+ 使用 bbox 2.5× 语义/构图裁切；HyperIQA 使用 bbox +10% padding 的主体技术裁切
- **融合权重**：0.40 × CLIPIQA+ + 0.60 × HyperIQA（在 `engine/core/config.py`）— HyperIQA 技术质量(锐度/噪声/曝光)主导,CLIPIQA+ 语义/构图作辅助
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

- **yolo26l-bird-det.onnx** / **bird_visibility11.onnx** / **DINOv3 鸟种分类 adapter**：由 [wlfcss](https://github.com/wlfcss) 个人训练产出，他人使用需注明来源
- **DINOv3 backbone**：Meta 的 DINOv3 LVD-1689M 预训练权重，遵循 [DINOv3 License](./dinov3_species.MODEL_CARD.md)（非商业限制，商业使用需与 Meta 确认）
- **CLIPIQA+** / **HyperIQA**：基于公开 IQA 研究模型的 ONNX 导出，遵循原始论文及代码仓库的许可协议
- **species/canonical_extended.parquet**：基于《中国鸟类名录 v12.0》整理
