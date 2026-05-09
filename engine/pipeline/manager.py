# pyright: basic
"""Pipeline lifecycle management and orchestration."""

from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path

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
from engine.pipeline.preprocess import crop_bbox, expand_for_iqa, load_image
from engine.pipeline.quality import IQA_NONFINITE_FALLBACK_SCORE, QualityAssessor
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


def resolve_providers(
    requested: str,
    *,
    coreml_compute_units: str | None = None,
) -> list:
    """Map config string to onnxruntime execution provider list.

    Args:
        requested: "cpu" / "coreml" / "cuda" / "auto"
        coreml_compute_units: CoreML EP 的 MLComputeUnits 选项（可选）。
            None → 不指定（CoreML 默认 'ALL'）
            'CPUAndGPU' → 关 ANE，只走 Metal GPU + CPU。**YOLO 必须用这个**
            'CPUOnly' / 'CPUAndNeuralEngine' / 'ALL' 也支持
            如果设置了，对应的 CoreML provider 会以 (name, options) 元组形式注入。

    Returns:
        list — 可能含 str（普通 EP 名）或 tuple[str, dict]（带选项的 EP）。
        ort.InferenceSession 接收这种混合格式。
    """
    import platform

    coreml_entry: str | tuple[str, dict[str, str]]
    if coreml_compute_units:
        coreml_entry = ("CoreMLExecutionProvider", {"MLComputeUnits": coreml_compute_units})
    else:
        coreml_entry = "CoreMLExecutionProvider"

    if requested == "cpu":
        return ["CPUExecutionProvider"]
    if requested == "coreml":
        return [coreml_entry, "CPUExecutionProvider"]
    if requested == "cuda":
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]

    if requested == "auto":
        if platform.system() == "Darwin" and platform.machine() == "arm64":
            return [coreml_entry, "CPUExecutionProvider"]
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
    """Central manager for the hybrid bird analysis pipeline.

    Created once at app startup, stored in app.state.pipeline.

    Module readiness is tracked separately:
    - Core (detector + quality assessor): required for is_ready = True
    - Enhancements (pose, species): optional, gracefully skipped if missing
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._detector: BirdDetector | None = None
        # YOLO CPU fallback：CoreML EP 偶发 GatherElements 越界（onnxruntime 1.25 残留 bug，
        # ~3% 输入触发）。预先加载一份 CPU session，单图崩了 fallback 重跑。
        self._detector_cpu_fallback: BirdDetector | None = None
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

    async def initialize(self) -> None:
        """Load ONNX models and torch species assets during FastAPI startup."""
        import onnxruntime as ort

        models_dir = self._settings.models_dir

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

        # ---- YOLO detector ----
        yolo_path = models_dir / "yolo26l-bird-det.onnx"
        if yolo_path.exists():
            # YOLO 必须给 CoreML EP 传 MLComputeUnits=CPUAndGPU 关 ANE，
            # 否则 advanced indexing 在 ANE 上精度 bug 会出 letterbox 越界 bbox。
            # YOLO 与 pose 同架构族都走 CPUAndGPU；IQA 图无 advanced indexing，保留默认 CoreML。
            providers = resolve_providers(
                self._settings.yolo_provider,
                coreml_compute_units=_COREML_NO_ANE,
            )
            await logger.ainfo("Loading YOLO detector", path=str(yolo_path))
            try:
                sess = ort.InferenceSession(str(yolo_path), providers=providers)
                self._detector = BirdDetector(
                    session=sess,
                    input_size=self._settings.yolo_input_size,
                    iou_dedup_threshold=self._settings.yolo_iou_dedup_threshold,
                )
                self._model_status["yolo"] = True
                active = sess.get_providers()
                self._model_providers["yolo"] = active[0] if active else "unknown"
                checksums["yolo"] = _file_checksum(yolo_path)
            except Exception:
                await logger.aexception("Failed to load YOLO detector")

            # 如果主 session 是 CoreML，额外加载一份 CPU 备胎给 ~3% 崩溃图 fallback
            if self._detector is not None and "coreml" in self._settings.yolo_provider.lower():
                try:
                    cpu_sess = ort.InferenceSession(
                        str(yolo_path),
                        providers=["CPUExecutionProvider"],
                    )
                    self._detector_cpu_fallback = BirdDetector(
                        session=cpu_sess,
                        input_size=self._settings.yolo_input_size,
                        iou_dedup_threshold=self._settings.yolo_iou_dedup_threshold,
                    )
                    await logger.ainfo("Loaded YOLO CPU fallback session")
                except Exception:
                    await logger.aexception("Failed to load YOLO CPU fallback")
        else:
            await logger.awarning("YOLO detector not found", path=str(yolo_path))

        # ---- bird flight classifier v1 (fly / nofly; posture pipeline v2.1) ----
        flight_classifier_path = models_dir / "bird_flight_classifier.onnx"
        flight_classifier_config_path = models_dir / "bird_flight_classifier_config.json"
        if flight_classifier_path.exists():
            providers = resolve_providers(
                self._settings.pose_provider,
                coreml_compute_units=_COREML_NO_ANE,
            )
            await logger.ainfo(
                "Loading bird flight classifier v1",
                path=str(flight_classifier_path),
                threshold=self._settings.flight_classifier_threshold,
            )
            try:
                sess = ort.InferenceSession(str(flight_classifier_path), providers=providers)
                self._flight_classifier = FlightClassifier(
                    session=sess,
                    input_size=self._settings.flight_classifier_input_size,
                    threshold=self._settings.flight_classifier_threshold,
                )
                self._model_status["bird_flight_classifier"] = True
                active = sess.get_providers()
                self._model_providers["bird_flight_classifier"] = (
                    active[0] if active else "unknown"
                )
                checksums["bird_flight_classifier"] = _file_checksum(flight_classifier_path)
                if flight_classifier_config_path.exists():
                    checksums["bird_flight_classifier_config"] = _file_checksum(
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
            )
            await logger.ainfo("Loading pose detector v2", path=str(pose_path))
            try:
                sess = ort.InferenceSession(str(pose_path), providers=providers)
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
                clipiqa_session = ort.InferenceSession(str(clipiqa_path), providers=providers)
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
                hyperiqa_session = ort.InferenceSession(str(hyperiqa_path), providers=providers)
                self._model_status["hyperiqa"] = True
                active = hyperiqa_session.get_providers()
                self._model_providers["hyperiqa"] = active[0] if active else "unknown"
                checksums["hyperiqa"] = _file_checksum(hyperiqa_path)
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
                self._model_providers["dinov3_species_v4"] = (
                    f"torch:{self._species.device}:{self._species._dtype}"
                )
                checksums["dinov3_species_v4_backbone"] = _file_checksum(
                    species_backbone_safetensors
                )
                checksums["dinov3_species_v4_adapter"] = _file_checksum(species_adapter)
                checksums["species_canonical"] = _file_checksum(species_canonical)
                checksums["species_policy"] = _file_checksum(species_policy)
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
        # CoreML EP compute_units（"CPUAndGPU" 关 ANE）— 改这个会改推理结果
        # （ANE bug 路径 vs Metal GPU 路径），必须进 hash 让 cache 失效。
        h.update(f"cml_no_ane:{_COREML_NO_ANE}".encode())
        return f"v1-{h.hexdigest()[:8]}"

    def close(self) -> None:
        """Release resources. Called during shutdown."""
        self._detector = None
        self._assessor = None
        self._pose = None
        self._flight_classifier = None
        self._species = None

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
        result = await asyncio.to_thread(self._analyze_sync, image_path, photo_id)
        result.duration_ms = (time.perf_counter() - start) * 1000
        return result

    def _analyze_sync(self, image_path: Path, photo_id: str) -> PipelineResult:
        """Synchronous pipeline execution (runs in thread pool)."""
        assert self._detector is not None

        # 各阶段耗时（debug 用，info 级日志）
        t_load_ms = 0.0
        t_yolo_ms = 0.0
        t_pose_ms = 0.0
        t_iqa_ms = 0.0
        t_species_ms = 0.0

        _t = time.perf_counter()
        # Full-resolution image in display orientation. Every downstream crop is cut from
        # this original image array. Letterbox-resized tensors are only transient model
        # inputs; their coordinates are always mapped back before cropping.
        image = load_image(image_path)
        t_load_ms = (time.perf_counter() - _t) * 1000
        img_h, img_w = image.shape[:2]

        # Step 1: YOLO detection on full image（CoreML EP 偶发 GatherElements 崩 → fallback CPU）
        _t = time.perf_counter()
        try:
            boxes = self._detector.detect(
                image, confidence_threshold=self._settings.yolo_confidence
            )
        except Exception as e:
            if self._detector_cpu_fallback is not None:
                logger.warning(
                    "YOLO CoreML failed, falling back to CPU",
                    photo_id=photo_id,
                    error=str(e)[:120],
                )
                boxes = self._detector_cpu_fallback.detect(
                    image,
                    confidence_threshold=self._settings.yolo_confidence,
                )
            else:
                raise
        t_yolo_ms = (time.perf_counter() - _t) * 1000

        detections: list[BirdAnalysis] = []
        padding = self._settings.crop_padding_ratio

        for box in boxes:
            # Step 2a: pose / HyperIQA 用原图紧主体裁切（bbox + 10% padding）。
            # pose 需要定位精准；HyperIQA 负责主体技术画质，不能被 2.5x 大裁切里的
            # 背景/虚化/留白稀释。
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

            # Step 3a: pose detection (crop-mode)
            # crop_origin 必须与 crop_bbox 内部 int(round(x))/int(round(y)) 取整一致 —
            # 不然 PoseDetector 把 crop 内关键点 +offset 还原到原图时,offset 是浮点
            # (pad_x1=10.7),实际 crop 起点是整数(11),关键点叠加在原图上会有最多
            # 1px 漂移。
            crop_origin = (round(pad_x1), round(pad_y1))
            pose_info = None
            _t = time.perf_counter()
            if self._pose is not None:
                try:
                    pose_info = self._pose.detect(
                        technical_crop,
                        crop_origin=crop_origin,
                    )
                except Exception:
                    logger.exception("Pose detection failed", photo_id=photo_id)
            t_pose_ms += (time.perf_counter() - _t) * 1000

            # Step 3b: quality assessment (降级：IQA 模型缺失时用固定分数)
            _t = time.perf_counter()
            if self._assessor is not None:
                scores = self._assessor.assess(
                    semantic_crop=semantic_crop,
                    technical_crop=technical_crop,
                )
            else:
                # IQA 模型未加载 → 返回中性分数 0.5，grade 降级为 USABLE
                from engine.pipeline.models import QualityScores

                scores = QualityScores(clipiqa=0.5, hyperiqa=0.5, combined=0.5)
            t_iqa_ms += (time.perf_counter() - _t) * 1000
            iqa_grade = grade(scores.combined, self._settings.grade_thresholds)
            # Step 3c: pose 调整(降档:头不可见 -2 / 眼不可见 -1;升档:头眼齐 + 飞版 +1)
            bird_grade = apply_pose_adjustment(iqa_grade, pose_info)

            # Step 4: species classification (gated)
            species_candidates: list[SpeciesCandidate] = []
            _t = time.perf_counter()
            if self._should_run_species(pose_info, bird_grade):
                assert self._species is not None
                species_crop = self._prepare_species_crop(
                    image, box.x1, box.y1, box.x2, box.y2, img_w, img_h
                )
                try:
                    species_candidates = self._species.classify(species_crop)
                except Exception:
                    logger.exception("Species classification failed", photo_id=photo_id)
            t_species_ms += (time.perf_counter() - _t) * 1000

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

        # 每张耗时分解日志（可在 stderr 看到，便于性能调优）
        logger.info(
            "Pipeline timing",
            photo_id=photo_id,
            birds=len(boxes),
            load_ms=round(t_load_ms, 1),
            yolo_ms=round(t_yolo_ms, 1),
            pose_ms=round(t_pose_ms, 1),
            iqa_ms=round(t_iqa_ms, 1),
            species_ms=round(t_species_ms, 1),
        )

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
