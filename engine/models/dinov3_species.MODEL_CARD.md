# DINOv3 中国鸟类识别模型 · 交付文档

> 本文档描述 `dino/` 项目当前可部署的识别模型，供**其它项目集成**使用。
> 最后更新：2026-04-24
> 当前版本：**v1.0 (D2 完成版)**，test top-1 = **91.93%**

---

## 1. 模型概述

### 1.1 任务
从**单张鸟类照片**输出**中国鸟类物种**的 Top-K 预测（含中文名、学名、IUCN、保护等级）。

### 1.2 架构
```
输入图片
    ↓
[可选] Qwen3-VL / YOLO 裁切（见 §6 部署管线）
    ↓
EXIF 正向化 → Resize + CenterCrop → DINOv3-ViT-L/16 (frozen)
    ↓
2048-d 特征（CLS ⊕ mean(patch_tokens)）
    ↓
7 个分类 head 并行前向（ensemble）
    ↓
softmax 平均 → top-k 输出
```

### 1.3 支持的物种范围
**1,018 种中国鸟类**（训练集覆盖种）。参考《中国鸟类名录 v12.0》(1,516 种)，训练过滤 `min_images_per_species=75` 后剩 1,018。

- 训练集来源：自建 photos_v4_full + GBIF + eBird/Macaulay + 多个学术数据集
- 长尾平衡：Balanced Softmax + effective-number β=0.999 采样
- Shot-wise 性能差距：many vs medium = 2.6pp（长尾表现较好）

---

## 2. 性能指标（D2，2026-04-20 冻结版）

### 2.1 验证集 (test split, 26,627 图)

| 指标 | 值 | 备注 |
|---|---|---|
| **top-1 accuracy** | **91.93%** | 多尺度 ensemble (512+640) |
| top-3 accuracy | 95.20% | |
| top-5 accuracy | 95.52% | |
| **macro recall** | **90.24%** | 长尾加权平均 |
| shot-many (≥500 张/种) | 90.79% | |
| shot-medium (100-500 张/种) | 88.16% | |

### 2.2 推理速度（单张图，MacBook Pro M5 Max / MPS）

| 配置 | 延迟 | FPS |
|---|---|---|
| 单模型 @ 512 (seed=2024) | 25 ms | 40 |
| 4×512 ensemble | 78 ms | 12.8 |
| 3×640 ensemble | 172 ms | 5.8 |
| **7-model 多尺度 ensemble (推荐)** | **247 ms** | 4 |

推理前 detector 裁切阶段另算（见 §6.2）。

---

## 3. 交付文件清单

### 3.1 模型权重（runs/）

| 文件 | 大小 | 说明 |
|---|---|---|
| `runs/phase1_baseline/best.pt` | 17 MB | seed=42, 512 分辨率训练 |
| `runs/phase1_seed123/best.pt` | 17 MB | seed=123 |
| `runs/phase1_seed456/best.pt` | 17 MB | seed=456 |
| `runs/phase1_seed2024/best.pt` | 17 MB | seed=2024（单模型最佳）|
| `runs/phase2_640_seed42/best.pt` | 17 MB | 640 分辨率 |
| `runs/phase2_640_seed123/best.pt` | 17 MB | |
| `runs/phase2_640_seed456/best.pt` | 17 MB | |

**合计：~120 MB**（7 个 ckpt）。

每个 ckpt 是 **head 权重** 字典：
```python
{
    'model_state': {
        'head_norm.weight': Tensor (2048,),
        'head_norm.bias':   Tensor (2048,),
        'species_head.weight': Tensor (1516, 2048),
        'species_head.bias':   Tensor (1516,),
        'order_head.weight':   Tensor (28, 2048),
        'family_head.weight':  Tensor (115, 2048),
        'genus_head.weight':   Tensor (504, 2048),
    },
    'epoch': int,
    'args':  dict   # 训练时的超参
    'metrics': dict # 验证集指标
}
```

**注意**：`species_head` 形状是 **(1516, 2048)**（对齐 v12.0 全名单）。训练仅 1018 种有数据；其余类别输出 logit 低，推理时不会误预测。

### 3.2 Backbone 权重（models/）

```
models/dinov3-vitl16/
├── model.safetensors       1.2 GB (DINOv3-ViT-L/16 LVD-1689M 预训练)
├── config.json
├── configuration.json
├── preprocessor_config.json
├── LICENSE.md
└── README.md
```

**来源**：modelscope `facebook/dinov3-vitl16-pretrain-lvd1689m`
**License**：DINOv3 License（非商业限制，商业用途需与 Meta 确认）
**架构参数**：
- hidden_dim = 1024
- depth = 24
- heads = 16
- register_tokens = 4
- patch_size = 16
- image_size = 224 (默认, 高分辨率用 512/640)

### 3.3 元数据（taxonomy/）

| 文件 | 大小 | 内容 |
|---|---|---|
| `taxonomy/canonical.parquet` | 68 KB | **1,516 种权威分类表**（9 列）|

字段定义：
```python
{
    'canonical_sci':  str,   # 拉丁名（唯一 ID）
    'canonical_zh':   str,   # 中文名
    'canonical_en':   str,   # 英文名
    'order_sci':      str,   # 目
    'family_sci':     str,   # 科（拉丁名）
    'family_zh':      str,   # 科（中文）
    'iucn':           str,   # LC / NT / VU / EN / CR / NR / DD
    'protect_level':  str,   # '一级' / '二级' / null
    'note':           str,   # 备注（通常 null）
}
```

### 3.4 参考代码（scripts/）

| 文件 | 用途 |
|---|---|
| `scripts/train/model_head_only.py` | `HeadOnlyClassifier` 类定义 |
| `scripts/predict.py` | 完整推理 pipeline（含裁切）|
| `scripts/predict_web.py` | Flask 上传 demo |

---

## 4. 输入输出 API

### 4.1 输入

**原始输入**：RGB 图片（PIL.Image 或 numpy ndarray），任意尺寸。

**前处理链**（推理时固定）：
```python
# 1. EXIF 正向化
img = ImageOps.exif_transpose(img).convert("RGB")

# 2. bbox 裁切（可选，但建议）
#    见 §6.2 detector 选项
img_crop = img.crop(bbox_ltrb)

# 3. 标准预处理（送入 DINOv3 前）
preprocess = Compose([
    Resize(size, interpolation=BICUBIC, antialias=True),  # size in {512, 640}
    CenterCrop(size),
    ToTensor(),
    Normalize(
        mean=(0.485, 0.456, 0.406),   # ImageNet
        std =(0.229, 0.224, 0.225),
    ),
])
x = preprocess(img_crop).unsqueeze(0)   # (1, 3, size, size)
```

### 4.2 输出

**原始 logits**：`(1, 1516)` 的 tensor，**index 对齐** `canonical_sci` 列表（按字典序排序后的）。

```python
# 从 canonical.parquet 构造索引
all_sci = sorted(canonical['canonical_sci'].to_list())  # 1516 items
sci_to_idx = {s: i for i, s in enumerate(all_sci)}
idx_to_sci = {i: s for i, s in enumerate(all_sci)}
# species_head 的第 i 行权重对应 idx_to_sci[i]
```

**推理建议输出**：Top-5 物种记录，每条含：
```python
{
    "rank": int,                    # 1-5
    "canonical_sci": str,
    "canonical_zh": str,
    "canonical_en": str,
    "family_zh": str,
    "iucn": str,                    # LC/NT/VU/EN/CR
    "protect_level": str,           # 一级/二级/null
    "confidence": float,            # 0-1, softmax 概率
}
```

---

## 5. 使用方法

### 5.1 最小代码（单图识别）

```python
import torch
import torch.nn.functional as F
import polars as pl
from PIL import Image, ImageOps
from torchvision.transforms import v2 as T
from transformers import AutoModel

# --- 1. 加载 backbone（一次，启动时）---
backbone = AutoModel.from_pretrained("models/dinov3-vitl16").eval().to("cuda")
for p in backbone.parameters():
    p.requires_grad_(False)
R = backbone.config.num_register_tokens  # = 4

# --- 2. 加载分类头 ensemble ---
from scripts.train.model_head_only import HeadOnlyClassifier

CKPTS = [
    ("runs/phase1_baseline/best.pt",   512),
    ("runs/phase1_seed123/best.pt",    512),
    ("runs/phase1_seed456/best.pt",    512),
    ("runs/phase1_seed2024/best.pt",   512),
    ("runs/phase2_640_seed42/best.pt",  640),
    ("runs/phase2_640_seed123/best.pt", 640),
    ("runs/phase2_640_seed456/best.pt", 640),
]

heads = []
for path, size in CKPTS:
    sd = torch.load(path, map_location="cpu", weights_only=False)
    m = HeadOnlyClassifier(
        feature_dim=2048, num_species=1516,
        features_layout="pooled", dropout=0.0,
        num_orders=28, num_families=115, num_genera=504,
    )
    m.load_state_dict(sd["model_state"])
    heads.append((size, m.eval().to("cuda")))

# --- 3. 加载分类表 ---
canonical = pl.read_parquet("taxonomy/canonical.parquet")
all_sci = sorted(canonical["canonical_sci"].to_list())
lookup = {r["canonical_sci"]: r for r in canonical.iter_rows(named=True)}

# --- 4. 预测函数 ---
def transform(size):
    return T.Compose([
        T.Resize(size, interpolation=T.InterpolationMode.BICUBIC, antialias=True),
        T.CenterCrop(size),
        T.ToImage(),
        T.ToDtype(torch.float32, scale=True),
        T.Normalize(mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225)),
    ])

@torch.no_grad()
def predict(img_pil, top_k=5):
    img = ImageOps.exif_transpose(img_pil).convert("RGB")
    # 两个尺度特征
    feats_by_size = {}
    for size in (512, 640):
        x = transform(size)(img).unsqueeze(0).to("cuda").half()
        with torch.autocast(device_type="cuda", dtype=torch.float16):
            out = backbone(pixel_values=x).last_hidden_state.float()
        cls_tok = out[:, 0, :]
        patch_tok = out[:, 1 + R:, :].mean(dim=1)
        feats_by_size[size] = torch.cat([cls_tok, patch_tok], dim=-1)  # (1, 2048)

    # Ensemble forward
    probs = []
    for size, model in heads:
        logits = model(feats_by_size[size])["species"]
        probs.append(F.softmax(logits, dim=1).cpu()[0])
    ensemble = torch.stack(probs).mean(dim=0)
    topk_probs, topk_idx = ensemble.topk(top_k)

    results = []
    for rank, (p, i) in enumerate(zip(topk_probs.tolist(), topk_idx.tolist()), 1):
        sci = all_sci[i]
        r = lookup.get(sci, {})
        results.append({
            "rank": rank,
            "canonical_sci": sci,
            "canonical_zh": r.get("canonical_zh"),
            "canonical_en": r.get("canonical_en"),
            "family_zh":    r.get("family_zh"),
            "iucn":         r.get("iucn"),
            "protect_level": r.get("protect_level"),
            "confidence":   round(float(p), 4),
        })
    return results

# --- 5. 用 ---
preds = predict(Image.open("test.jpg"), top_k=5)
for p in preds:
    print(p)
```

### 5.2 参考实现
完整实现见 [`scripts/predict.py`](scripts/predict.py)。`Predictor` 类封装了所有细节，包括：
- detector 优先级选择（Qwen-VL → PlumeLens → COCO YOLO）
- bbox 扩展 + 方形裁切
- 设备自适应（CUDA / MPS / CPU）
- 多尺度/多 seed ensemble

---

## 6. 完整部署管线（含裁切）

### 6.1 管线图
```
用户上传图片
    ↓
[Step 1] EXIF 正向化 + RGB 转换
    ↓
[Step 2] 鸟类检测（裁切） ← 可选但推荐
    ↓
[Step 3] bbox 扩展 15% margin + 方形化（像素空间）
    ↓
[Step 4] Crop → DINOv3 特征 (512 + 640 双尺度)
    ↓
[Step 5] 7-head ensemble softmax 平均
    ↓
[Step 6] Top-5 + 元数据查询
```

### 6.2 裁切器选项

| 方案 | 精度 | 速度 | 依赖 | 推荐度 |
|---|---|---|---|---|
| **Qwen3-VL via LM Studio** | 高（已人工验证）| 3-4 s/图 | LM Studio 本地服务 | 当前默认 |
| **本项目 YOLO v1**（D4 另外项目训） | 未知 | ~50 ms/图 | 纯 ONNX | **部署推荐**（训完后） |
| **PlumeLens YOLO26l** | 中（小目标漂移）| 30 ms/图 | ONNX | 备用 |
| **COCO YOLOv26x** | 低（误识花朵）| 50 ms/图 | ultralytics | 最后 fallback |
| **无裁切**（整图）| 低（-3~5pp top-1） | 0 ms | 无 | 不推荐 |

### 6.3 bbox 后处理（从裁切器输出到 DINOv3 输入）

```python
def expand_bbox_to_square_px(xc_norm, yc_norm, w_norm, h_norm,
                              W, H, margin=0.15, min_side_frac=0.30):
    """YOLO/VLM bbox → 扩展方形像素坐标 (l,t,r,b)"""
    cx = xc_norm * W; cy = yc_norm * H
    w_px = w_norm * W * (1 + margin)
    h_px = h_norm * H * (1 + margin)
    side = max(w_px, h_px, min_side_frac * min(W, H))
    side = min(side, float(min(W, H)))
    cx = min(max(cx, side/2), W - side/2)
    cy = min(max(cy, side/2), H - side/2)
    return (int(round(cx - side/2)), int(round(cy - side/2)),
            int(round(cx + side/2)), int(round(cy + side/2)))
```

**注意事项**：
- 所有计算**必须在像素空间**，不能混用 W-归一化 / H-归一化（历史 bug，见 D3 阶段）
- Qwen3-VL 输出 `bbox_2d` 是 **[0, 1000] 归一化**，需 `/1000 * (W or H)` 换算
- `min_side_frac=0.30` 强制最小裁切边长，防小目标放大失真

---

## 7. 依赖环境

### 7.1 Python 包
```
python         >= 3.10
torch          >= 2.1           # 2.5+ recommended
torchvision    >= 0.16
transformers   >= 4.38          # for DINOv3ViTModel
polars         >= 0.20
pillow         >= 10.0
numpy          >= 1.24
# 可选（若集成 detector）
onnxruntime    >= 1.17          # for PlumeLens YOLO
ultralytics    >= 8.0           # for COCO YOLO fallback
requests       >= 2.30          # for Qwen-VL LM Studio 调用
flask          >= 3.0           # 仅 predict_web.py
```

### 7.2 硬件建议

| 场景 | 推荐硬件 | 说明 |
|---|---|---|
| 实时推理 | NVIDIA GPU ≥ 8GB VRAM | DINOv3-L fp16 约 2.5GB，ensemble 加 1GB |
| Apple Silicon | M1 Pro+ (MPS) | 已验证 M5 Max 能跑 |
| CPU 推理 | 16-core 64GB RAM | 不推荐，单张 ~5s |

---

## 8. 已知限制

### 8.1 物种覆盖
- 仅 **1,018** 种有训练数据（v12.0 里 489 种图片数 < 75 被排除）
- **CR 极危种**（如中华凤头燕鸥）训练样本少（test 仅 6 张），预测置信度不可信
- **不支持**非中国原生逸出种（宠物鹦鹉、鸵鸟等 Tier 2 未训练）

### 8.2 Failure modes
- **远景小鸟**（bbox 占比 < 0.5%）：精度下降 5-10pp
- **背面/飞行姿态**：top-1 降低，top-5 仍稳
- **晨昏暗光**：亮度 < config 阈值的图训练时 flag 但未删，可能影响少数样本
- **幼鸟 / 过渡羽**：羽色不典型，可能混入相似种
- **多鸟场景**：裁切器选主鸟，其它鸟丢失

### 8.3 地域偏差
- photos_v4_full 主要来自**长三角/云南**拍摄者
- 新疆/西藏/东北等地特有种样本相对少
- IUCN CR/EN 种数据稀少（观测机会本身少）

---

## 9. 版本与下一步计划

### 当前版本
- **v1.0** (2026-04-20 冻结)：D2 多尺度 ensemble, test top-1 91.93%
- 训练数据：qwen 重裁**前**的 bbox（旧 YOLOv26x 污染 ~17%）

### 预期 v2.0（~2026-05）
- 用 qwen 重裁 bbox 重训 → 预期 test top-1 **94.0-94.3%**
- 8-seed ensemble（从 4-seed 扩 seed 多样性）
- 可能叠加 hflip TTA

关注 `runs/TRAINING_LOG.md` 获取最新进展。

---

## 10. 集成 checklist（给接手项目的人）

- [ ] 拷贝 `models/dinov3-vitl16/` 到集成项目
- [ ] 拷贝 7 个 head checkpoints 到 `runs/`
- [ ] 拷贝 `taxonomy/canonical.parquet`
- [ ] 拷贝 `scripts/train/model_head_only.py` + `scripts/predict.py`
- [ ] pip install 依赖（见 §7.1）
- [ ] 选一个 detector（§6.2），替换 `scripts/predict.py` 里 `detect_bird_bbox` 即可
- [ ] 跑 `scripts/predict.py photo.jpg` 验证无错误
- [ ] 人工检查几张已知物种图片，top-1 是否正确
- [ ] 在 workload 图片上测单图延迟
- [ ] 验证 GPU fp16 数值稳定（autocast 推理应该和 fp32 输出差 < 0.01 logit）

---

## 11. 联系 / 项目信息

- 根项目：`/Users/wlfcss/Desktop/workspace/dino`
- 训练履历：`runs/TRAINING_LOG.md`
- 部署测试工具：`scripts/predict_web.py` (Flask :5178)
