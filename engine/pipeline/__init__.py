"""ONNX-based bird detection and quality assessment pipeline."""

from engine.pipeline.manager import PipelineManager
from engine.pipeline.models import (
    BirdAnalysis,
    BoundingBox,
    Keypoint,
    PipelineResult,
    PoseInfo,
    QualityGrade,
    QualityScores,
    SpeciesCandidate,
)

__all__ = [
    "BirdAnalysis",
    "BoundingBox",
    "Keypoint",
    "PipelineManager",
    "PipelineResult",
    "PoseInfo",
    "QualityGrade",
    "QualityScores",
    "SpeciesCandidate",
]
