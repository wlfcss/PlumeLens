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

    REJECT = "reject"  # < 0.45
    RECORD = "record"  # 0.45 - 0.60
    USABLE = "usable"  # 0.60 - 0.75
    SELECT = "select"  # >= 0.75


class Keypoint(BaseModel):
    """Single 2D keypoint with confidence, in original image coordinates."""

    x: float
    y: float
    confidence: float


class PoseInfo(BaseModel):
    """Full-body keypoints + visibility + posture analysis.

    来源:bird_visibility v2.0(YOLO26l-pose,11 关键点)。

    关键点顺序固定:
        头部(5):bill, crown, nape, left_eye, right_eye
        躯干(6):belly, breast, back, tail, left_wing, right_wing

    flip_idx = [0, 1, 2, 4, 3, 5, 6, 7, 8, 10, 9](水平翻转时左右眼/翼互换)。

    新增 v2 字段(身/尾/翼可见 + 视角/朝向/姿态)默认值兼容老 cache:
    旧 v1 写入的 PipelineResult JSON 无此字段,Pydantic 反序列化时使用默认值。
    """

    # 头部 5 关键点
    bill: Keypoint
    crown: Keypoint
    nape: Keypoint
    left_eye: Keypoint
    right_eye: Keypoint
    # 躯干 6 关键点(v2 新增,默认占位 0,0,0 兼容旧 cache)
    belly: Keypoint = Keypoint(x=0.0, y=0.0, confidence=0.0)
    breast: Keypoint = Keypoint(x=0.0, y=0.0, confidence=0.0)
    back: Keypoint = Keypoint(x=0.0, y=0.0, confidence=0.0)
    tail: Keypoint = Keypoint(x=0.0, y=0.0, confidence=0.0)
    left_wing: Keypoint = Keypoint(x=0.0, y=0.0, confidence=0.0)
    right_wing: Keypoint = Keypoint(x=0.0, y=0.0, confidence=0.0)
    # 5 项可见性
    head_visible: bool
    eye_visible: bool
    body_visible: bool = False  # v2 新增
    tail_visible: bool = False  # v2 新增
    wings_visible: bool = False  # v2 新增
    # 3 项姿态(基于关键点几何派生)
    view_angle: str = "unknown"  # v2:frontal / side / back / unknown
    facing: str = "unknown"  # v2:left / right / unknown(仅 view=side 有效)
    posture: str = "unknown"  # v2:perched / flying / unknown


class SpeciesCandidate(BaseModel):
    """One entry in the Top-K species classification result.

    `confidence` 来自 species softmax 概率。v4 会附带 reject head 校准后的
    recognition_state；只有 recognized 能作为自动物种结论，uncertain 仅供复核参考。
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
    recognition_state: str | None = None  # recognized / uncertain；unrecognized 不返回候选
    reject_score: float | None = None
    top1_top2_margin: float | None = None


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
