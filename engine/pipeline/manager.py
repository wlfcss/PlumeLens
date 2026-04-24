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
from engine.pipeline.models import (
    BirdAnalysis,
    PipelineResult,
    QualityGrade,
    SpeciesCandidate,
)
from engine.pipeline.pose import PoseDetector
from engine.pipeline.preprocess import crop_bbox, load_image
from engine.pipeline.quality import QualityAssessor
from engine.pipeline.species import (
    SpeciesClassifier,
    SpeciesTaxonomy,
    expand_bbox_to_square,
)

logger = structlog.stdlib.get_logger()


_GRADE_ORDER: dict[str, int] = {
    "reject": 0,
    "record": 1,
    "usable": 2,
    "select": 3,
}


def resolve_providers(requested: str) -> list[str]:
    """Map config string to onnxruntime execution provider list."""
    import platform

    if requested == "cpu":
        return ["CPUExecutionProvider"]
    if requested == "coreml":
        return ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    if requested == "cuda":
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]

    if requested == "auto":
        if platform.system() == "Darwin" and platform.machine() == "arm64":
            return ["CoreMLExecutionProvider", "CPUExecutionProvider"]
        try:
            import onnxruntime as ort

            if "CUDAExecutionProvider" in ort.get_available_providers():
                return ["CUDAExecutionProvider", "CPUExecutionProvider"]
        except ImportError:
            pass
        return ["CPUExecutionProvider"]

    return ["CPUExecutionProvider"]


def _file_checksum(path: Path) -> str:
    """Compute SHA-256 of a file (first 64KB + size for speed)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read(65536))
        f.seek(0, 2)
        h.update(str(f.tell()).encode())
    return h.hexdigest()[:16]


class PipelineManager:
    """Central manager for the ONNX bird analysis pipeline.

    Created once at app startup, stored in app.state.pipeline.

    Module readiness is tracked separately:
    - Core (detector + quality assessor): required for is_ready = True
    - Enhancements (pose, species): optional, gracefully skipped if missing
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._detector: BirdDetector | None = None
        self._assessor: QualityAssessor | None = None
        self._pose: PoseDetector | None = None
        self._species: SpeciesClassifier | None = None
        self._pipeline_version: str = "unknown"
        self._model_status: dict[str, bool] = {
            "yolo": False,
            "bird_visibility": False,
            "clipiqa": False,
            "hyperiqa": False,
            "dinov3_backbone": False,
            "species_ensemble": False,
        }
        self._model_providers: dict[str, str] = {}

    async def initialize(self) -> None:
        """Load all ONNX models. Called once during FastAPI lifespan startup."""
        import onnxruntime as ort

        models_dir = self._settings.models_dir
        checksums: dict[str, str] = {}

        # ---- YOLO detector ----
        yolo_path = models_dir / "yolo26l-bird-det.onnx"
        if yolo_path.exists():
            providers = resolve_providers(self._settings.yolo_provider)
            await logger.ainfo("Loading YOLO detector", path=str(yolo_path))
            try:
                sess = ort.InferenceSession(str(yolo_path), providers=providers)
                self._detector = BirdDetector(
                    session=sess, input_size=self._settings.yolo_input_size
                )
                self._model_status["yolo"] = True
                active = sess.get_providers()
                self._model_providers["yolo"] = active[0] if active else "unknown"
                checksums["yolo"] = _file_checksum(yolo_path)
            except Exception:
                await logger.aexception("Failed to load YOLO detector")
        else:
            await logger.awarning("YOLO detector not found", path=str(yolo_path))

        # ---- bird_visibility (pose) ----
        pose_path = models_dir / "bird_visibility.onnx"
        if pose_path.exists():
            providers = resolve_providers(self._settings.pose_provider)
            await logger.ainfo("Loading pose detector", path=str(pose_path))
            try:
                sess = ort.InferenceSession(str(pose_path), providers=providers)
                self._pose = PoseDetector(
                    session=sess,
                    input_size=self._settings.pose_input_size,
                    box_threshold=self._settings.pose_box_threshold,
                    eye_threshold=self._settings.pose_eye_threshold,
                    head_threshold=self._settings.pose_head_threshold,
                    head_eye_threshold=self._settings.pose_head_eye_threshold,
                    expanded_box_margin=self._settings.pose_expanded_margin,
                )
                self._model_status["bird_visibility"] = True
                active = sess.get_providers()
                self._model_providers["bird_visibility"] = (
                    active[0] if active else "unknown"
                )
                checksums["bird_visibility"] = _file_checksum(pose_path)
            except Exception:
                await logger.aexception("Failed to load pose detector")
        else:
            await logger.awarning("Pose model not found", path=str(pose_path))

        # ---- CLIPIQA+ ----
        clipiqa_path = models_dir / "clipiqa_plus.onnx"
        clipiqa_session = None
        if clipiqa_path.exists():
            providers = resolve_providers(self._settings.iqa_provider)
            await logger.ainfo("Loading CLIPIQA+", path=str(clipiqa_path))
            try:
                clipiqa_session = ort.InferenceSession(
                    str(clipiqa_path), providers=providers
                )
                self._model_status["clipiqa"] = True
                active = clipiqa_session.get_providers()
                self._model_providers["clipiqa"] = active[0] if active else "unknown"
                checksums["clipiqa"] = _file_checksum(clipiqa_path)
            except Exception:
                await logger.aexception("Failed to load CLIPIQA+")
        else:
            await logger.awarning("CLIPIQA+ not found", path=str(clipiqa_path))

        # ---- HyperIQA ----
        hyperiqa_path = models_dir / "hyperiqa.onnx"
        hyperiqa_session = None
        if hyperiqa_path.exists():
            providers = resolve_providers(self._settings.iqa_provider)
            await logger.ainfo("Loading HyperIQA", path=str(hyperiqa_path))
            try:
                hyperiqa_session = ort.InferenceSession(
                    str(hyperiqa_path), providers=providers
                )
                self._model_status["hyperiqa"] = True
                active = hyperiqa_session.get_providers()
                self._model_providers["hyperiqa"] = active[0] if active else "unknown"
                checksums["hyperiqa"] = _file_checksum(hyperiqa_path)
            except Exception:
                await logger.aexception("Failed to load HyperIQA")
        else:
            await logger.awarning("HyperIQA not found", path=str(hyperiqa_path))

        if clipiqa_session is not None and hyperiqa_session is not None:
            self._assessor = QualityAssessor(
                clipiqa_session=clipiqa_session,
                hyperiqa_session=hyperiqa_session,
                clipiqa_weight=self._settings.clipiqa_weight,
                hyperiqa_weight=self._settings.hyperiqa_weight,
            )

        # ---- DINOv3 species classifier (optional, backbone 1.2GB 可能缺失) ----
        backbone_path = models_dir / "dinov3_backbone.onnx"
        ensemble_path = models_dir / "species_ensemble.onnx"
        taxonomy_path = models_dir / "species_taxonomy.parquet"
        if (
            backbone_path.exists()
            and ensemble_path.exists()
            and taxonomy_path.exists()
        ):
            providers = resolve_providers(self._settings.species_provider)
            await logger.ainfo(
                "Loading DINOv3 species classifier",
                backbone=str(backbone_path),
                ensemble=str(ensemble_path),
            )
            try:
                bb_sess = ort.InferenceSession(
                    str(backbone_path), providers=providers
                )
                en_sess = ort.InferenceSession(
                    str(ensemble_path), providers=providers
                )
                taxonomy = SpeciesTaxonomy(taxonomy_path)
                self._species = SpeciesClassifier(
                    backbone_session=bb_sess,
                    ensemble_session=en_sess,
                    taxonomy=taxonomy,
                    top_k=self._settings.species_top_k,
                    min_confidence=self._settings.species_min_confidence,
                )
                self._model_status["dinov3_backbone"] = True
                self._model_status["species_ensemble"] = True
                active_bb = bb_sess.get_providers()
                active_en = en_sess.get_providers()
                self._model_providers["dinov3_backbone"] = (
                    active_bb[0] if active_bb else "unknown"
                )
                self._model_providers["species_ensemble"] = (
                    active_en[0] if active_en else "unknown"
                )
                checksums["dinov3_backbone"] = _file_checksum(backbone_path)
                checksums["species_ensemble"] = _file_checksum(ensemble_path)
            except Exception:
                await logger.aexception("Failed to load species classifier")
        else:
            missing = [
                p.name
                for p in (backbone_path, ensemble_path, taxonomy_path)
                if not p.exists()
            ]
            await logger.awarning(
                "Species classifier disabled (files missing)", missing=missing
            )

        self._pipeline_version = self._compute_version(checksums)
        await logger.ainfo(
            "Pipeline initialized",
            ready=self.is_ready,
            pose_available=self._pose is not None,
            species_available=self._species is not None,
            version=self._pipeline_version,
            model_status=self._model_status,
        )

    def _compute_version(self, checksums: dict[str, str]) -> str:
        """Deterministic pipeline version from full input vector."""
        import onnxruntime as ort

        h = hashlib.sha256()
        # Model identity
        for key in sorted(checksums):
            h.update(f"{key}:{checksums[key]}".encode())
        # Scoring
        h.update(f"cw:{self._settings.clipiqa_weight}".encode())
        h.update(f"hw:{self._settings.hyperiqa_weight}".encode())
        h.update(f"gt:{self._settings.grade_thresholds}".encode())
        # Detection
        h.update(f"yc:{self._settings.yolo_confidence}".encode())
        h.update(f"ys:{self._settings.yolo_input_size}".encode())
        # Crop
        h.update(f"cr:{self._settings.crop_expand_ratio}".encode())
        h.update(f"cp:{self._settings.crop_padding_ratio}".encode())
        # Pose thresholds (5 项)
        h.update(f"pbt:{self._settings.pose_box_threshold}".encode())
        h.update(f"pet:{self._settings.pose_eye_threshold}".encode())
        h.update(f"pht:{self._settings.pose_head_threshold}".encode())
        h.update(f"phet:{self._settings.pose_head_eye_threshold}".encode())
        h.update(f"pem:{self._settings.pose_expanded_margin}".encode())
        h.update(f"pis:{self._settings.pose_input_size}".encode())
        # Species
        h.update(f"stk:{self._settings.species_top_k}".encode())
        h.update(f"smc:{self._settings.species_min_confidence}".encode())
        h.update(f"scm:{self._settings.species_crop_margin}".encode())
        h.update(f"scs:{self._settings.species_crop_min_side_frac}".encode())
        h.update(f"smg:{self._settings.species_min_grade}".encode())
        # Preprocess code version
        h.update(f"pp:{self._settings.preprocess_version}".encode())
        # Runtime environment
        h.update(f"ort:{ort.__version__}".encode())
        ep_str = ",".join(sorted(self._model_providers.values()))
        h.update(f"ep:{ep_str}".encode())
        return f"v1-{h.hexdigest()[:8]}"

    def close(self) -> None:
        """Release resources. Called during shutdown."""
        self._detector = None
        self._assessor = None
        self._pose = None
        self._species = None

    @property
    def pipeline_version(self) -> str:
        return self._pipeline_version

    @property
    def is_ready(self) -> bool:
        """True if core modules (detector + quality assessor) are loaded.

        Pose and species are considered enhancements — not required for is_ready.
        """
        return self._detector is not None and self._assessor is not None

    @property
    def pose_available(self) -> bool:
        return self._pose is not None

    @property
    def species_available(self) -> bool:
        return self._species is not None

    @property
    def model_status(self) -> dict[str, bool]:
        return dict(self._model_status)

    @property
    def model_providers(self) -> dict[str, str]:
        return dict(self._model_providers)

    async def analyze(self, image_path: Path, photo_id: str = "") -> PipelineResult:
        """Run full pipeline on an image.

        Core flow: detect → (pose per bbox) → quality assess → grade
        Enhancement: head+eye visible AND grade ≥ species_min_grade → species classify
        """
        if not self.is_ready:
            msg = "Pipeline not ready: core models not loaded"
            raise RuntimeError(msg)
        assert self._detector is not None
        assert self._assessor is not None

        start = time.perf_counter()
        result = await asyncio.to_thread(self._analyze_sync, image_path, photo_id)
        result.duration_ms = (time.perf_counter() - start) * 1000
        return result

    def _analyze_sync(self, image_path: Path, photo_id: str) -> PipelineResult:
        """Synchronous pipeline execution (runs in thread pool)."""
        assert self._detector is not None
        assert self._assessor is not None

        image = load_image(image_path)
        img_h, img_w = image.shape[:2]

        # Step 1: YOLO detection on full image
        boxes = self._detector.detect(
            image, confidence_threshold=self._settings.yolo_confidence
        )

        detections: list[BirdAnalysis] = []
        padding = self._settings.crop_padding_ratio

        for box in boxes:
            # Step 2: bbox crop with padding (for pose + IQA)
            bw = box.x2 - box.x1
            bh = box.y2 - box.y1
            px = bw * padding
            py = bh * padding
            pad_x1 = max(0.0, box.x1 - px)
            pad_y1 = max(0.0, box.y1 - py)
            pad_x2 = min(float(img_w), box.x2 + px)
            pad_y2 = min(float(img_h), box.y2 + py)

            crop = crop_bbox(
                image,
                x1=pad_x1,
                y1=pad_y1,
                x2=pad_x2,
                y2=pad_y2,
                expand_ratio=self._settings.crop_expand_ratio,
            )

            # Step 3a: pose detection (crop-mode)
            pose_info = None
            if self._pose is not None:
                try:
                    pose_info = self._pose.detect(
                        crop, crop_origin=(pad_x1, pad_y1)
                    )
                except Exception:
                    logger.exception("Pose detection failed", photo_id=photo_id)

            # Step 3b: quality assessment
            scores = self._assessor.assess(crop)
            bird_grade = grade(scores.combined, self._settings.grade_thresholds)

            # Step 4: species classification (gated)
            species_candidates: list[SpeciesCandidate] = []
            if self._should_run_species(pose_info, bird_grade):
                assert self._species is not None
                species_crop = self._prepare_species_crop(
                    image, box.x1, box.y1, box.x2, box.y2, img_w, img_h
                )
                try:
                    species_candidates = self._species.classify(species_crop)
                except Exception:
                    logger.exception(
                        "Species classification failed", photo_id=photo_id
                    )

            species_name = (
                species_candidates[0].canonical_zh
                or species_candidates[0].canonical_sci
                if species_candidates
                else None
            )

            detections.append(
                BirdAnalysis(
                    bbox=box,
                    quality=scores,
                    grade=bird_grade,
                    pose=pose_info,
                    species_candidates=species_candidates,
                    species=species_name,
                )
            )

        best = max(detections, key=lambda d: d.quality.combined) if detections else None

        return PipelineResult(
            photo_id=photo_id,
            detections=detections,
            best=best,
            bird_count=len(detections),
            pipeline_version=self._pipeline_version,
            duration_ms=0.0,
        )

    def _should_run_species(
        self,
        pose_info,  # PoseInfo | None
        bird_grade: QualityGrade,
    ) -> bool:
        """Decide whether to run species classifier on this bird.

        Criteria:
        - species model loaded
        - pose module available & head + eye both visible
        - grade ≥ species_min_grade
        """
        if self._species is None:
            return False
        if pose_info is None:
            return False
        if not (pose_info.head_visible and pose_info.eye_visible):
            return False
        min_grade_rank = _GRADE_ORDER.get(self._settings.species_min_grade, 0)
        current_rank = _GRADE_ORDER[bird_grade.value]
        return current_rank >= min_grade_rank

    def _prepare_species_crop(
        self,
        image,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        img_w: int,
        img_h: int,
    ):
        """Expand bbox to square (with 15% margin) and crop for DINOv3.

        Accepts bbox in pixel coords; converts to normalized for the helper.
        """
        # 中心与宽高（归一化）
        xc_norm = ((x1 + x2) / 2) / img_w
        yc_norm = ((y1 + y2) / 2) / img_h
        w_norm = (x2 - x1) / img_w
        h_norm = (y2 - y1) / img_h
        left, top, right, bottom = expand_bbox_to_square(
            xc_norm=xc_norm,
            yc_norm=yc_norm,
            w_norm=w_norm,
            h_norm=h_norm,
            image_w=img_w,
            image_h=img_h,
            margin=self._settings.species_crop_margin,
            min_side_frac=self._settings.species_crop_min_side_frac,
        )
        # Hard-clamp to image bounds (already done in helper, but safety)
        left = max(0, left)
        top = max(0, top)
        right = min(img_w, right)
        bottom = min(img_h, bottom)
        return image[top:bottom, left:right, :].copy()
