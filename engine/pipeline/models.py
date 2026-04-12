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


class BirdAnalysis(BaseModel):
    """Analysis result for a single detected bird."""

    bbox: BoundingBox
    quality: QualityScores
    grade: QualityGrade
    species: str | None = None  # 预留，物种分类模型就绪后填充


class PipelineResult(BaseModel):
    """Complete pipeline output for one photo."""

    photo_id: str
    detections: list[BirdAnalysis]
    best: BirdAnalysis | None  # 最高综合分的鸟
    bird_count: int
    pipeline_version: str
    duration_ms: float
