"""Integration smoke tests with real ONNX models loaded.

这类测试在 CI 里会慢一些（加载全部 ONNX 约 1-2s），但是捕获 mocked 测试永远
发现不了的问题（历史上 CLIPIQA/HyperIQA 的 external_data 坏掉半年没被发现）。

跳过条件：若 engine/models/ 缺任何核心文件（CI 里可能未同步 DINOv3 backbone），
测试自动 skip 不 fail。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

MODELS_DIR = Path(__file__).resolve().parents[3] / "engine" / "models"

CORE_MODELS = [
    "yolo26l-bird-det.onnx",
    "bird_visibility.onnx",
    "clipiqa_plus.onnx",
    "hyperiqa.onnx",
]


def _core_models_present() -> bool:
    return all((MODELS_DIR / m).exists() for m in CORE_MODELS)


pytestmark = pytest.mark.skipif(
    not _core_models_present(),
    reason="Core ONNX models not present (engine/models/)",
)


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

        # 随机噪声图不会有鸟检测到
        image = np.random.rand(800, 600, 3).astype(np.float32)
        boxes = detector.detect(image, confidence_threshold=0.5)
        assert isinstance(boxes, list)
        # 随机图应该没鸟（conf < 0.5）
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

        # 随便造一张 300x200 的图（assessor 内部会 resize 到 224x224）
        crop = np.random.rand(300, 200, 3).astype(np.float32)
        scores = assessor.assess(crop)

        assert 0.0 <= scores.clipiqa <= 1.0
        assert 0.0 <= scores.hyperiqa <= 1.0
        assert 0.0 <= scores.combined <= 1.0

    def test_pose_detector_real_inference(self) -> None:
        import onnxruntime as ort

        from engine.pipeline.pose import PoseDetector

        sess = ort.InferenceSession(
            str(MODELS_DIR / "bird_visibility.onnx"),
            providers=["CPUExecutionProvider"],
        )
        detector = PoseDetector(sess, input_size=640)

        crop = np.random.rand(400, 300, 3).astype(np.float32)
        result = detector.detect(crop)
        # Random noise → no strong bird detection, 随机数据可能返回 None
        assert result is None or result.head_visible in (True, False)


class TestRealFullPipeline:
    """验证 PipelineManager 能从磁盘加载全部 6 模型 + 端到端跑通一张图。"""

    @pytest.mark.asyncio
    async def test_full_pipeline_initialize_and_analyze(
        self, tmp_path: Path,
    ) -> None:
        # DINOv3 backbone 体积大，若缺失则跳过
        if not (MODELS_DIR / "dinov3_backbone.onnx").exists():
            pytest.skip("DINOv3 backbone not present")

        from engine.core.config import Settings
        from engine.pipeline.manager import PipelineManager

        settings = Settings(
            data_dir=tmp_path,
            models_dir=MODELS_DIR,
            yolo_provider="cpu",
            pose_provider="cpu",
            iqa_provider="cpu",
            species_provider="cpu",
        )
        pipeline = PipelineManager(settings)
        await pipeline.initialize()

        # 所有 6 模型必须加载成功（这正是之前 CLIPIQA/HyperIQA 偷偷失败的场景）
        assert pipeline.is_ready
        assert pipeline.quality_available
        assert pipeline.pose_available
        assert pipeline.species_available
        status = pipeline.model_status
        for name in ("yolo", "bird_visibility", "clipiqa", "hyperiqa",
                     "dinov3_backbone", "species_ensemble"):
            assert status[name], f"{name} failed to load"

        # 端到端推理
        img = Image.new("RGB", (640, 480), (100, 120, 140))
        img_path = tmp_path / "smoke.jpg"
        img.save(img_path)

        result = await pipeline.analyze(img_path, photo_id="integration-smoke")
        assert result.photo_id == "integration-smoke"
        assert result.duration_ms > 0
        assert result.pipeline_version.startswith("v1-")

        pipeline.close()
