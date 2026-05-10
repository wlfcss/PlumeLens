"""Application configuration via Pydantic Settings."""

from pathlib import Path
from typing import Self

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PLUMELENS_")

    # Server
    host: str = "127.0.0.1"
    port: int = 0
    log_level: str = "INFO"
    data_dir: Path = Path.home() / ".plumelens"
    # Optional local API bearer token. Electron sets this per process launch; when unset
    # (pytest / standalone development), auth is disabled for convenience.
    api_token: str | None = None

    # Pipeline — model files
    models_dir: Path = Path(__file__).resolve().parent.parent / "models"

    # Pipeline — execution providers ("auto" / "coreml" / "cuda" / "cpu")
    # macOS onnxruntime 1.25 实测（2026-04-27 更新）：
    # - YOLO + CoreML(CPUAndGPU)：**正确 + 3.5× 加速**。
    #   关键发现：bbox 越界的根因是 ANE（Apple Neural Engine）对 advanced indexing
    #   的精度实现有 bug，不是整个 CoreML EP 的问题。`MLComputeUnits='CPUAndGPU'`
    #   关 ANE 只走 Metal GPU + CPU 兜底，bbox 与 CPU EP 一致到 0.1px，速度 ~112ms
    #   （vs CPU EP ~395ms）。manager.py::resolve_providers 自动给 YOLO 注入。
    # - pose（YOLO26l-pose）+ CoreML(CPUAndGPU)：**安全 + 2.8× 加速**。
    #   同 YOLO 同架构家族同 ANE 风险（官方 INTEGRATION_GUIDE §14.2 实测 worst
    #   KP drift 8.13 px）。也强制 CPUAndGPU。速度 ~38 ms（vs ANE 默认 20ms 慢
    #   18ms，vs ONNX CPU 108ms 还快 2.8×）。manager.py 同样自动注入。
    # - CLIPIQA/HyperIQA + CoreML(default)：CLIP/HyperNet 架构，无 advanced
    #   indexing，ANE 安全（diff < 0.2px），加速 7-27×。
    # - DINOv3 species v4：torch + MPS bf16 + LoRA/reject adapter，不走 ONNX 路线
    yolo_provider: str = "coreml"
    iqa_provider: str = "coreml"
    pose_provider: str = "coreml"
    # species v4 用 torch + transformers，"auto" 在 Mac 走 MPS bf16，
    # NVIDIA 走 CUDA bf16，否则 CPU fp32（CPU ~500ms，MPS/CUDA ~60ms）
    species_provider: str = "auto"

    # Pipeline — detection (yolo26l-bird v1.1: imgsz=1280, conf=0.5 for photography)
    yolo_confidence: float = 0.5
    yolo_input_size: int = 1280
    # v1.1 继续沿用交付推理代码的后处理阈值：重复框 IoU 通常 >0.95，
    # 正常并排鸟 IoU <0.2；
    # 0.5 可去掉 ghost duplicate，同时保留真实相邻个体。
    yolo_iou_dedup_threshold: float = 0.5

    # Pipeline — crop strategy
    crop_expand_ratio: float = 1.0  # YOLO det bbox expand for IQA/pose input
    crop_padding_ratio: float = 0.10  # extra padding around bbox for downstream models

    # CLIPIQA 专用语义裁切：bbox 同比例放大，让 CLIPIQA 看到"鸟 + 周边构图
    # （背景虚化）"。HyperIQA 不用这张大裁切，而是使用 bbox + padding 的紧主体
    # 技术裁切，避免背景/留白稀释主体锐度判断。
    iqa_expand_ratio: float = 2.5
    iqa_max_aspect_ratio: float = 2.0  # 长边/短边上限，超过则补短边降比例

    # Pipeline — IQA fusion weights
    clipiqa_weight: float = 0.40
    hyperiqa_weight: float = 0.60

    # Pipeline — grading thresholds (reject_max, record_max, usable_max)
    # 2026-04-27 三组实拍校准（new / new1 / new2）后采用较严格口径：
    #   reject < 45.0, record 45.0-59.9, usable 60.0-74.9, select >= 75.0。
    # 注意：实际最终档位还会经过 pose penalty（头不可见 -2 档，眼不可见 -1 档）。
    grade_thresholds: tuple[float, float, float] = (0.45, 0.60, 0.75)

    # Pipeline — pose / visibility (bird_visibility v2.1:11 关键点 + 飞行分类器)
    # box_threshold 作用于 crop 输入下取最高置信度检测。bird_visibility11_config.json
    # 的单鸟校准值是 0.05；实拍遮挡/长尾场景中会出现 box_conf≈0.027 但关键点
    # 置信度很高的可用结果(5Y3A9994)，运行阈值下调到 0.02 避免整条 pose 被吞。
    pose_input_size: int = 640
    pose_box_threshold: float = 0.02
    pose_eye_threshold: float = 0.42
    pose_head_threshold: float = 0.45  # v1 0.35 → v2 0.45(11 kpt 训练后头部判定可更严格)
    pose_head_eye_threshold: float = 0.40  # v1 0.10 → v2 0.40
    pose_body_threshold: float = 0.30  # 新增 v2:躯干 belly/breast/back 任一阈值
    pose_tail_threshold: float = 0.40  # 新增 v2:尾羽阈值
    pose_wing_threshold: float = 0.40  # 新增 v2:翅膀 left/right_wing 任一阈值
    pose_expanded_margin: float = 0.15
    # v2.1 新增 YOLO26m-cls 飞版分类器。输出 P(fly),阈值 0.35 是随包校准的最佳
    # F1 点(precision 94.74%,recall 98.18%,F1 96.43%)。
    flight_classifier_input_size: int = 224
    flight_classifier_threshold: float = 0.35

    # Pipeline — species classification (DINOv3 ViT-L + LoRA/reject adapter)
    species_top_k: int = 5
    species_min_confidence: float = 0.01  # top-K 展示下限；自动结论由 v4 reject policy 决定
    species_crop_margin: float = 0.15  # 方形 bbox 扩展比例（见 MODEL_DELIVERY §6.3）
    species_crop_min_side_frac: float = 0.0  # v4 训练口径不强制最小边长；仅保留 legacy fallback
    # head/eye visibility 不再是触发 gate（v5 放宽）— 所有 grade 通过 species_min_grade
    # 的鸟都跑识别；read-time 会把 reject head 不确定或头部关键特征不完整的识别
    # 标记为 species_source='model_unconfirmed'，用户确认后才进羽迹（HANDOVER §11.2）。
    # 代价：每张多 30-80% 物种推理时间；DINOv3 ~150ms/张。
    species_min_grade: str = "reject"  # "reject" / "record" / "usable" / "select"

    @field_validator("species_min_grade")
    @classmethod
    def _validate_species_min_grade(cls, value: str) -> str:
        """env var PLUMELENS_SPECIES_MIN_GRADE 拼错时提早报错,而非默默放宽 gate。"""
        allowed = {"reject", "record", "usable", "select"}
        if value not in allowed:
            msg = f"species_min_grade must be one of {sorted(allowed)}; got {value!r}"
            raise ValueError(msg)
        return value

    @model_validator(mode="after")
    def _validate_grade_thresholds_monotonic(self) -> Self:
        """grade_thresholds 必须严格递增 (reject<record<usable<select 边界),
        否则 grader 比较逻辑会反向给所有照片 SELECT 档。env var
        PLUMELENS_GRADE_THRESHOLDS 拼错(如 1.0,0.5,0.2)能在启动期被这个验证拦下。"""
        a, b, c = self.grade_thresholds
        if not (0.0 <= a < b < c <= 1.0):
            msg = f"grade_thresholds must be strictly increasing in [0, 1]; got ({a}, {b}, {c})"
            raise ValueError(msg)
        return self

    # Pipeline — preprocess code version (bump manually when resize/normalize/color changes)
    # v2: letterbox fill 0.5 → 114/255 (YOLO standard, matches training)
    # v3: species 切换到 torch v3 单尺度 480×480（之前是 ONNX 双尺度 512+640）+
    #     1535 类（之前 1516）+ trained_mask 重新生成
    # v4: letterbox PIL LANCZOS + int 截断 → cv2 INTER_LINEAR + int(round)，
    #     对齐 MODEL_CARD §5.5 参考实现 → 启用 CoreML EP YOLO 加速时 bbox 不再错位
    # v5: species 触发条件放宽 — 不再要求 head+eye visible，head 不可见也跑识别，
    #     read-time 把这类结果标记为 species_source='model_unconfirmed'
    # v6: species_source 升级为 detection-level（每个 BestDetection / BirdDetectionDetail
    #     都有自己的 species_source）— 多鸟图混合可见性不再被 photo-level 一刀切
    # v7: detector 输出加 IoU dedup — YOLO26 NMS-free 在密集场景仍 over-detect
    #     同一只鸟，bbox 几乎完全重叠的视为 ghost duplicate，保留 conf 最高的
    # v8: species 切换到 v4 384×384 LoRA/reject adapter，1591 类，uncertain 不写入自动物种结论
    # v9: crop_bbox + expand_for_iqa 统一 int(round()) 取代 int() 截断，与 letterbox 对齐;
    #     边角 1-2 px 系统性偏移消除,pose 在边缘鸟头/眼判定 _in_box 时不再误判 not visible
    # v10: YOLO detection dedup 阈值切到交付口径 0.5
    # v11: YOLO detection 权重切到 yolo26l-bird v1.1 fine-tune 版本
    preprocess_version: int = 11

    # Pipeline — concurrency
    # 每个 task 内部 ONNX 推理会 to_thread 释放 GIL，多 worker 并发 = 多张图同时跑 ONNX。
    # CoreML EP 多 session 共享 ANE/GPU 资源，并发 2 ≈ 1.5-1.8× 吞吐（不是线性）。
    analysis_concurrency: int = 2
    # 全局 asyncio.to_thread 默认线程池大小。RAW probe / 缩略图 / 哈希 / 推理外围
    # 都会走这个池；显式设上限避免 Python 默认 min(32, cpu+4) 在大库导入时
    # 同时拉起过多 RAW 解码和文件 I/O。
    worker_threads: int = 8

    # Pipeline — strict 模式：IQA 模型缺失/加载失败时拒绝启动。
    # 默认 False 给开发期友好（模型还没下载也能跑出 detection-only 结果）；
    # packaged 应用由 process-manager 注入 PLUMELENS_REQUIRE_IQA=1，
    # 防止用户拿到伪造的中性 0.5 分（grade 全部被打成 USABLE）。
    # IQA 是当前唯一的 "silent fallback"：YOLO/species 缺失会有明显症状，
    # 但 IQA 缺失会让所有照片打成可用，用户感知不到模型已经丢了。
    require_iqa: bool = False


settings = Settings()
