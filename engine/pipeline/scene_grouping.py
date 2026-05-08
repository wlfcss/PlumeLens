# pyright: basic
"""场景分组 — AKAZE 特征匹配 + HSV/LAB 颜色直方图 + 时间戳。

算法移植自 lingjian-v2/engine/services/scene_grouping.py。

判定逻辑（每对相邻照片）：
  1. AKAZE 关键点 ≥0.25 比例 → 用特征匹配相似度（≥0.05 → 同场景）
  2. 否则回退到颜色相似度（HSV 直方图 0.75 + LAB 均值 0.25 → ≥0.82 → 同场景）

对一个 library 顺序遍历所有 photos：
  - 首张 photo 开 scene_id = 0
  - 后续每张：与前一张比较 → 相似 → 沿用 scene_id；不相似 → scene_id += 1

性能：用缩略图（preview 1920px 已生成）做相似度计算，避免重新解码原图（RAW 慢 + IO 大）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import cv2  # type: ignore[import]
import numpy as np
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

# 算法参数（沿用 lingjian-v2，已在大量真实鸟摄数据上验证过）
DEFAULT_MAX_DIM = 1600
DEFAULT_MAX_KEYPOINTS = 300
FEATURE_CONFIDENCE_MIN = 0.25  # 特征足够 → 用特征匹配；否则回退颜色
FEATURE_SIMILARITY_THRESHOLD = 0.05
COLOR_SIMILARITY_THRESHOLD = 0.82


@dataclass
class SimilarityResult:
    """两张图的相似度结果。"""

    feature_similarity: float = -1.0
    feature_confidence: float = -1.0
    color_similarity: float = -1.0
    color_confidence: float = -1.0
    similar: bool = False
    confidence: float = 0.0


def load_image_for_similarity(
    path: Path,
    max_dim: int = DEFAULT_MAX_DIM,
) -> NDArray[np.uint8] | None:
    """读取图片并缩到 max_dim 长边，BGR (cv2 默认）。

    用于场景相似度计算，**不**走 PIL/rawpy 全分辨率路径，因为我们传入的是
    已生成的 preview 缩略图（1920px JPEG）—— cv2.imread 能直接处理。
    """
    try:
        img = cast(NDArray[np.uint8] | None, cv2.imread(str(path), cv2.IMREAD_COLOR))
        if img is None:
            return None
        return _resize(img, max_dim)
    except Exception as e:
        logger.warning("load_image_for_similarity failed path=%s err=%s", path, e)
        return None


def compute_similarity(
    img1: NDArray[np.uint8],
    img2: NDArray[np.uint8],
    *,
    max_keypoints: int = DEFAULT_MAX_KEYPOINTS,
) -> SimilarityResult:
    """计算两张图的相似度。"""
    if img1 is None or img2 is None:
        return SimilarityResult()
    try:
        gray1 = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY) if img1.ndim == 3 else img1
        gray2 = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY) if img2.ndim == 3 else img2

        akaze = cast(Any, cv2).AKAZE_create()
        kp1, des1 = akaze.detectAndCompute(gray1, None)
        kp2, des2 = akaze.detectAndCompute(gray2, None)
        kp1, des1 = _limit_keypoints(kp1, des1, max_keypoints)
        kp2, des2 = _limit_keypoints(kp2, des2, max_keypoints)

        feature_conf = min(len(kp1), len(kp2)) / max_keypoints if kp1 and kp2 else 0.0

        # 特征不足 → 颜色相似度
        if feature_conf < FEATURE_CONFIDENCE_MIN or des1 is None or des2 is None:
            color_sim, color_conf = _color_similarity(img1, img2)
            return SimilarityResult(
                color_similarity=color_sim,
                color_confidence=color_conf,
                similar=color_sim >= COLOR_SIMILARITY_THRESHOLD,
                confidence=color_conf,
            )

        # AKAZE 特征匹配（Hamming + Lowe's ratio test）
        bf = cv2.BFMatcher(cv2.NORM_HAMMING)
        matches = bf.knnMatch(des1, des2, k=2)
        valid = [pair for pair in matches if len(pair) == 2]
        if not valid:
            color_sim, color_conf = _color_similarity(img1, img2)
            return SimilarityResult(
                color_similarity=color_sim,
                color_confidence=color_conf,
                similar=color_sim >= COLOR_SIMILARITY_THRESHOLD,
                confidence=color_conf,
            )

        m_arr = np.array([m.distance for m, n in valid])
        n_arr = np.array([n.distance for m, n in valid])
        # Lowe's ratio test 要求第二近邻距离 > 0;n_arr=0 时 m < 0.7*0 永真假,
        # 把这种 degenerate 配对从计数中剔除而非误算。
        ratio_mask = (n_arr > 0) & (m_arr < 0.7 * n_arr)
        good = int(np.sum(ratio_mask))
        # 用 min(len(kp1), len(kp2)) 做分母避免单边 keypoint 数量碾压另一边的不对称
        # (img1=100kp / img2=10kp 的 5/55=9.1% vs img1=10kp / img2=10kp 的 5/10=50%
        # 不应被同等惩罚)。匹配上限是 min,所以用 min 做归一更符合"匹配率"语义。
        denom = min(len(kp1), len(kp2))
        feat_sim = good / denom if denom > 0 else 0.0

        return SimilarityResult(
            feature_similarity=float(feat_sim),
            feature_confidence=float(feature_conf),
            similar=feat_sim >= FEATURE_SIMILARITY_THRESHOLD,
            confidence=float(feature_conf),
        )
    except Exception as e:
        logger.warning("compute_similarity exception err=%s", e)
        return SimilarityResult()


# --- 辅助函数 ---


def _resize(img: NDArray[np.uint8], max_dim: int) -> NDArray[np.uint8]:
    h, w = img.shape[:2]
    scale = max_dim / max(h, w)
    if scale < 1.0:
        return cast(
            NDArray[np.uint8],
            cv2.resize(
                img,
                (int(w * scale), int(h * scale)),
                interpolation=cv2.INTER_AREA,
            ),
        )
    return img


def _limit_keypoints(kp, des, max_kp: int):
    if des is not None and len(kp) > max_kp:
        pairs = sorted(
            zip(kp, des, strict=False),
            key=lambda x: x[0].response,
            reverse=True,
        )[:max_kp]
        kp_out, des_out = zip(*pairs, strict=False)
        return list(kp_out), np.array(des_out)
    return kp, des


def _clamp(v: float, lo: float, hi: float) -> float:
    return float(max(lo, min(hi, v)))


def _color_similarity(
    img1: NDArray[np.uint8],
    img2: NDArray[np.uint8],
) -> tuple[float, float]:
    """HSV 直方图 (0.75) + LAB 均值 (0.25) 的颜色相似度。"""
    target_w = 320
    a = cv2.resize(
        img1,
        (target_w, max(1, int(target_w * img1.shape[0] / max(img1.shape[1], 1)))),
        interpolation=cv2.INTER_AREA,
    )
    b = cv2.resize(
        img2,
        (target_w, max(1, int(target_w * img2.shape[0] / max(img2.shape[1], 1)))),
        interpolation=cv2.INTER_AREA,
    )

    hsv1 = cv2.cvtColor(a, cv2.COLOR_BGR2HSV)
    hsv2 = cv2.cvtColor(b, cv2.COLOR_BGR2HSV)

    hist1 = cv2.calcHist([hsv1], [0, 1, 2], None, [18, 16, 16], [0, 180, 0, 256, 0, 256])
    hist2 = cv2.calcHist([hsv2], [0, 1, 2], None, [18, 16, 16], [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist1, hist1, alpha=1.0, norm_type=cv2.NORM_L1)
    cv2.normalize(hist2, hist2, alpha=1.0, norm_type=cv2.NORM_L1)

    bhatta = float(cv2.compareHist(hist1, hist2, cv2.HISTCMP_BHATTACHARYYA))
    hist_sim = _clamp(1.0 - bhatta, 0.0, 1.0)

    lab1 = cv2.cvtColor(a, cv2.COLOR_BGR2LAB)
    lab2 = cv2.cvtColor(b, cv2.COLOR_BGR2LAB)
    delta = float(
        np.linalg.norm(
            np.mean(lab1.reshape(-1, 3), axis=0) - np.mean(lab2.reshape(-1, 3), axis=0),
        ),
    )
    mean_sim = _clamp(1.0 - delta / 130.0, 0.0, 1.0)

    sat_std = max(float(np.std(hsv1[:, :, 1])), float(np.std(hsv2[:, :, 1])))
    val_std = max(float(np.std(hsv1[:, :, 2])), float(np.std(hsv2[:, :, 2])))
    color_conf = _clamp((0.65 * sat_std + 0.35 * val_std) / 55.0, 0.25, 1.0)

    color_sim = 0.75 * hist_sim + 0.25 * mean_sim
    return float(color_sim), float(color_conf)
