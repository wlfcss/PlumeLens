"""ONNX-based bird detection and quality assessment pipeline."""

from engine.pipeline.manager import PipelineManager
from engine.pipeline.models import (
    BirdAnalysis,
    BoundingBox,
    PipelineResult,
    QualityGrade,
    QualityScores,
)

__all__ = [
    "BirdAnalysis",
    "BoundingBox",
    "PipelineManager",
    "PipelineResult",
    "QualityGrade",
    "QualityScores",
]
