# pyright: basic
"""Bird species classification via DINOv3 ViT-L/16 (480px) + 8-head ensemble.

v3 改造（相比 v2）：
- ONNX 路线放弃：DINOv3 RoPE fp16 NaN + CoreML EP ViT 覆盖度差，转 ONNX 后准确率显著下降
- 改用 PyTorch + transformers 直接推理（HF safetensors backbone + 8 个 .pt head）
- 单尺度 480×480（v2 是双尺度 512+640 拼接），与训练一致
- 1535 类输出，其中 1301 有训练数据，234 ghost 类用 trained_mask 清零防误命中
- bf16 on MPS/CUDA, fp32 on CPU（fp16 在 RoPE 上 NaN，bf16 安全）
- 测试 top-1 = 91.5%（改造前 91.93%；类数 +19，准确率小幅下降可接受）

模型路径：engine/models/species/
    backbone/
        config.json              HF 格式，DINOv3 ViT-L/16 配置
        model.safetensors        578 MB fp16 权重
    heads/
        seed42.pt … seed2024.pt  8 个独立 seed 的 head ckpt（每个 33 MB）
    canonical_extended.parquet   1535 类 metadata（中/拉/英 + IUCN + 保护等级）
    species_list_1301.parquet    1301 个有训练数据的类的 model_output_id 列表（用于 mask）
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from numpy.typing import NDArray
from PIL import Image

from engine.pipeline.models import SpeciesCandidate

# ImageNet 标准化（与 DINOv3 训练一致）
IMAGENET_MEAN: tuple[float, float, float] = (0.485, 0.456, 0.406)
IMAGENET_STD: tuple[float, float, float] = (0.229, 0.224, 0.225)

# 单尺度 480×480 — v3 训练 sweet spot
DEFAULT_IMAGE_SIZE = 480

# Bbox margin 与训练一致（v3 deploy.bird_predictor 也是 0.15）
BBOX_MARGIN = 0.15

# 1/1535 ≈ 0.00065，0.01 是保守下限。Ghost class 也会被 trained_mask 清零，
# min_confidence 是第二道闸（防训练类 head 输出极低的偶然命中）。
DEFAULT_MIN_CONFIDENCE: float = 0.01


def expand_bbox_to_square(
    xc_norm: float,
    yc_norm: float,
    w_norm: float,
    h_norm: float,
    image_w: int,
    image_h: int,
    margin: float = BBOX_MARGIN,
    min_side_frac: float = 0.30,
) -> tuple[int, int, int, int]:
    """YOLO bbox（归一化）→ 原图像素空间方形 crop。

    与 v3 deploy/bird_predictor.expand_bbox_to_square 等价（放在像素空间计算，
    避免归一化混淆）。

    Args:
        xc_norm, yc_norm, w_norm, h_norm: 归一化 bbox 中心和宽高（0-1）
        image_w, image_h: 原图像素尺寸（已应用 EXIF Orientation）
        margin: 边界扩展比例（15%）
        min_side_frac: 最小方形边长占原图短边的比例（防小目标失真）

    Returns:
        (l, t, r, b) 原图像素坐标，方形
    """
    cx = xc_norm * image_w
    cy = yc_norm * image_h
    w_px = w_norm * image_w * (1 + margin)
    h_px = h_norm * image_h * (1 + margin)
    side = max(w_px, h_px, min_side_frac * min(image_w, image_h))
    side = min(side, float(min(image_w, image_h)))
    cx = min(max(cx, side / 2), image_w - side / 2)
    cy = min(max(cy, side / 2), image_h - side / 2)
    return (
        int(round(cx - side / 2)),
        int(round(cy - side / 2)),
        int(round(cx + side / 2)),
        int(round(cy + side / 2)),
    )


def preprocess_for_dinov3(
    image: NDArray[np.float32], size: int = DEFAULT_IMAGE_SIZE
) -> torch.Tensor:
    """Resize(short edge=size) + CenterCrop(size) + ImageNet norm → torch tensor [1,3,size,size]。

    与 v3 deploy 流程对齐（torchvision.v2.Resize + CenterCrop + Normalize）。
    输入 numpy float32 0-1，输出 torch.float32 标准化后的 tensor。
    """
    pil = Image.fromarray((image * 255).astype(np.uint8))
    w, h = pil.size
    if w < h:
        new_w, new_h = size, int(round(h * size / w))
    else:
        new_w, new_h = int(round(w * size / h)), size
    pil = pil.resize((new_w, new_h), Image.Resampling.BICUBIC)
    left = (new_w - size) // 2
    top = (new_h - size) // 2
    pil = pil.crop((left, top, left + size, top + size))

    arr = np.asarray(pil, dtype=np.float32) / 255.0
    mean = np.asarray(IMAGENET_MEAN, dtype=np.float32).reshape(1, 1, 3)
    std = np.asarray(IMAGENET_STD, dtype=np.float32).reshape(1, 1, 3)
    arr = (arr - mean) / std
    chw = np.ascontiguousarray(arr.transpose(2, 0, 1))
    return torch.from_numpy(chw).unsqueeze(0)  # [1, 3, size, size]


# ============================================================
# Head model — 与 dino/scripts/bird_predictor.HeadOnlyClassifier 一致
# ============================================================
class HeadOnlyClassifier(nn.Module):
    """LayerNorm → MLP-2048 → species_head(1535) + 辅助 order/family/genus。

    辅助 head（order/family/genus）在 inference 时被忽略，只用 species head。
    这里保留它们让 state_dict 能 load 进来不报错。
    """

    def __init__(
        self,
        feature_dim: int,
        num_species: int,
        head_type: str = "mlp",
        mlp_hidden: int = 2048,
        num_orders: int | None = None,
        num_families: int | None = None,
        num_genera: int | None = None,
        dropout: float = 0.0,
    ) -> None:
        super().__init__()
        self.head_norm = nn.LayerNorm(feature_dim)
        self.head_dropout = nn.Dropout(dropout)
        self.head_type = head_type
        if head_type == "mlp":
            self.hidden_proj = nn.Sequential(
                nn.Linear(feature_dim, mlp_hidden),
                nn.GELU(),
            )
            head_in = mlp_hidden
        else:
            head_in = feature_dim
        self.species_head = nn.Linear(head_in, num_species)
        self.order_head = nn.Linear(head_in, num_orders) if num_orders else None
        self.family_head = nn.Linear(head_in, num_families) if num_families else None
        self.genus_head = nn.Linear(head_in, num_genera) if num_genera else None

    def forward(self, feat: torch.Tensor) -> torch.Tensor:
        """Inference 只返回 species logits (B, 1535)。"""
        feat = self.head_norm(feat)
        feat = self.head_dropout(feat)
        if self.head_type == "mlp":
            feat = self.hidden_proj(feat)
        return self.species_head(feat)

    @classmethod
    def from_ckpt(cls, ckpt_path: str | Path, map_location: str = "cpu") -> HeadOnlyClassifier:
        """从 v3 head .pt 推断结构 + load 权重。"""
        ckpt = torch.load(str(ckpt_path), map_location=map_location, weights_only=False)
        sd = ckpt["model_state"]
        head_type = "mlp" if "hidden_proj.0.weight" in sd else "linear"
        if head_type == "mlp":
            mlp_hidden = sd["hidden_proj.0.weight"].shape[0]
            feature_dim = sd["hidden_proj.0.weight"].shape[1]
        else:
            mlp_hidden = 0
            feature_dim = sd["species_head.weight"].shape[1]
        num_species = sd["species_head.weight"].shape[0]
        num_orders = sd["order_head.weight"].shape[0] if "order_head.weight" in sd else None
        num_families = sd["family_head.weight"].shape[0] if "family_head.weight" in sd else None
        num_genera = sd["genus_head.weight"].shape[0] if "genus_head.weight" in sd else None
        model = cls(
            feature_dim=feature_dim,
            num_species=num_species,
            head_type=head_type,
            mlp_hidden=mlp_hidden,
            num_orders=num_orders,
            num_families=num_families,
            num_genera=num_genera,
            dropout=0.0,
        )
        model.load_state_dict(sd)
        model.eval()
        return model


# ============================================================
# Taxonomy（1535 类元数据 + 1301 trained mask）
# ============================================================
class SpeciesTaxonomy:
    """Load canonical_extended.parquet (1535 rows) + species_list_1301.parquet (mask)。

    Inference 用 alpha-sorted canonical_sci 作为 head 索引，与训练一致。
    species_list_1301.parquet 给出 1301 个 trained model_output_id（不连续，
    跳过 234 ghost 类的 ID）。trained_mask 把 ghost 类的 logit 清零。
    """

    def __init__(self, deploy_dir: Path) -> None:
        import pyarrow.parquet as pq

        canonical_path = deploy_dir / "canonical_extended.parquet"
        trained_path = deploy_dir / "species_list_1301.parquet"

        # 1535 类全表，按 canonical_sci 字典序排（与 head 输出索引对齐）
        canonical_table = pq.read_table(str(canonical_path)).to_pylist()
        canonical_table.sort(key=lambda r: r["canonical_sci"])
        self._rows: list[dict[str, Any]] = canonical_table
        self._sci_to_row: dict[str, dict[str, Any]] = {
            r["canonical_sci"]: r for r in canonical_table
        }
        self.num_classes = len(canonical_table)

        # 1301 trained mask（只保留有训练数据的类的 logit）
        trained_table = pq.read_table(str(trained_path)).to_pylist()
        trained_ids: set[int] = {int(r["model_output_id"]) for r in trained_table}
        mask = np.zeros(self.num_classes, dtype=bool)
        for idx in trained_ids:
            if 0 <= idx < self.num_classes:
                mask[idx] = True
        self.trained_mask: NDArray[np.bool_] = mask

    def __len__(self) -> int:
        return self.num_classes

    def sci_at(self, index: int) -> str:
        return self._rows[index]["canonical_sci"]

    def lookup(self, sci: str) -> dict[str, Any] | None:
        return self._sci_to_row.get(sci)


# ============================================================
# Backbone wrapper — 抽 cls + mean(patch[1+R:]) 拼成 2048-d 特征
# ============================================================
class _DINOv3FeatureExtractor(nn.Module):
    """对应 dino/scripts/convert_to_coreml.DINOv3FeatureExtractor。

    输入 (B, 3, 480, 480)，输出 (B, 2*hidden) = (B, 2048) for ViT-L hidden=1024。
    """

    def __init__(self, backbone: nn.Module, num_register_tokens: int) -> None:
        super().__init__()
        self.backbone = backbone
        self.R = num_register_tokens

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        out = self.backbone(pixel_values=pixel_values)
        lh = out.last_hidden_state
        cls_tok = lh[:, 0, :]
        patch_tok = lh[:, 1 + self.R :, :].mean(dim=1)
        return torch.cat([cls_tok, patch_tok], dim=-1)


# ============================================================
# Main classifier
# ============================================================
class SpeciesClassifier:
    """End-to-end DINOv3 species classifier.

    对外接口与 v2 保持不变：classify(crop_float32_hwc_0_1) → list[SpeciesCandidate]。
    内部实现切换到 torch + transformers，单尺度 480×480 + 8 head ensemble。
    """

    def __init__(
        self,
        deploy_dir: Path,
        device: str = "auto",
        image_size: int = DEFAULT_IMAGE_SIZE,
        top_k: int = 5,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ) -> None:
        from transformers import AutoModel  # 延迟 import，避免无 species 模型时硬依赖

        self.deploy_dir = Path(deploy_dir)
        if not self.deploy_dir.exists():
            msg = f"Species deploy dir not found: {deploy_dir}"
            raise FileNotFoundError(msg)
        self.image_size = image_size
        self._top_k = top_k
        self._min_confidence = min_confidence

        # 设备 + dtype 自动选择
        self.device, self._dtype = self._select_device(device)

        # 1) Backbone（HF safetensors）
        backbone_dir = self.deploy_dir / "backbone"
        if not backbone_dir.exists():
            msg = f"Backbone dir not found: {backbone_dir}"
            raise FileNotFoundError(msg)
        # 注意：dtype 直接传给 from_pretrained，权重以 bf16/fp16/fp32 加载
        # bf16 在 MPS RoPE 上不会 NaN（fp16 会），CPU 用 fp32 兼容
        bb = AutoModel.from_pretrained(
            str(backbone_dir),
            dtype=self._dtype,
            attn_implementation="sdpa",
        )
        bb = bb.to(self.device).eval()
        for p in bb.parameters():
            p.requires_grad_(False)
        num_register_tokens = int(getattr(bb.config, "num_register_tokens", 0))
        self._feature = _DINOv3FeatureExtractor(bb, num_register_tokens).to(self.device).eval()

        # 2) 8 个 head ckpt，head 始终 fp32 保 softmax 精度
        heads_dir = self.deploy_dir / "heads"
        ckpt_files = sorted(heads_dir.glob("*.pt"))
        if not ckpt_files:
            msg = f"No head ckpts in {heads_dir}"
            raise FileNotFoundError(msg)
        self._heads: list[HeadOnlyClassifier] = []
        for ck in ckpt_files:
            h = HeadOnlyClassifier.from_ckpt(ck, map_location="cpu")
            h = h.to(self.device).eval()
            self._heads.append(h)

        # 3) Taxonomy + trained mask
        self._taxonomy = SpeciesTaxonomy(self.deploy_dir)
        self._trained_mask = self._taxonomy.trained_mask

        # Sanity check head 输出维度 == taxonomy 类数
        for h in self._heads:
            head_n = h.species_head.weight.shape[0]
            if head_n != len(self._taxonomy):
                msg = f"Head num_species={head_n} != taxonomy num_classes={len(self._taxonomy)}"
                raise ValueError(msg)

    @staticmethod
    def _select_device(device: str) -> tuple[str, torch.dtype]:
        """Auto-pick MPS (Mac), CUDA (NVIDIA), or CPU。GPU 用 bf16，CPU 用 fp32。"""
        if device == "auto":
            if torch.cuda.is_available():
                device = "cuda"
            elif torch.backends.mps.is_available():
                device = "mps"
            else:
                device = "cpu"
        if device in ("cuda", "mps"):
            return device, torch.bfloat16
        return device, torch.float32

    @torch.inference_mode()
    def classify(self, crop: NDArray[np.float32]) -> list[SpeciesCandidate]:
        """Classify a square-cropped bird image.

        Args:
            crop: [H, W, 3] float32 0-1 (RGB, square-expanded bbox crop)

        Returns:
            Top-K SpeciesCandidate (confidence 降序)。低于 min_confidence 过滤。

        ⚠ MPS 内存管理：
        Apple Silicon 上 MPS 用统一内存（= 系统 RAM）。PyTorch MPS allocator 会
        cache 已分配的临时张量供下次复用，**永不主动释放**。连续推理上千张照片
        且不调 empty_cache → 缓存可累积到几 GB（甚至一直涨到 swap 爆炸）。
        本函数每次调用结束都同步 + 清缓存，强制 RAM 归还系统。代价是每次推理
        多 ~5-10ms（同步），但能避免内存无界增长。
        """
        # 把所有中间 tensor 装一个本地 dict，方便 finally 统一删（异常路径也能跑）。
        # 之前直接 `del x, feat, probs_sum, probs_t` 在异常路径会 NameError 掩盖
        # 真实推理异常（OOM 等），导致用户看到的 traceback 不是根因。
        tensors: dict[str, object] = {}
        probs: NDArray[np.float32] | None = None
        try:
            # 1) preprocess to (1, 3, 480, 480)
            x = preprocess_for_dinov3(crop, self.image_size)
            x = x.to(self.device).to(self._dtype)
            tensors["x"] = x

            # 2) backbone → (1, 2048) feature; cast to fp32 before head
            feat = self._feature(x).float()
            tensors["feat"] = feat

            # 3) 8 head ensemble — softmax per head, average
            probs_sum: torch.Tensor | None = None
            for h in self._heads:
                logits = h(feat)
                p = F.softmax(logits, dim=1)
                probs_sum = p if probs_sum is None else probs_sum + p
            assert probs_sum is not None
            tensors["probs_sum"] = probs_sum
            probs_t = probs_sum / float(len(self._heads))
            tensors["probs_t"] = probs_t
            # cpu().numpy() 会数据拷贝出来，之后清 MPS 缓存就安全
            probs = probs_t[0].cpu().numpy()  # (num_classes,)
        finally:
            # 删本地 tensor 引用 → Python 标记可回收 → empty_cache 才能真释放 MPS buffer
            tensors.clear()
            if self.device == "mps":
                torch.mps.synchronize()
                torch.mps.empty_cache()
            elif self.device == "cuda":
                torch.cuda.synchronize()
                torch.cuda.empty_cache()

        if probs is None:
            return []  # 不可达（try 内若异常 finally 后会 raise，到不了这），保险

        # 4) zero out ghost classes
        probs[~self._trained_mask] = 0.0

        # 5) top-K + filter min_confidence
        k = min(self._top_k, probs.shape[0])
        top_idx = np.argsort(probs)[-k:][::-1]

        candidates: list[SpeciesCandidate] = []
        for idx in top_idx:
            conf = float(probs[int(idx)])
            if conf < self._min_confidence:
                continue
            sci = self._taxonomy.sci_at(int(idx))
            meta = self._taxonomy.lookup(sci) or {}
            candidates.append(
                SpeciesCandidate(
                    canonical_sci=sci,
                    canonical_zh=meta.get("canonical_zh"),
                    canonical_en=meta.get("canonical_en"),
                    family_sci=meta.get("family_sci"),
                    family_zh=meta.get("family_zh"),
                    order_sci=meta.get("order_sci"),
                    iucn=meta.get("iucn"),
                    protect_level=meta.get("protect_level"),
                    confidence=conf,
                )
            )
        return candidates

    @property
    def num_heads(self) -> int:
        return len(self._heads)

    @property
    def num_classes(self) -> int:
        return len(self._taxonomy)
