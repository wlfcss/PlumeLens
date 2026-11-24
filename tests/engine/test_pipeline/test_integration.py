"""Integration smoke tests with real ONNX + PyTorch models loaded.

Marked with ``@pytest.mark.integration`` so unit-only CI (`-m "not integration"`)
excludes it cleanly without bogus skips, while release/build CI executes it right
after restoring model weights.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
MODELS_DIR = REPO_ROOT / "engine" / "models"
BUNDLED_BIRD_ARTWORK = REPO_ROOT / "resources" / "species-artwork" / "Alcedo_atthis.webp"

CORE_MODELS = [
    "yolo26l-bird-det.onnx",
    "bird_visibility11.onnx",
    "bird_flight_classifier.onnx",
    "clipiqa_plus.onnx",
    "hyperiqa.onnx",
]


def _core_models_present() -> bool:
    return all((MODELS_DIR / m).exists() for m in CORE_MODELS)


pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not _core_models_present(),
        reason="Core ONNX models not present (engine/models/)",
    ),
]


class TestRealONNXLoad:
    """验证 ONNX 文件能被 onnxruntime 加载 + 推理（不 mock）。"""

    def test_yolo_detector_real_inference(self) -> None:
        import onnxruntime as ort
        from engine.pipeline.detector import BirdDetector

        sess = ort.InferenceSession(
            str(MODELS_DIR / "yolo26l-bird-det.onnx"),
            providers=["CPUExecutionProvider"],
        )
        detector = BirdDetector(sess, input_size=1280)

        rng = np.random.default_rng(0)
        image = rng.random((800, 600, 3), dtype=np.float32)
        boxes = detector.detect(image, confidence_threshold=0.5)
        assert isinstance(boxes, list)
        assert len(boxes) == 0

    def test_quality_assessor_real_inference(self) -> None:
        import onnxruntime as ort
        from engine.pipeline.quality import QualityAssessor

        clip = ort.InferenceSession(
            str(MODELS_DIR / "clipiqa_plus.onnx"),
            providers=["CPUExecutionProvider"],
        )
        hyper = ort.InferenceSession(
            str(MODELS_DIR / "hyperiqa.onnx"),
            providers=["CPUExecutionProvider"],
        )
        assessor = QualityAssessor(clip, hyper)

        rng = np.random.default_rng(1)
        crop = rng.random((300, 200, 3), dtype=np.float32)
        scores = assessor.assess(crop)

        assert 0.0 <= scores.clipiqa <= 1.0
        assert 0.0 <= scores.hyperiqa <= 1.0
        assert 0.0 <= scores.combined <= 1.0

    def test_pose_detector_real_inference(self) -> None:
        import onnxruntime as ort
        from engine.pipeline.pose import PoseDetector

        sess = ort.InferenceSession(
            str(MODELS_DIR / "bird_visibility11.onnx"),
            providers=["CPUExecutionProvider"],
        )
        detector = PoseDetector(sess, input_size=640)

        rng = np.random.default_rng(2)
        crop = rng.random((400, 300, 3), dtype=np.float32)
        result = detector.detect(crop)
        assert result is None or result.head_visible in (True, False)

    def test_flight_classifier_real_inference(self) -> None:
        import onnxruntime as ort
        from engine.pipeline.pose import FlightClassifier

        sess = ort.InferenceSession(
            str(MODELS_DIR / "bird_flight_classifier.onnx"),
            providers=["CPUExecutionProvider"],
        )
        classifier = FlightClassifier(sess, input_size=224, threshold=0.35)

        rng = np.random.default_rng(3)
        crop = rng.random((300, 200, 3), dtype=np.float32)
        result = classifier.classify(crop)
        assert result is not None
        posture, fly_prob, method = result
        assert posture in ("flying", "perched")
        assert 0.0 <= fly_prob <= 1.0
        assert method == "classifier"


class TestRealFullPipeline:
    """验证 PipelineManager 能加载全部 6 模型并对真实鸟图跑通完整检测/姿态/画质/物种链路。"""

    async def test_full_pipeline_initialize_and_analyze_real_bird(
        self,
        tmp_path: Path,
    ) -> None:
        if not (MODELS_DIR / "species" / "backbone" / "model.safetensors").exists():
            pytest.skip("DINOv3 species v4 backbone not present")
        if not (MODELS_DIR / "species" / "v4" / "seed42_adapter.pt").exists():
            pytest.skip("DINOv3 species v4 adapter not present")

        from engine.core.config import Settings
        from engine.pipeline.manager import PipelineManager

        settings = Settings(data_dir=tmp_path, models_dir=MODELS_DIR)
        pipeline = PipelineManager(settings)
        await pipeline.initialize()
        try:
            assert pipeline.is_ready
            assert pipeline.quality_available
            assert pipeline.pose_available
            assert pipeline.species_available
            status = pipeline.model_status
            for name in (
                "yolo",
                "bird_visibility",
                "bird_flight_classifier",
                "clipiqa",
                "hyperiqa",
                "dinov3_species_v4",
            ):
                assert status[name], f"{name} failed to load"

            img_path = tmp_path / "real_bird.jpg"
            if BUNDLED_BIRD_ARTWORK.is_file():
                with Image.open(BUNDLED_BIRD_ARTWORK) as src:
                    src.convert("RGB").save(img_path, "JPEG", quality=92)
            else:
                Image.new("RGB", (640, 480), (100, 120, 140)).save(img_path, "JPEG")

            result = await pipeline.analyze(img_path, photo_id="integration-real-bird")
            assert result.photo_id == "integration-real-bird"
            assert result.duration_ms > 0
            assert result.pipeline_version.startswith("v2-")
            assert pipeline.version_descriptor["schema"] == 2
            assert all(
                len(digest) == 64 for digest in pipeline.version_descriptor["assets"].values()
            )
            if BUNDLED_BIRD_ARTWORK.is_file():
                assert result.bird_count >= 1
                assert result.best is not None
                assert result.best.quality is not None
                assert result.best.pose is not None
                assert result.best.grade is not None
                assert result.best.species is not None or len(result.best.species_candidates) > 0
        finally:
            pipeline.close()
