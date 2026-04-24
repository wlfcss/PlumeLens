"""Pydantic data models for pipeline input/output."""

from enum import StrEnum

from pydantic import BaseModel


class BoundingBox(BaseModel):
    """Bird detection bounding box."""

    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float
    class_id: int = 0


class QualityScores(BaseModel):
    """Dual-model IQA scores."""

    clipiqa: float
    hyperiqa: float
    combined: float  # weighted: 0.35 * clipiqa + 0.65 * hyperiqa


class QualityGrade(StrEnum):
    """4-tier quality grading."""

    REJECT = "reject"  # < 0.33
    RECORD = "record"  # 0.33 - 0.43
    USABLE = "usable"  # 0.43 - 0.60
    SELECT = "select"  # >= 0.60


class Keypoint(BaseModel):
    """Single 2D keypoint with confidence, in original image coordinates."""

    x: float
    y: float
    confidence: float


class PoseInfo(BaseModel):
    """Head/eye keypoints and derived visibility judgments.

    来源：bird_visibility v1.0（YOLO26l-pose 微调）

    关键点顺序固定为 `bill, crown, nape, left_eye, right_eye`。
    `flip_idx=[0,1,2,4,3]` 表示水平翻转时左右眼互换。
    """

    bill: Keypoint
    crown: Keypoint
    nape: Keypoint
    left_eye: Keypoint
    right_eye: Keypoint
    head_visible: bool
    eye_visible: bool


class SpeciesCandidate(BaseModel):
    """One entry in the Top-K species classification result.

    `confidence` 来自 ensemble softmax 平均后的概率。物种元数据查自
    `species_taxonomy.parquet`。
    """

    canonical_sci: str  # 拉丁学名（唯一 ID）
    canonical_zh: str | None = None  # 中文名
    canonical_en: str | None = None  # 英文名
    family_sci: str | None = None
    family_zh: str | None = None
    order_sci: str | None = None
    iucn: str | None = None  # LC / NT / VU / EN / CR / NR / DD
    protect_level: str | None = None  # "一级" / "二级" / None
    confidence: float


class BirdAnalysis(BaseModel):
    """Analysis result for a single detected bird."""

    bbox: BoundingBox
    quality: QualityScores
    grade: QualityGrade
    pose: PoseInfo | None = None  # 姿态模型未加载或失败时为 None
    species_candidates: list[SpeciesCandidate] = []
    # 向后兼容：仍保留 species 字段作为 top-1 的快捷访问；新代码应使用 species_candidates
    species: str | None = None


class PipelineResult(BaseModel):
    """Complete pipeline output for one photo."""

    photo_id: str
    detections: list[BirdAnalysis]
    best: BirdAnalysis | None  # 最高综合分的鸟
    bird_count: int
    pipeline_version: str
    duration_ms: float
