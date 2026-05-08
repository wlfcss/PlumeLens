# pyright: basic
"""Bird species classification via DINOv3 ViT-L/16 + v4 LoRA/reject adapter.

v4 相比 v3 的核心变化：
- 输入从 480px 改为 384px，与重新训练的 v4 crop 口径一致。
- 不再使用 8 个 head ensemble；改为 seed42 主模型的 LoRA adapter。
- 增加 reject head，并通过校准策略输出 recognized / uncertain / unrecognized 三态。
- 物种表扩展到 1591 类；class_id 即模型输出下标，不再使用 v3 ghost-class mask。

模型路径：engine/models/species/
    backbone/
        config.json
        model.safetensors
    v4/
        seed42_adapter.pt
    canonical_extended.parquet
    v4_calibration_policy.json
"""

from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import torch
import torch.nn as nn
from numpy.typing import NDArray
from PIL import Image

from engine.pipeline.models import SpeciesCandidate

RecognitionState = Literal["recognized", "uncertain", "unrecognized"]

# ImageNet 标准化（与 DINOv3 训练一致）
IMAGENET_MEAN: tuple[float, float, float] = (0.485, 0.456, 0.406)
IMAGENET_STD: tuple[float, float, float] = (0.229, 0.224, 0.225)

# 单尺度 384×384 — v4 LoRA/reject 训练口径
DEFAULT_IMAGE_SIZE = 384

# Bbox margin 与 v4 训练/导出口径一致
BBOX_MARGIN = 0.15

# Top-K 展示下限；最终是否自动入物种结论由 v4 calibration policy 决定。
DEFAULT_MIN_CONFIDENCE: float = 0.01


@dataclass(frozen=True)
class SpeciesPolicy:
    """Calibrated reject/recognition policy from dino v4."""

    name: str
    hard_reject_score_min: float
    review_reject_score_min: float
    recognized_top1_prob_min: float
    recognized_margin_min: float

    @classmethod
    def from_path(cls, path: Path) -> SpeciesPolicy:
        data = json.loads(path.read_text(encoding="utf-8"))
        policy = data.get("recommended_policy") or data
        return cls(
            name=str(policy.get("name") or "balanced_v1"),
            hard_reject_score_min=float(policy["hard_reject_score_min"]),
            review_reject_score_min=float(policy["review_reject_score_min"]),
            recognized_top1_prob_min=float(policy["recognized_top1_prob_min"]),
            recognized_margin_min=float(policy["recognized_margin_min"]),
        )

    @classmethod
    def balanced_default(cls) -> SpeciesPolicy:
        return cls(
            name="balanced_v1",
            hard_reject_score_min=0.929440438747406,
            review_reject_score_min=0.665410578250885,
            recognized_top1_prob_min=0.333827064037323,
            recognized_margin_min=0.14405535399913788,
        )

    def decide(self, reject_score: float, top1_prob: float, margin: float) -> RecognitionState:
        """Map raw scores into the calibrated tri-state result."""
        if not all(math.isfinite(v) for v in (reject_score, top1_prob, margin)):
            return "unrecognized"
        if reject_score >= self.hard_reject_score_min:
            return "unrecognized"
        if (
            reject_score < self.review_reject_score_min
            and top1_prob >= self.recognized_top1_prob_min
            and margin >= self.recognized_margin_min
        ):
            return "recognized"
        return "uncertain"


def expand_bbox_to_square(
    xc_norm: float,
    yc_norm: float,
    w_norm: float,
    h_norm: float,
    image_w: int,
    image_h: int,
    margin: float = BBOX_MARGIN,
    min_side_frac: float = 0.0,
) -> tuple[int, int, int, int]:
    """YOLO bbox（归一化）→ v4 训练同口径的原图像素空间方形 crop。

    dino v4 使用 pixel bbox + 15% margin，再 Resize(384)+CenterCrop(384)。
    `min_side_frac` 仅保留为 legacy fallback；v4 默认配置为 0，不强制把小鸟裁切放大。
    """
    x1 = (xc_norm - w_norm / 2.0) * image_w
    x2 = (xc_norm + w_norm / 2.0) * image_w
    y1 = (yc_norm - h_norm / 2.0) * image_h
    y2 = (yc_norm + h_norm / 2.0) * image_h
    x1, x2 = sorted((max(0.0, x1), min(float(image_w), x2)))
    y1, y2 = sorted((max(0.0, y1), min(float(image_h), y2)))
    bw = max(2.0, x2 - x1)
    bh = max(2.0, y2 - y1)
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    side = max(bw, bh) * (1.0 + margin)
    if min_side_frac > 0:
        side = max(side, min_side_frac * min(image_w, image_h))
    side = min(side, float(max(image_w, image_h)))
    left = int(round(cx - side / 2.0))
    top = int(round(cy - side / 2.0))
    right = int(round(cx + side / 2.0))
    bottom = int(round(cy + side / 2.0))
    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > image_w:
        left -= right - image_w
        right = image_w
    if bottom > image_h:
        top -= bottom - image_h
        bottom = image_h
    left = max(0, left)
    top = max(0, top)
    right = min(image_w, right)
    bottom = min(image_h, bottom)
    if right - left < 16 or bottom - top < 16:
        return 0, 0, image_w, image_h
    return left, top, right, bottom


def preprocess_for_dinov3(
    image: NDArray[np.float32], size: int = DEFAULT_IMAGE_SIZE
) -> torch.Tensor:
    """Resize(short edge=size) + CenterCrop(size) + ImageNet norm → [1,3,size,size]."""
    image = np.clip(image, 0.0, 1.0)
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
    return torch.from_numpy(chw).unsqueeze(0)


class LoRALinear(nn.Module):
    """LoRA wrapper matching dino/scripts/stage10_v4_train_lora_reject.py."""

    def __init__(
        self,
        base: nn.Linear,
        r: int = 8,
        alpha: float = 16.0,
        dropout: float = 0.05,
    ) -> None:
        super().__init__()
        self.base = base
        for param in self.base.parameters():
            param.requires_grad_(False)
        self.scaling = alpha / r
        self.lora_A = nn.Linear(base.in_features, r, bias=False)
        self.lora_B = nn.Linear(r, base.out_features, bias=False)
        nn.init.kaiming_uniform_(self.lora_A.weight, a=math.sqrt(5))
        nn.init.zeros_(self.lora_B.weight)
        self.dropout = nn.Dropout(dropout) if dropout else nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.base(x) + self.lora_B(self.lora_A(self.dropout(x))) * self.scaling


def apply_lora(backbone: nn.Module, r: int = 8, alpha: float = 16.0, dropout: float = 0.05) -> int:
    """Wrap q_proj/v_proj in each DINOv3 attention block."""
    for param in backbone.parameters():
        param.requires_grad_(False)
    wrapped = 0
    for name, module in backbone.named_modules():
        if not name.endswith(".attention"):
            continue
        for proj_name in ("q_proj", "v_proj"):
            base = getattr(module, proj_name, None)
            if isinstance(base, nn.Linear):
                setattr(module, proj_name, LoRALinear(base, r=r, alpha=alpha, dropout=dropout))
                wrapped += 1
    return wrapped


class DINOv3LoRAReject(nn.Module):
    """DINOv3 ViT-L/16 feature extractor + species head + reject head."""

    def __init__(
        self,
        backbone_path: Path,
        num_classes: int,
        drop_path_rate: float = 0.0,
        reject_detach_features: bool = True,
    ) -> None:
        super().__init__()
        from transformers import AutoConfig, AutoModel

        config = AutoConfig.from_pretrained(str(backbone_path))
        config.drop_path_rate = drop_path_rate
        self.backbone = AutoModel.from_pretrained(
            str(backbone_path),
            config=config,
            attn_implementation="sdpa",
        )
        self.R = int(getattr(self.backbone.config, "num_register_tokens", 4))
        self.lora_modules = apply_lora(self.backbone, r=8, alpha=16.0, dropout=0.05)
        hidden = int(self.backbone.config.hidden_size)
        feat_dim = hidden * 2
        self.species_head = nn.Sequential(
            nn.LayerNorm(feat_dim),
            nn.Dropout(0.1),
            nn.Linear(feat_dim, 2048),
            nn.GELU(),
            nn.Dropout(0.2),
            nn.Linear(2048, num_classes),
        )
        self.reject_head = nn.Sequential(
            nn.LayerNorm(feat_dim),
            nn.Dropout(0.1),
            nn.Linear(feat_dim, 1),
        )
        self.reject_detach_features = reject_detach_features

    def forward_features(self, pixel_values: torch.Tensor) -> torch.Tensor:
        out = self.backbone(pixel_values=pixel_values)
        last = out.last_hidden_state
        cls = last[:, 0, :]
        patch = last[:, 1 + self.R :, :].mean(dim=1)
        return torch.cat([cls, patch], dim=-1)

    def forward(self, pixel_values: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        feat = self.forward_features(pixel_values)
        species_logits = self.species_head(feat)
        reject_feat = feat.detach() if self.reject_detach_features else feat
        reject_logits = self.reject_head(reject_feat).squeeze(1)
        return species_logits, reject_logits


def _apply_ema_shadow(model: nn.Module, shadow: dict[str, torch.Tensor] | None) -> None:
    if not shadow:
        return
    with torch.no_grad():
        for name, param in model.named_parameters():
            if name in shadow:
                param.copy_(shadow[name].to(device=param.device, dtype=param.dtype))


def _adapter_key(name: str) -> bool:
    return "lora_" in name or name.startswith("species_head.") or name.startswith("reject_head.")


class SpeciesTaxonomy:
    """Load v4 taxonomy metadata in model-output order."""

    def __init__(self, deploy_dir: Path) -> None:
        import pyarrow.parquet as pq

        canonical_path = deploy_dir / "canonical_extended.parquet"
        canonical_table = [r for r in pq.read_table(str(canonical_path)).to_pylist()]
        if not canonical_table:
            msg = f"Empty species taxonomy: {canonical_path}"
            raise ValueError(msg)

        if "class_id" in canonical_table[0]:
            canonical_table.sort(key=lambda r: int(r["class_id"]))
            for expected, row in enumerate(canonical_table):
                if int(row["class_id"]) != expected:
                    msg = f"Non-contiguous species class_id at {expected}: {row}"
                    raise ValueError(msg)
        elif "model_output_id" in canonical_table[0]:
            canonical_table.sort(key=lambda r: int(r["model_output_id"]))
        else:
            canonical_table.sort(key=lambda r: r["canonical_sci"])

        self._rows: list[dict[str, Any]] = canonical_table
        self._sci_to_row: dict[str, dict[str, Any]] = {
            str(r["canonical_sci"]): r for r in canonical_table
        }
        self.num_classes = len(canonical_table)

        # v4 的 1591 类全部是训练类；仅在 legacy taxonomy 没有 class_id 时兼容 v3 mask。
        self.trained_mask: NDArray[np.bool_] = np.ones(self.num_classes, dtype=bool)
        legacy_mask = deploy_dir / "species_list_1301.parquet"
        if "class_id" not in canonical_table[0] and legacy_mask.exists():
            trained_table = pq.read_table(str(legacy_mask)).to_pylist()
            trained_ids: set[int] = {int(r["model_output_id"]) for r in trained_table}
            mask = np.zeros(self.num_classes, dtype=bool)
            for idx in trained_ids:
                if 0 <= idx < self.num_classes:
                    mask[idx] = True
            self.trained_mask = mask

    def __len__(self) -> int:
        return self.num_classes

    def sci_at(self, index: int) -> str:
        return str(self._rows[index]["canonical_sci"])

    def lookup(self, sci: str) -> dict[str, Any] | None:
        return self._sci_to_row.get(sci)


class SpeciesClassifier:
    """End-to-end DINOv3 species classifier with v4 calibrated tri-state output."""

    def __init__(
        self,
        deploy_dir: Path,
        device: str = "auto",
        image_size: int = DEFAULT_IMAGE_SIZE,
        top_k: int = 5,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ) -> None:
        self.deploy_dir = Path(deploy_dir)
        if not self.deploy_dir.exists():
            msg = f"Species deploy dir not found: {deploy_dir}"
            raise FileNotFoundError(msg)

        self.image_size = image_size
        self._top_k = top_k
        self._min_confidence = min_confidence
        self.device, self._dtype = self._select_device(device)
        self._infer_lock = threading.Lock()

        self._taxonomy = SpeciesTaxonomy(self.deploy_dir)
        self._trained_mask = self._taxonomy.trained_mask

        policy_path = self.deploy_dir / "v4_calibration_policy.json"
        self._policy = (
            SpeciesPolicy.from_path(policy_path)
            if policy_path.exists()
            else SpeciesPolicy.balanced_default()
        )

        backbone_dir = self.deploy_dir / "backbone"
        adapter_path = self.deploy_dir / "v4" / "seed42_adapter.pt"
        if not backbone_dir.exists():
            msg = f"Backbone dir not found: {backbone_dir}"
            raise FileNotFoundError(msg)
        if not adapter_path.exists():
            msg = f"DINOv3 v4 adapter not found: {adapter_path}"
            raise FileNotFoundError(msg)

        ckpt = torch.load(str(adapter_path), map_location="cpu", weights_only=False)
        model_args = ckpt.get("args") or {}
        trained_input_size = int(model_args.get("input_size") or self.image_size)
        if trained_input_size != self.image_size:
            msg = (
                f"DINOv3 species v4 input_size mismatch: adapter={trained_input_size}, "
                f"runtime={self.image_size}"
            )
            raise ValueError(msg)
        self._model = DINOv3LoRAReject(
            backbone_dir,
            num_classes=len(self._taxonomy),
            drop_path_rate=float(model_args.get("drop_path_rate", 0.0) or 0.0),
            reject_detach_features=bool(model_args.get("reject_detach_features", True)),
        )

        state = ckpt.get("model_state")
        if not isinstance(state, dict):
            msg = f"Invalid v4 adapter checkpoint: {adapter_path}"
            raise ValueError(msg)
        missing, unexpected = self._model.load_state_dict(state, strict=False)
        missing_adapter = [k for k in missing if _adapter_key(k)]
        if missing_adapter or unexpected:
            msg = (
                f"Invalid v4 adapter state: missing_adapter={missing_adapter[:5]}, "
                f"unexpected={unexpected[:5]}"
            )
            raise ValueError(msg)
        _apply_ema_shadow(self._model, ckpt.get("ema_shadow"))

        # Backbone + LoRA 用 bf16 on MPS/CUDA；heads 保持 fp32 保证 softmax/reject 数值稳定。
        self._model.backbone.to(device=self.device, dtype=self._dtype).eval()
        self._model.species_head.to(device=self.device, dtype=torch.float32).eval()
        self._model.reject_head.to(device=self.device, dtype=torch.float32).eval()
        self._model.eval()
        for param in self._model.parameters():
            param.requires_grad_(False)

        species_out = self._model.species_head[-1]
        if not isinstance(species_out, nn.Linear):
            msg = f"Unexpected species head tail: {type(species_out).__name__}"
            raise ValueError(msg)
        if species_out.weight.shape[0] != len(self._taxonomy):
            msg = (
                f"Species head num_classes={species_out.weight.shape[0]} "
                f"!= taxonomy num_classes={len(self._taxonomy)}"
            )
            raise ValueError(msg)

    @staticmethod
    def _select_device(device: str) -> tuple[str, torch.dtype]:
        """Auto-pick MPS (Mac), CUDA (NVIDIA), or CPU. GPU uses bf16; CPU uses fp32."""
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

        Returns:
            recognized: Top-K candidates with recognition_state="recognized".
            uncertain: Top-K candidates are kept for review, but downstream treats them as
                model_unconfirmed and excludes them from archive effective species.
            unrecognized: [].
        """
        tensors: dict[str, object] = {}
        probs: NDArray[np.float32] | None = None
        reject_score: float | None = None
        with self._infer_lock:
            try:
                x = preprocess_for_dinov3(crop, self.image_size)
                x = x.to(self.device).to(self._dtype)
                tensors["x"] = x

                feat = self._model.forward_features(x).float()
                tensors["feat"] = feat
                species_logits = self._model.species_head(feat)
                reject_feat = feat.detach() if self._model.reject_detach_features else feat
                reject_logits = self._model.reject_head(reject_feat).squeeze(1)
                tensors["species_logits"] = species_logits
                tensors["reject_logits"] = reject_logits

                probs_t = torch.softmax(species_logits.float(), dim=1)
                tensors["probs_t"] = probs_t
                probs = probs_t[0].cpu().numpy()
                reject_score = float(torch.sigmoid(reject_logits.float())[0].cpu().item())
            finally:
                tensors.clear()
                if self.device == "mps":
                    torch.mps.synchronize()
                    torch.mps.empty_cache()
                elif self.device == "cuda":
                    torch.cuda.synchronize()
                    torch.cuda.empty_cache()

        if probs is None or reject_score is None or not np.isfinite(probs).all():
            return []

        probs[~self._trained_mask] = 0.0
        k = min(self._top_k, probs.shape[0])
        top_idx = np.argsort(probs)[-k:][::-1]
        if top_idx.size == 0:
            return []

        top1_prob = float(probs[int(top_idx[0])])
        top2_prob = float(probs[int(top_idx[1])]) if top_idx.size > 1 else 0.0
        margin = top1_prob - top2_prob
        state = self._policy.decide(reject_score, top1_prob, margin)
        if state == "unrecognized":
            return []

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
                    recognition_state=state,
                    reject_score=reject_score,
                    top1_top2_margin=margin,
                )
            )
        return candidates

    @property
    def num_heads(self) -> int:
        return 1

    @property
    def num_classes(self) -> int:
        return len(self._taxonomy)

    @property
    def policy_name(self) -> str:
        return self._policy.name
