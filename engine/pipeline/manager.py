# pyright: basic
"""Pipeline lifecycle management and orchestration."""

from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path

import structlog

from engine.core.config import Settings
from engine.pipeline.detector import BirdDetector
from engine.pipeline.grader import grade
from engine.pipeline.models import BirdAnalysis, PipelineResult
from engine.pipeline.preprocess import crop_bbox, load_image
from engine.pipeline.quality import QualityAssessor

logger = structlog.stdlib.get_logger()


def resolve_providers(requested: str) -> list[str]:
    """Map config string to onnxruntime execution provider list.

    Args:
        requested: One of "auto", "coreml", "cuda", "cpu".

    Returns:
        Ordered list of provider names for onnxruntime.InferenceSession.
    """
    import platform

    if requested == "cpu":
        return ["CPUExecutionProvider"]

    if requested == "coreml":
        return ["CoreMLExecutionProvider", "CPUExecutionProvider"]

    if requested == "cuda":
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]

    # "auto" — detect platform
    if requested == "auto":
        if platform.system() == "Darwin" and platform.machine() == "arm64":
            return ["CoreMLExecutionProvider", "CPUExecutionProvider"]

        # Try CUDA if available
        try:
            import onnxruntime as ort

            if "CUDAExecutionProvider" in ort.get_available_providers():
                return ["CUDAExecutionProvider", "CPUExecutionProvider"]
        except ImportError:
            pass

        return ["CPUExecutionProvider"]

    return ["CPUExecutionProvider"]


def _file_checksum(path: Path) -> str:
    """Compute SHA-256 of a file (first 64KB for speed)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        # Read first 64KB — sufficient for model identity without hashing 95MB
        h.update(f.read(65536))
        # Also include file size for extra safety
        f.seek(0, 2)
        h.update(str(f.tell()).encode())
    return h.hexdigest()[:16]


class PipelineManager:
    """Central manager for the ONNX bird analysis pipeline.

    Created once at app startup, stored in app.state.pipeline.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._detector: BirdDetector | None = None
        self._assessor: QualityAssessor | None = None
        self._pipeline_version: str = "unknown"
        self._model_status: dict[str, bool] = {
            "yolo": False,
            "clipiqa": False,
            "hyperiqa": False,
            "species": False,
        }
        self._model_providers: dict[str, str] = {}

    async def initialize(self) -> None:
        """Load all ONNX models. Called once during FastAPI lifespan startup."""
        import onnxruntime as ort

        models_dir = self._settings.models_dir
        checksums: dict[str, str] = {}

        # Load YOLO detector
        yolo_path = models_dir / "yolo26l-bird-det.onnx"
        if yolo_path.exists():
            yolo_providers = resolve_providers(self._settings.yolo_provider)
            await logger.ainfo(
                "Loading YOLO model",
                path=str(yolo_path),
                providers=yolo_providers,
            )
            try:
                yolo_session = ort.InferenceSession(str(yolo_path), providers=yolo_providers)
                self._detector = BirdDetector(
                    session=yolo_session,
                    input_size=self._settings.yolo_input_size,
                )
                self._model_status["yolo"] = True
                active = yolo_session.get_providers()
                self._model_providers["yolo"] = active[0] if active else "unknown"
                checksums["yolo"] = _file_checksum(yolo_path)
            except Exception:
                await logger.aexception("Failed to load YOLO model")
        else:
            await logger.awarning("YOLO model not found", path=str(yolo_path))

        # Load CLIPIQA+
        clipiqa_path = models_dir / "clipiqa_plus.onnx"
        clipiqa_session = None
        if clipiqa_path.exists():
            iqa_providers = resolve_providers(self._settings.iqa_provider)
            await logger.ainfo("Loading CLIPIQA+ model", path=str(clipiqa_path))
            try:
                clipiqa_session = ort.InferenceSession(str(clipiqa_path), providers=iqa_providers)
                self._model_status["clipiqa"] = True
                active = clipiqa_session.get_providers()
                self._model_providers["clipiqa"] = active[0] if active else "unknown"
                checksums["clipiqa"] = _file_checksum(clipiqa_path)
            except Exception:
                await logger.aexception("Failed to load CLIPIQA+ model")
        else:
            await logger.awarning("CLIPIQA+ model not found", path=str(clipiqa_path))

        # Load HyperIQA
        hyperiqa_path = models_dir / "hyperiqa.onnx"
        hyperiqa_session = None
        if hyperiqa_path.exists():
            iqa_providers = resolve_providers(self._settings.iqa_provider)
            await logger.ainfo("Loading HyperIQA model", path=str(hyperiqa_path))
            try:
                hyperiqa_session = ort.InferenceSession(str(hyperiqa_path), providers=iqa_providers)
                self._model_status["hyperiqa"] = True
                active = hyperiqa_session.get_providers()
                self._model_providers["hyperiqa"] = active[0] if active else "unknown"
                checksums["hyperiqa"] = _file_checksum(hyperiqa_path)
            except Exception:
                await logger.aexception("Failed to load HyperIQA model")
        else:
            await logger.awarning("HyperIQA model not found", path=str(hyperiqa_path))

        # Create QualityAssessor if both IQA models loaded
        if clipiqa_session is not None and hyperiqa_session is not None:
            self._assessor = QualityAssessor(
                clipiqa_session=clipiqa_session,
                hyperiqa_session=hyperiqa_session,
                clipiqa_weight=self._settings.clipiqa_weight,
                hyperiqa_weight=self._settings.hyperiqa_weight,
            )

        # Compute pipeline version
        self._pipeline_version = self._compute_version(checksums)
        await logger.ainfo(
            "Pipeline initialized",
            ready=self.is_ready,
            version=self._pipeline_version,
            model_status=self._model_status,
        )

    def _compute_version(self, checksums: dict[str, str]) -> str:
        """Compute deterministic pipeline version from model checksums + parameters."""
        h = hashlib.sha256()
        for key in sorted(checksums):
            h.update(f"{key}:{checksums[key]}".encode())
        # Include scoring parameters
        h.update(f"cw:{self._settings.clipiqa_weight}".encode())
        h.update(f"hw:{self._settings.hyperiqa_weight}".encode())
        h.update(f"gt:{self._settings.grade_thresholds}".encode())
        return f"v1-{h.hexdigest()[:8]}"

    def close(self) -> None:
        """Release resources. Called during shutdown."""
        self._detector = None
        self._assessor = None

    @property
    def pipeline_version(self) -> str:
        return self._pipeline_version

    @property
    def is_ready(self) -> bool:
        """True if all required models (YOLO + both IQA) are loaded."""
        return self._detector is not None and self._assessor is not None

    @property
    def model_status(self) -> dict[str, bool]:
        return dict(self._model_status)

    @property
    def model_providers(self) -> dict[str, str]:
        return dict(self._model_providers)

    async def analyze(self, image_path: Path, photo_id: str = "") -> PipelineResult:
        """Run full pipeline: detect → crop → score → grade.

        Args:
            image_path: Path to the image file.
            photo_id: Identifier for the photo (used in result).

        Returns:
            PipelineResult with all detections and the best bird.

        Raises:
            RuntimeError: If pipeline is not ready (models not loaded).
        """
        if not self.is_ready:
            msg = "Pipeline not ready: models not loaded"
            raise RuntimeError(msg)

        assert self._detector is not None
        assert self._assessor is not None

        start = time.perf_counter()

        # Run inference in thread pool to avoid blocking event loop
        result = await asyncio.to_thread(self._analyze_sync, image_path, photo_id)

        duration_ms = (time.perf_counter() - start) * 1000
        result.duration_ms = duration_ms
        return result

    def _analyze_sync(self, image_path: Path, photo_id: str) -> PipelineResult:
        """Synchronous pipeline execution (runs in thread pool)."""
        assert self._detector is not None
        assert self._assessor is not None

        image = load_image(image_path)

        # Step 1: Detect birds
        boxes = self._detector.detect(
            image,
            confidence_threshold=self._settings.yolo_confidence,
        )

        # Step 2: For each detection, crop and assess quality
        detections: list[BirdAnalysis] = []
        for box in boxes:
            crop = crop_bbox(
                image,
                x1=box.x1,
                y1=box.y1,
                x2=box.x2,
                y2=box.y2,
                expand_ratio=1.0,
            )

            scores = self._assessor.assess(crop)
            bird_grade = grade(scores.combined, self._settings.grade_thresholds)

            detections.append(
                BirdAnalysis(
                    bbox=box,
                    quality=scores,
                    grade=bird_grade,
                )
            )

        # Step 3: Select best bird (highest combined score)
        best = max(detections, key=lambda d: d.quality.combined) if detections else None

        return PipelineResult(
            photo_id=photo_id,
            detections=detections,
            best=best,
            bird_count=len(detections),
            pipeline_version=self._pipeline_version,
            duration_ms=0.0,  # Will be overwritten by async wrapper
        )
