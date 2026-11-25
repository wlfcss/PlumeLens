# pyright: basic
"""Pipeline lifecycle management and orchestration."""

from __future__ import annotations

import copy
import hashlib
import json
import threading
import time
from importlib import import_module
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any

import structlog

from engine.core.config import Settings
from engine.core.manifest import verify_manifest
from engine.pipeline.detector import BirdDetector
from engine.pipeline.grader import apply_pose_adjustment, grade
from engine.pipeline.models import (
    BirdAnalysis,
    PipelineResult,
    QualityGrade,
    SpeciesCandidate,
)
from engine.pipeline.pose import (
    FLIGHT_CLASSIFIER_VERSION,
    POSTURE_HEURISTIC_VERSION,
    FlightClassifier,
    PoseDetector,
)
from engine.pipeline.preprocess import crop_bbox, expand_for_iqa, load_image_u8
from engine.pipeline.quality import IQA_NONFINITE_FALLBACK_SCORE, QualityAssessor
from engine.pipeline.runtime import (
    create_session,
    prune_stale_coreml_caches,
    resolve_providers,
)
from engine.pipeline.species import (
    BBOX_MARGIN,
    DEFAULT_IMAGE_SIZE,
    IMAGENET_MEAN,
    IMAGENET_STD,
    SpeciesClassifier,
    expand_bbox_to_square,
)

logger = structlog.stdlib.get_logger()


_GRADE_ORDER: dict[str, int] = {
    "reject": 0,
    "record": 1,
    "usable": 2,
    "select": 3,
}


# CoreML EP 默认计算单元配置：CPUAndGPU（关 ANE）。
#
# 实测（2026-04-27）：
#   YOLO26-bird 5Y3A7448.JPG 8K Canon：
#   - 默认 ALL（含 ANE）：bbox 错位 700+ px（letterbox x1=-80 越界），87 ms
#   - **CPUAndGPU（Metal GPU + CPU 兜底，关 ANE）**：与 CPU EP bbox 完全一致到
#     0.1 px，112 ms（vs CPU 395 ms，3.5× 加速）
#
# 根因：YOLO26 NMS-free head 的 advanced indexing 算子（GatherElements 等）在
# Apple Neural Engine 上有精度 bug；Metal GPU 实现是对的。
#
# pose（bird_visibility）也是 YOLO26 架构（YOLO26l-pose），同样的 head 实现，
# 同样的 ANE 风险（官方 INTEGRATION_GUIDE §14.2 实测 worst Box IoU 0.495 +
# KP drift 8.13 px P95）。虽然 PlumeLens crop 场景下大多数图 ANE 表现还行
# （我实测 5Y3A7448 crop KP drift < 0.6 px），但为绕开边角 case 风险，pose 也
# 强制 CPUAndGPU。代价：单图 +18 ms（20→38 ms）；收益：永远不踩 ANE 精度坑。
#
# IQA（CLIPIQA+ / HyperIQA）是不同架构（CLIP / HyperNet），无 advanced indexing，
# ANE 安全（实测与 CPU diff < 0.2 px），不需要此选项。
_COREML_NO_ANE: str = "CPUAndGPU"
# CoreML 5+ MLProgram 格式（macOS 14+ 基线原生支持）：
#   - 将 YOLO / Pose CoreML 分区从 11 段压减至 3 段（596/605 与 630/640 节点），
#     TopK / GatherElements 后处理自动留 CPU（仅 0.27 ms），兼得 2.4-5.5× 提速与 0 漂移。
#   - 配合持久化 ModelCacheDirectory，二次启动跳过重编译，6 模型初始化从 ~4.5s 降至 ~1.5s。
_COREML_MODEL_FORMAT: str = "MLProgram"


def _file_checksum(path: Path) -> str:
    """Complete streaming SHA-256; model tails are part of inference identity."""
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class PipelineManager:
    """Central manager for the hybrid bird analysis pipeline.

    Created once at app startup, stored in app.state.pipeline.

    Module readiness is tracked separately:
    - Core (detector + quality assessor): required for is_ready = True
    - Enhancements (pose, species): optional, gracefully skipped if missing
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        # One limit shared by every library: opening several libraries must not
        # multiply the number of simultaneously decoded 45 MP RAW images.
        from engine.core.windows_resources import MemoryBoundLimiter

        self._analysis_slots = MemoryBoundLimiter(settings.analysis_concurrency)
        self.resource_profile: dict[str, object] = {}
        self._detector: BirdDetector | None = None
        # YOLO CPU fallback：CoreML/AMD EP 偶发越界或内核异常（~3% 输入触发）。
        # 首次异常时懒加载省 ~300 MB 常驻内存；记录 armed 路径以保持 pipeline_version 稳定。
        self._detector_cpu_fallback: BirdDetector | None = None
        self._detector_cpu_fallback_path: Path | None = None
        self._detector_cpu_fallback_lock = threading.Lock()
        self._assessor: QualityAssessor | None = None
        self._pose: PoseDetector | None = None
        self._flight_classifier: FlightClassifier | None = None
        self._species: SpeciesClassifier | None = None
        self._pipeline_version: str = "unknown"
        self._model_status: dict[str, bool] = {
            "yolo": False,
            "bird_visibility": False,
            "bird_flight_classifier": False,
            "clipiqa": False,
            "hyperiqa": False,
            "dinov3_species_v4": False,
        }
        self._model_providers: dict[str, str] = {}
        self._provider_details: dict[str, dict] = {}
        self._version_descriptor: dict = {}

    async def initialize(self) -> None:
        """Load ONNX models and torch species assets during FastAPI startup."""

        models_dir = self._settings.models_dir
        try:
            import cv2

            # Prevent OpenCV from spawning a full-core thread pool alongside ONNX/Torch/asyncio.
            cv2.setNumThreads(1)
        except Exception:
            pass

        # 供应链整完整性闸门 — 在加载任何模型前先核对 manifest.json 的 SHA-256。
        # species/v4/seed42_adapter.pt 走 torch.load(weights_only=False) 反序列
        # 化 pickle,如果攻击者替换该文件可任意执行代码;ONNX/safetensors 替换会
        # 让推理结果被悄悄改写。manifest 不一致直接抛 ManifestError 拒绝启动。
        verified = verify_manifest(models_dir)
        await logger.ainfo(
            "Model manifest verified",
            entries=len(verified),
            models_dir=str(models_dir),
        )

        checksums: dict[str, str] = {}

        def checksum_for(path: Path) -> str:
            # Integrity verification already streamed the large model weights.
            digest = verified.get(path.relative_to(models_dir).as_posix())
            return digest if digest is not None else _file_checksum(path)

        import onnxruntime as ort

        coreml_cache_root = self._settings.data_dir / "cache" / "coreml"
        coreml_active_dirname = f"ort-{ort.__version__}"
        coreml_cache_dir = str(coreml_cache_root / coreml_active_dirname)

        # ---- YOLO detector ----
        yolo_path = models_dir / "yolo26l-bird-det.onnx"
        if yolo_path.exists():
            # YOLO 必须给 CoreML EP 传 MLComputeUnits=CPUAndGPU 关 ANE，
            # 否则 advanced indexing 在 ANE 上精度 bug 会出 letterbox 越界 bbox。
            # YOLO 与 pose 同架构族都走 CPUAndGPU；IQA 图无 advanced indexing，保留默认 CoreML。
            providers = resolve_providers(
                self._settings.yolo_provider,
                coreml_compute_units=_COREML_NO_ANE,
                coreml_model_format=_COREML_MODEL_FORMAT,
                coreml_cache_dir=coreml_cache_dir,
            )
            # The shipped 1280px detector is slower with DirectML graph
            # partitioning on RX 7900 XTX. Keep auto detection on CPU; the
            # pose/flight/IQA models still use DirectML, and users can force
            # directml explicitly when benchmarking a different model/GPU.
            if self._settings.yolo_provider == "auto" and providers[0] == "DmlExecutionProvider":
                from engine.pipeline.windows_gpu import verified_model

                providers = (
                    ["AMDGPUExecutionProvider", "CPUExecutionProvider"]
                    if verified_model(str(yolo_path))
                    else ["CPUExecutionProvider"]
                )
            await logger.ainfo("Loading YOLO detector", path=str(yolo_path))
            try:
                sess = create_session(str(yolo_path), providers=providers)
                self._detector = BirdDetector(
                    session=sess,
                    input_size=self._settings.yolo_input_size,
                    iou_dedup_threshold=self._settings.yolo_iou_dedup_threshold,
                )
                self._model_status["yolo"] = True
                active = sess.get_providers()
                self._model_providers["yolo"] = active[0] if active else "unknown"
                self._record_provider("yolo", sess)
                checksums["yolo"] = checksum_for(yolo_path)
            except Exception:
                await logger.aexception("Failed to load YOLO detector")

            # 主 session 为 CoreML / AMDGPU 时记录路径，异常时懒加载 CPU 备胎（省 ~300 MB）
            if self._detector is not None and self._model_providers.get("yolo") in {
                "CoreMLExecutionProvider",
                "AMDGPUExecutionProvider",
            }:
                self._detector_cpu_fallback_path = yolo_path
                await logger.ainfo("Armed lazy YOLO CPU fallback", path=str(yolo_path))
        else:
            await logger.awarning("YOLO detector not found", path=str(yolo_path))

        # ---- bird flight classifier v1 (fly / nofly; posture pipeline v2.1) ----
        flight_classifier_path = models_dir / "bird_flight_classifier.onnx"
        flight_classifier_config_path = models_dir / "bird_flight_classifier_config.json"
        if flight_classifier_path.exists():
            providers = resolve_providers(
                self._settings.pose_provider,
                coreml_compute_units=_COREML_NO_ANE,
                coreml_model_format=_COREML_MODEL_FORMAT,
                coreml_cache_dir=coreml_cache_dir,
            )
            await logger.ainfo(
                "Loading bird flight classifier v1",
                path=str(flight_classifier_path),
                threshold=self._settings.flight_classifier_threshold,
            )
            try:
                sess = create_session(str(flight_classifier_path), providers=providers)
                self._flight_classifier = FlightClassifier(
                    session=sess,
                    input_size=self._settings.flight_classifier_input_size,
                    threshold=self._settings.flight_classifier_threshold,
                )
                self._model_status["bird_flight_classifier"] = True
                active = sess.get_providers()
                self._model_providers["bird_flight_classifier"] = active[0] if active else "unknown"
                self._record_provider("bird_flight_classifier", sess)
                checksums["bird_flight_classifier"] = checksum_for(flight_classifier_path)
                if flight_classifier_config_path.exists():
                    checksums["bird_flight_classifier_config"] = checksum_for(
                        flight_classifier_config_path
                    )
            except Exception:
                await logger.aexception("Failed to load bird flight classifier")
        else:
            await logger.awarning(
                "Bird flight classifier not found",
                path=str(flight_classifier_path),
            )

        # ---- bird_visibility v2.0 (pose, 11 关键点; posture pipeline v2.1 uses classifier) ----
        # YOLO26l-pose 与 YOLO 同架构家族（NMS-free + advanced indexing head），
        # 同样在 ANE 上有精度风险（官方 INTEGRATION_GUIDE §14.2 实测 worst KP
        # drift 8.13 px）。强制 CPUAndGPU 关 ANE，与 YOLO 一致。
        pose_path = models_dir / "bird_visibility11.onnx"
        if pose_path.exists():
            providers = resolve_providers(
                self._settings.pose_provider,
                coreml_compute_units=_COREML_NO_ANE,
                coreml_model_format=_COREML_MODEL_FORMAT,
                coreml_cache_dir=coreml_cache_dir,
            )
            await logger.ainfo("Loading pose detector v2", path=str(pose_path))
            try:
                sess = create_session(str(pose_path), providers=providers)
                self._pose = PoseDetector(
                    session=sess,
                    input_size=self._settings.pose_input_size,
                    box_threshold=self._settings.pose_box_threshold,
                    eye_threshold=self._settings.pose_eye_threshold,
                    head_threshold=self._settings.pose_head_threshold,
                    head_eye_threshold=self._settings.pose_head_eye_threshold,
                    body_threshold=self._settings.pose_body_threshold,
                    tail_threshold=self._settings.pose_tail_threshold,
                    wing_threshold=self._settings.pose_wing_threshold,
                    expanded_box_margin=self._settings.pose_expanded_margin,
                    flight_classifier=self._flight_classifier,
                )
                self._model_status["bird_visibility"] = True
                active = sess.get_providers()
                self._model_providers["bird_visibility"] = active[0] if active else "unknown"
                self._record_provider("bird_visibility", sess)
                checksums["bird_visibility"] = checksum_for(pose_path)
            except Exception:
                await logger.aexception("Failed to load pose detector")
        else:
            await logger.awarning("Pose model not found", path=str(pose_path))

        # ---- CLIPIQA+ ----
        clipiqa_path = models_dir / "clipiqa_plus.onnx"
        clipiqa_session = None
        if clipiqa_path.exists():
            providers = resolve_providers(
                self._settings.iqa_provider,
                coreml_model_format=_COREML_MODEL_FORMAT,
                coreml_cache_dir=coreml_cache_dir,
            )
            await logger.ainfo("Loading CLIPIQA+", path=str(clipiqa_path))
            try:
                clipiqa_session = create_session(str(clipiqa_path), providers=providers)
                self._model_status["clipiqa"] = True
                active = clipiqa_session.get_providers()
                self._model_providers["clipiqa"] = active[0] if active else "unknown"
                self._record_provider("clipiqa", clipiqa_session)
                checksums["clipiqa"] = checksum_for(clipiqa_path)
            except Exception:
                await logger.aexception("Failed to load CLIPIQA+")
        else:
            await logger.awarning("CLIPIQA+ not found", path=str(clipiqa_path))

        # ---- HyperIQA ----
        hyperiqa_path = models_dir / "hyperiqa.onnx"
        hyperiqa_session = None
        if hyperiqa_path.exists():
            providers = resolve_providers(
                self._settings.iqa_provider,
                coreml_model_format=_COREML_MODEL_FORMAT,
                coreml_cache_dir=coreml_cache_dir,
            )
            await logger.ainfo("Loading HyperIQA", path=str(hyperiqa_path))
            try:
                hyperiqa_session = create_session(str(hyperiqa_path), providers=providers)
                self._model_status["hyperiqa"] = True
                active = hyperiqa_session.get_providers()
                self._model_providers["hyperiqa"] = active[0] if active else "unknown"
                self._record_provider("hyperiqa", hyperiqa_session)
                checksums["hyperiqa"] = checksum_for(hyperiqa_path)
            except Exception:
                await logger.aexception("Failed to load HyperIQA")
        else:
            await logger.awarning("HyperIQA not found", path=str(hyperiqa_path))

        clipiqa_loaded = clipiqa_session is not None
        hyperiqa_loaded = hyperiqa_session is not None
        if clipiqa_loaded and hyperiqa_loaded:
            self._assessor = QualityAssessor(
                clipiqa_session=clipiqa_session,
                hyperiqa_session=hyperiqa_session,
                clipiqa_weight=self._settings.clipiqa_weight,
                hyperiqa_weight=self._settings.hyperiqa_weight,
            )
        elif clipiqa_loaded or hyperiqa_loaded:
            await logger.awarning(
                "IQA assessor incomplete — releasing partial sessions",
                clipiqa_loaded=clipiqa_loaded,
                hyperiqa_loaded=hyperiqa_loaded,
            )
            clipiqa_session = None
            hyperiqa_session = None
            self._model_status["clipiqa"] = False
            self._model_status["hyperiqa"] = False
            self._model_providers.pop("clipiqa", None)
            self._model_providers.pop("hyperiqa", None)
            self._provider_details.pop("clipiqa", None)
            self._provider_details.pop("hyperiqa", None)
            checksums.pop("clipiqa", None)
            checksums.pop("hyperiqa", None)

        # Strict 模式：IQA 缺失则启动失败，避免用户拿到伪造 0.5 分 / grade=USABLE。
        # 仅 packaged 应用启用（process-manager 注入 PLUMELENS_REQUIRE_IQA=1）。
        if self._assessor is None and self._settings.require_iqa:
            await logger.aerror(
                "IQA assessor not loaded under strict mode — refusing to start",
                clipiqa_path=str(clipiqa_path),
                hyperiqa_path=str(hyperiqa_path),
                clipiqa_loaded=clipiqa_loaded,
                hyperiqa_loaded=hyperiqa_loaded,
            )
            raise RuntimeError(
                "IQA models required but not loaded "
                "(set PLUMELENS_REQUIRE_IQA=0 only for dev without models)."
            )

        # ---- DINOv3 species classifier v4 (torch + transformers + LoRA/reject) ----
        # 旧 v3 8-head ensemble 已替换为 seed42 LoRA adapter + calibrated reject head。
        # 纯 ONNX species 路线仍不使用（RoPE fp16 NaN + CoreML EP ViT 覆盖差）。
        species_dir = models_dir / "species"
        species_backbone_safetensors = species_dir / "backbone" / "model.safetensors"
        species_canonical = species_dir / "canonical_extended.parquet"
        species_adapter = species_dir / "v4" / "seed42_adapter.pt"
        species_policy = species_dir / "v4_calibration_policy.json"
        if (
            species_backbone_safetensors.exists()
            and species_canonical.exists()
            and species_adapter.exists()
            and species_policy.exists()
        ):
            await logger.ainfo("Loading DINOv3 species v4", deploy_dir=str(species_dir))
            try:
                self._species = SpeciesClassifier(
                    deploy_dir=species_dir,
                    device=self._settings.species_provider,  # "auto"/"cpu"/"mps"/"cuda"
                    top_k=self._settings.species_top_k,
                    min_confidence=self._settings.species_min_confidence,
                )
                self._model_status["dinov3_species_v4"] = True
                species_backend = self._species.device
                if species_backend == "cuda" and import_module("torch").version.hip:
                    species_backend = "rocm"
                self._model_providers["dinov3_species_v4"] = (
                    f"torch:{species_backend}:{self._species._dtype}"
                )
                checksums["dinov3_species_v4_backbone"] = checksum_for(species_backbone_safetensors)
                checksums["dinov3_species_v4_adapter"] = checksum_for(species_adapter)
                checksums["species_canonical"] = checksum_for(species_canonical)
                checksums["species_policy"] = checksum_for(species_policy)
                backbone_config = species_dir / "backbone" / "config.json"
                if backbone_config.exists():
                    checksums["dinov3_species_v4_config"] = checksum_for(backbone_config)
                await logger.ainfo(
                    "Species classifier ready",
                    num_classes=self._species.num_classes,
                    policy=self._species.policy_name,
                    device=self._species.device,
                )
            except Exception:
                await logger.aexception("Failed to load species classifier v4")
        else:
            missing = [
                str(p.relative_to(models_dir))
                for p in (
                    species_backbone_safetensors,
                    species_canonical,
                    species_adapter,
                    species_policy,
                )
                if not p.exists()
            ]
            await logger.awarning(
                "Species classifier v4 disabled (files missing)",
                missing=missing,
            )

        from engine.core.windows_resources import (
            MemoryBoundLimiter,
            configure_macos,
            configure_windows,
        )

        self.resource_profile = configure_windows(
            self._settings,
            native_gpu=self._model_providers.get("yolo") == "AMDGPUExecutionProvider",
        ) or configure_macos(self._settings)
        self._analysis_slots = MemoryBoundLimiter(self._settings.analysis_concurrency)
        if self.resource_profile:
            await logger.ainfo("Configured platform processing pipelines", **self.resource_profile)
        if self.is_ready and "CoreMLExecutionProvider" in self._model_providers.values():
            prune_stale_coreml_caches(coreml_cache_root, coreml_active_dirname)

        self._pipeline_version = self._compute_version(checksums)
        await logger.ainfo(
            "Pipeline initialized",
            ready=self.is_ready,
            pose_available=self._pose is not None,
            species_available=self._species is not None,
            version=self._pipeline_version,
            model_status=self._model_status,
        )

    def _record_provider(self, model_id: str, session: Any) -> None:
        options = session.get_provider_options()
        # A cache location changes startup performance, not model results.
        for values in options.values():
            values.pop("cache_dir", None)
            values.pop("ModelCacheDirectory", None)
        self._provider_details[model_id] = {
            "chain": list(session.get_providers()),
            "options": options,
        }

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
        h.update(f"yid:{self._settings.yolo_iou_dedup_threshold}".encode())
        # Crop
        h.update(f"cr:{self._settings.crop_expand_ratio}".encode())
        h.update(f"cp:{self._settings.crop_padding_ratio}".encode())
        # IQA-specific expand crop (separate from pose crop)
        h.update(f"iqe:{self._settings.iqa_expand_ratio}".encode())
        h.update(f"iqar:{self._settings.iqa_max_aspect_ratio}".encode())
        # 算法版本:bump 每当评分/降档逻辑变(pose penalty / grading / species 口径)。
        # v9:IQA 综合分权重再次调整为 0.40 CLIPIQA / 0.60 HyperIQA — HyperIQA 技术
        # 质量(锐度/噪声/曝光)略主导,CLIPIQA+ 语义/构图作辅助。比 v8 (0.55/0.45)
        # 更看重像素级清晰度,适合鸟摄"清晰主体 + 良好构图"的双门槛。
        # v8:综合分权重重平衡 0.55/0.45(从 0.35/0.65)。
        # v7:bird_visibility v2(11 关键点) + grader 飞版升档(head+eye 可见 +
        # posture=flying → +1 档);PoseInfo schema 加 6 关键点 + body/tail/wings + 3 posture。
        # v6:species v4 LoRA/reject 三态,uncertain 不再写入自动物种结论。
        # CLIPIQA/HyperIQA 图内已经做 ImageNet normalization,engine 只传 raw RGB 0-1。
        h.update(b"alg:v9-iqa-weights-040-060")
        # Pose thresholds (8 项,v2 新增 body/tail/wing)
        h.update(f"pbt:{self._settings.pose_box_threshold}".encode())
        h.update(f"pet:{self._settings.pose_eye_threshold}".encode())
        h.update(f"pht:{self._settings.pose_head_threshold}".encode())
        h.update(f"phet:{self._settings.pose_head_eye_threshold}".encode())
        h.update(f"pbody:{self._settings.pose_body_threshold}".encode())
        h.update(f"ptail:{self._settings.pose_tail_threshold}".encode())
        h.update(f"pwing:{self._settings.pose_wing_threshold}".encode())
        h.update(f"pem:{self._settings.pose_expanded_margin}".encode())
        h.update(f"pis:{self._settings.pose_input_size}".encode())
        h.update(f"phv:{POSTURE_HEURISTIC_VERSION}".encode())
        h.update(f"fcv:{FLIGHT_CLASSIFIER_VERSION}".encode())
        h.update(f"fcis:{self._settings.flight_classifier_input_size}".encode())
        h.update(f"fct:{self._settings.flight_classifier_threshold}".encode())
        # Species
        h.update(f"stk:{self._settings.species_top_k}".encode())
        h.update(f"smc:{self._settings.species_min_confidence}".encode())
        h.update(f"scm:{self._settings.species_crop_margin}".encode())
        h.update(f"scs:{self._settings.species_crop_min_side_frac}".encode())
        h.update(f"smg:{self._settings.species_min_grade}".encode())
        # Preprocess code version
        h.update(f"pp:{self._settings.preprocess_version}".encode())
        # Hard-coded code constants that affect output but live outside Settings.
        # Without这些进 hash,改这些常量(例如 IMAGENET 归一化均值、IQA fallback 默认
        # 分、species crop margin/size)会让旧 cache 命中错的结果而 pipeline_version
        # 不变。preprocess_version 是 manual bump,容易漏。这里直接 hash 常量本身。
        h.update(f"qfb:{IQA_NONFINITE_FALLBACK_SCORE}".encode())
        h.update(f"imn:{IMAGENET_MEAN}".encode())
        h.update(f"ims:{IMAGENET_STD}".encode())
        h.update(f"sis:{DEFAULT_IMAGE_SIZE}".encode())
        h.update(f"sbm:{BBOX_MARGIN}".encode())
        # Runtime environment
        h.update(f"ort:{ort.__version__}".encode())
        ep_str = ",".join(sorted(self._model_providers.values()))
        h.update(f"ep:{ep_str}".encode())
        # CoreML EP compute_units（"CPUAndGPU" 关 ANE）与 ModelFormat（"MLProgram"）
        # 会影响图划分与数值精度，必须进 hash 让旧版本 cache 失效。
        h.update(f"cml_no_ane:{_COREML_NO_ANE}".encode())
        h.update(f"cml_fmt:{_COREML_MODEL_FORMAT}".encode())
        runtime: dict[str, str] = {"onnxruntime": ort.__version__}
        for package in ("torch", "transformers", "numpy", "pillow", "rawpy"):
            try:
                runtime[package] = package_version(package)
            except PackageNotFoundError:
                # Frozen bundles may omit dist-info while retaining module
                # versions. Keep their actual runtime identity as well.
                module_name = "PIL" if package == "pillow" else package
                try:
                    runtime[package] = str(import_module(module_name).__version__)
                except (ImportError, AttributeError):
                    runtime[package] = "not-installed"
        self._version_descriptor = {
            "schema": 2,
            "assets": dict(sorted(checksums.items())),
            # 显式白名单：仅包含影响推理结果的字段，避免新增运维/日志/会话字段
            # (如 session_id / device_id / logging_enabled) 意外破坏 pipeline_version 缓存。
            "parameters": self._settings.model_dump(
                mode="json",
                include={
                    "yolo_provider",
                    "iqa_provider",
                    "pose_provider",
                    "species_provider",
                    "yolo_confidence",
                    "yolo_input_size",
                    "yolo_iou_dedup_threshold",
                    "crop_expand_ratio",
                    "crop_padding_ratio",
                    "iqa_expand_ratio",
                    "iqa_max_aspect_ratio",
                    "clipiqa_weight",
                    "hyperiqa_weight",
                    "grade_thresholds",
                    "pose_input_size",
                    "pose_box_threshold",
                    "pose_eye_threshold",
                    "pose_head_threshold",
                    "pose_head_eye_threshold",
                    "pose_body_threshold",
                    "pose_tail_threshold",
                    "pose_wing_threshold",
                    "pose_expanded_margin",
                    "flight_classifier_input_size",
                    "flight_classifier_threshold",
                    "species_top_k",
                    "species_min_confidence",
                    "species_crop_margin",
                    "species_crop_min_side_frac",
                    "species_min_grade",
                    "preprocess_version",
                },
            ),
            "rules_digest": h.hexdigest(),
            "runtime": runtime,
            "providers": dict(sorted(self._model_providers.items())),
            "provider_details": copy.deepcopy(self._provider_details),
            "detector_cpu_fallback": (
                self._detector_cpu_fallback is not None
                or self._detector_cpu_fallback_path is not None
            ),
        }
        encoded = json.dumps(self._version_descriptor, sort_keys=True, separators=(",", ":"))
        return f"v2-{hashlib.sha256(encoded.encode()).hexdigest()[:16]}"

    def _get_or_load_detector_cpu_fallback(self) -> BirdDetector | None:
        """Lazily initialize the CPU YOLO fallback session on first GPU exception."""
        if self._detector_cpu_fallback is not None:
            return self._detector_cpu_fallback
        yolo_path = self._detector_cpu_fallback_path
        if yolo_path is None or not yolo_path.exists():
            return None
        with self._detector_cpu_fallback_lock:
            if self._detector_cpu_fallback is not None:
                return self._detector_cpu_fallback
            try:
                cpu_sess = create_session(
                    str(yolo_path),
                    providers=["CPUExecutionProvider"],
                )
                self._detector_cpu_fallback = BirdDetector(
                    session=cpu_sess,
                    input_size=self._settings.yolo_input_size,
                    iou_dedup_threshold=self._settings.yolo_iou_dedup_threshold,
                )
                logger.info("Lazily loaded YOLO CPU fallback session", path=str(yolo_path))
            except Exception:
                logger.exception("Failed to lazily load YOLO CPU fallback")
                return None
            return self._detector_cpu_fallback

    def close(self) -> None:
        """Release resources. Called during shutdown."""
        self._detector = None
        self._detector_cpu_fallback = None
        self._detector_cpu_fallback_path = None
        self._assessor = None
        self._pose = None
        self._flight_classifier = None
        self._species = None
        self._model_status = dict.fromkeys(self._model_status, False)
        self._model_providers.clear()
        self._provider_details.clear()

    @property
    def version_descriptor(self) -> dict:
        """Inspectable, token-free input vector for explaining historical reruns."""
        return copy.deepcopy(self._version_descriptor)

    @property
    def pipeline_version(self) -> str:
        return self._pipeline_version

    @property
    def is_ready(self) -> bool:
        """True if at minimum the detector is loaded.

        检测器是所有后续步骤的入口，没它整个管线无意义。IQA/pose/species 均为
        增强模块，单独缺失时 analyze() 会对应降级（grade 默认 usable，跳过对应步骤）。
        """
        return self._detector is not None

    @property
    def quality_available(self) -> bool:
        return self._assessor is not None

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

    @property
    def resource_status(self) -> dict[str, object]:
        from engine.core.windows_resources import memory_status

        memory = memory_status()
        return {
            **self.resource_profile,
            "available_memory_bytes": memory.available if memory else None,
            "analysis_active": self._analysis_slots.active,
            "analysis_current_limit": self._analysis_slots.target_limit,
        }

    async def analyze(self, image_path: Path, photo_id: str = "") -> PipelineResult:
        """Run full pipeline on an image.

        Core flow: detect → (pose per bbox) → quality assess → grade
        Enhancement: head+eye visible AND grade ≥ species_min_grade → species classify
        """
        if not self.is_ready:
            msg = "Pipeline not ready: detector model not loaded"
            raise RuntimeError(msg)
        assert self._detector is not None

        start = time.perf_counter()
        result = await self._analysis_slots.run_in_thread(self._analyze_sync, image_path, photo_id)
        result.duration_ms = (time.perf_counter() - start) * 1000
        return result

    def _analyze_sync(self, image_path: Path, photo_id: str) -> PipelineResult:
        """Synchronous pipeline execution (runs in thread pool)."""
        # Snapshot model handles locally so a concurrent shutdown/close() cannot null them mid-run.
        detector = self._detector
        detector_cpu_fallback = self._detector_cpu_fallback
        pose_detector = self._pose
        assessor = self._assessor
        species_classifier = self._species
        if detector is None:
            raise RuntimeError("Pipeline closed before analysis started")

        # 各阶段耗时（ms）
        t_load_ms = 0.0
        t_yolo_ms = 0.0
        t_crop_ms = 0.0
        t_pose_ms = 0.0
        t_flight_ms = 0.0
        t_clipiqa_ms = 0.0
        t_hyperiqa_ms = 0.0
        t_iqa_ms = 0.0
        t_species_ms = 0.0
        yolo_cpu_fallback = False

        _t = time.perf_counter()
        # Full-resolution uint8 image in display orientation (134 MB vs 536 MB float32 for 45 MP).
        # Every downstream crop is cut from this original image array; float32 conversion happens
        # lazily only on the resized 1280px/640px/224px/384px model inputs.
        image = load_image_u8(image_path)
        t_load_ms = (time.perf_counter() - _t) * 1000
        img_h, img_w = image.shape[:2]

        # Step 1: YOLO detection on full image（CoreML EP 偶发 GatherElements 崩 → fallback CPU）
        _t = time.perf_counter()
        try:
            boxes = detector.detect(
                image, confidence_threshold=self._settings.yolo_confidence
            )
        except Exception as e:
            fallback = detector_cpu_fallback or self._get_or_load_detector_cpu_fallback()
            if fallback is not None:
                yolo_cpu_fallback = True
                logger.warning(
                    "YOLO GPU failed, falling back to CPU",
                    photo_id=photo_id,
                    error=str(e)[:120],
                )
                boxes = fallback.detect(
                    image,
                    confidence_threshold=self._settings.yolo_confidence,
                )
            else:
                raise
        t_yolo_ms = (time.perf_counter() - _t) * 1000

        staged_birds: list[tuple[Any, Any, QualityGrade, Any]] = []
        padding = self._settings.crop_padding_ratio

        for box in boxes:
            # Step 2a: pose / HyperIQA 用原图紧主体裁切（bbox + 10% padding）。
            # pose 需要定位精准；HyperIQA 负责主体技术画质，不能被 2.5x 大裁切里的
            # 背景/虚化/留白稀释。
            _t_crop = time.perf_counter()
            bw = box.x2 - box.x1
            bh = box.y2 - box.y1
            px = bw * padding
            py = bh * padding
            pad_x1 = max(0.0, box.x1 - px)
            pad_y1 = max(0.0, box.y1 - py)
            pad_x2 = min(float(img_w), box.x2 + px)
            pad_y2 = min(float(img_h), box.y2 + py)

            technical_crop = crop_bbox(
                image,
                x1=pad_x1,
                y1=pad_y1,
                x2=pad_x2,
                y2=pad_y2,
                expand_ratio=self._settings.crop_expand_ratio,
            )

            # Step 2b: CLIPIQA 用原图大裁切（bbox 放大 expand_ratio 倍，含背景/构图）。
            semantic_crop = expand_for_iqa(
                image,
                x1=box.x1,
                y1=box.y1,
                x2=box.x2,
                y2=box.y2,
                expand=self._settings.iqa_expand_ratio,
                max_aspect_ratio=self._settings.iqa_max_aspect_ratio,
            )
            t_crop_ms += (time.perf_counter() - _t_crop) * 1000

            # Step 3a: pose detection (crop-mode)
            # crop_origin 必须与 crop_bbox 内部 int(round(x))/int(round(y)) 取整一致 —
            # 不然 PoseDetector 把 crop 内关键点 +offset 还原到原图时,offset 是浮点
            # (pad_x1=10.7),实际 crop 起点是整数(11),关键点叠加在原图上会有最多
            # 1px 漂移。
            crop_origin = (round(pad_x1), round(pad_y1))
            pose_info = None
            _t = time.perf_counter()
            if pose_detector is not None:
                try:
                    pose_info = pose_detector.detect(
                        technical_crop,
                        crop_origin=crop_origin,
                    )
                except Exception:
                    logger.exception("Pose detection failed", photo_id=photo_id)
            pose_elapsed = (time.perf_counter() - _t) * 1000
            raw_flight_ms = (
                pose_detector.last_flight_ms()
                if pose_detector is not None and hasattr(pose_detector, "last_flight_ms")
                else 0.0
            )
            flight_part = float(raw_flight_ms) if isinstance(raw_flight_ms, (int, float)) else 0.0
            t_flight_ms += flight_part
            t_pose_ms += max(0.0, pose_elapsed - flight_part)

            # Step 3b: quality assessment (降级：IQA 模型缺失时用固定分数)
            _t = time.perf_counter()
            if assessor is not None:
                scores = assessor.assess(
                    semantic_crop=semantic_crop,
                    technical_crop=technical_crop,
                )
                if hasattr(assessor, "last_timings_ms"):
                    timings = assessor.last_timings_ms()
                    if (
                        isinstance(timings, tuple)
                        and len(timings) == 2
                        and isinstance(timings[0], (int, float))
                        and isinstance(timings[1], (int, float))
                    ):
                        t_clipiqa_ms += float(timings[0])
                        t_hyperiqa_ms += float(timings[1])
            else:
                # IQA 模型未加载 → 返回中性分数 0.5，grade 降级为 USABLE
                from engine.pipeline.models import QualityScores

                scores = QualityScores(clipiqa=0.5, hyperiqa=0.5, combined=0.5)
            t_iqa_ms += (time.perf_counter() - _t) * 1000
            iqa_grade = grade(scores.combined, self._settings.grade_thresholds)
            # Step 3c: pose 调整(降档:头不可见 -2 / 眼不可见 -1;升档:头眼齐 + 飞版 +1)
            bird_grade = apply_pose_adjustment(iqa_grade, pose_info)
            staged_birds.append((box, scores, bird_grade, pose_info))

        # Step 4: species classification (gated; batch multi-bird photos in one GPU pass)
        species_by_idx: dict[int, list[SpeciesCandidate]] = {}
        if species_classifier is not None and staged_birds:
            gated_indices: list[int] = []
            gated_crops: list[Any] = []
            for idx, (box, _scores, bird_grade, pose_info) in enumerate(staged_birds):
                if self._should_run_species(pose_info, bird_grade):
                    gated_indices.append(idx)
                    gated_crops.append(
                        self._prepare_species_crop(
                            image, box.x1, box.y1, box.x2, box.y2, img_w, img_h
                        )
                    )
            if gated_crops:
                _t = time.perf_counter()
                use_batch = len(gated_crops) > 1 and isinstance(
                    species_classifier, SpeciesClassifier
                )
                if use_batch:
                    try:
                        batched = species_classifier.classify_batch(gated_crops)
                        for idx, cands in zip(gated_indices, batched, strict=False):
                            species_by_idx[idx] = cands
                    except Exception:
                        logger.exception(
                            "Batched species classification failed", photo_id=photo_id
                        )
                else:
                    for idx, crop in zip(gated_indices, gated_crops, strict=False):
                        try:
                            species_by_idx[idx] = species_classifier.classify(crop)
                        except Exception:
                            logger.exception("Species classification failed", photo_id=photo_id)
                t_species_ms += (time.perf_counter() - _t) * 1000

        detections: list[BirdAnalysis] = []
        for idx, (box, scores, bird_grade, pose_info) in enumerate(staged_birds):
            species_candidates = species_by_idx.get(idx, [])
            top_candidate = species_candidates[0] if species_candidates else None
            species_name = None
            if top_candidate is not None and top_candidate.recognition_state == "recognized":
                species_name = top_candidate.canonical_zh or top_candidate.canonical_sci

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
        stage_timings = {
            "load_decode": round(t_load_ms, 1),
            "yolo": round(t_yolo_ms, 1),
            "crop": round(t_crop_ms, 1),
            "pose": round(t_pose_ms, 1),
            "flight": round(t_flight_ms, 1),
            "clipiqa": round(t_clipiqa_ms, 1),
            "hyperiqa": round(t_hyperiqa_ms, 1),
            "iqa": round(t_iqa_ms, 1),
            "species": round(t_species_ms, 1),
        }

        return PipelineResult(
            photo_id=photo_id,
            detections=detections,
            best=best,
            bird_count=len(detections),
            pipeline_version=self._pipeline_version,
            duration_ms=0.0,
            image_width=img_w,
            image_height=img_h,
            companion_used=False,
            stage_timings=stage_timings,
            yolo_cpu_fallback=yolo_cpu_fallback,
        )

    def _should_run_species(
        self,
        pose_info,  # PoseInfo | None  — 已不参与判定，保留参数避免破坏调用点签名
        bird_grade: QualityGrade,
    ) -> bool:
        """Decide whether to run species classifier on this bird.

        Criteria（放宽后）:
        - species model loaded
        - grade ≥ species_min_grade

        head/eye visibility 不再是 gate — head 不可见时仍跑识别。结果在
        read-time 由 library.py 的 species_source 计算逻辑标记为
        'model_unconfirmed'，需用户在详情页确认才进羽迹统计（HANDOVER §11.2）。
        """
        del pose_info  # 显式标记 unused，对应 docstring 的"不参与判定"
        if self._species is None:
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
