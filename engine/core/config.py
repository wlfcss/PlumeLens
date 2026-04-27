"""Application configuration via Pydantic Settings."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PLUMELENS_")

    # Server
    host: str = "127.0.0.1"
    port: int = 0
    log_level: str = "INFO"
    data_dir: Path = Path.home() / ".plumelens"

    # Pipeline — model files
    models_dir: Path = Path(__file__).resolve().parent.parent / "models"

    # Pipeline — execution providers ("auto" / "coreml" / "cuda" / "cpu")
    # macOS onnxruntime 1.25 实测（2026-04-27 更新）：
    # - YOLO + CoreML(CPUAndGPU)：**正确 + 3.5× 加速**。
    #   关键发现：bbox 越界的根因是 ANE（Apple Neural Engine）对 advanced indexing
    #   的精度实现有 bug，不是整个 CoreML EP 的问题。`MLComputeUnits='CPUAndGPU'`
    #   关 ANE 只走 Metal GPU + CPU 兜底，bbox 与 CPU EP 一致到 0.1px，速度 ~112ms
    #   （vs CPU EP ~395ms）。manager.py::resolve_providers 会自动给 YOLO 注入
    #   该选项，pose/IQA 不需要（用 ANE 没问题）。
    # - bird_visibility/CLIPIQA/HyperIQA + CoreML(default)：100% 安全 + 加速 7-27×
    # - DINOv3 species v3：转 torch + MPS bf16，不再走 ONNX 路线
    yolo_provider: str = "coreml"
    iqa_provider: str = "coreml"
    pose_provider: str = "coreml"
    # species v3 用 torch + transformers，"auto" 在 Mac 走 MPS bf16，
    # NVIDIA 走 CUDA bf16，否则 CPU fp32（CPU ~500ms，MPS/CUDA ~60ms）
    species_provider: str = "auto"

    # Pipeline — detection (yolo26l-bird v1.0: imgsz=1280, conf=0.5 for photography)
    yolo_confidence: float = 0.5
    yolo_input_size: int = 1280

    # Pipeline — crop strategy
    crop_expand_ratio: float = 1.0  # YOLO det bbox expand for IQA/pose input
    crop_padding_ratio: float = 0.10  # extra padding around bbox for downstream models

    # IQA 专用裁切：bbox 同比例放大，让 IQA 看到"鸟 + 周边构图（背景虚化）"
    # 之前用 crop_padding_ratio=0.10 紧裁切，IQA 看到的几乎只剩鸟特写 → HyperIQA
    # 在精修鸟摄上饱和打高分（mean=0.895，33% 触顶 1.0）。改成大裁切让 IQA
    # 评估完整构图（前景/背景/虚实/梯度），更符合鸟摄美学评判。
    iqa_expand_ratio: float = 2.5
    iqa_max_aspect_ratio: float = 2.0  # 长边/短边上限，超过则补短边降比例

    # Pipeline — IQA fusion weights
    clipiqa_weight: float = 0.35
    hyperiqa_weight: float = 0.65

    # Pipeline — grading thresholds (reject_max, record_max, usable_max)
    # 实测调优（new1+new2 ~1800 张）：
    #   - IQA 单独：精修连拍数据 select 80-90% 失真
    #   - + expand_for_iqa(2.5×) 大裁切：select ~13-16%（看到完整构图）
    #   - + apply_pose_penalty（头不见 -2 / 眼不见 -1）：select 8-14%，reject 5-18%
    # 当前阈值 + pose 降档在两个数据集的 select 比例都落在 8-14% 摄影师选片合理区间。
    grade_thresholds: tuple[float, float, float] = (0.20, 0.45, 0.85)

    # Pipeline — pose / visibility (bird_visibility v1.0)
    # box_threshold 作用于 crop 输入下取最高置信度检测，不作过滤
    pose_input_size: int = 640
    pose_box_threshold: float = 0.05
    pose_eye_threshold: float = 0.45
    pose_head_threshold: float = 0.35
    pose_head_eye_threshold: float = 0.10
    pose_expanded_margin: float = 0.15

    # Pipeline — species classification (DINOv3 ViT-L + 7-head ensemble)
    species_top_k: int = 5
    species_min_confidence: float = 0.01  # 过滤 1018 训练种之外的噪声命中
    species_crop_margin: float = 0.15  # 方形 bbox 扩展比例（见 MODEL_DELIVERY §6.3）
    species_crop_min_side_frac: float = 0.30  # 方形最小边长占原图短边的比例
    # 只对 head+eye 可见的鸟触发物种分类。grade 门已去掉（"reject" 即所有
    # 等级都跑），让低分但鸟头/眼清晰的照片也能拿到物种名 — 用户明确选择最宽松。
    # 代价：每张多 30-80% 物种推理时间；DINOv3 ~150ms/张。
    species_min_grade: str = "reject"  # "reject" / "record" / "usable" / "select"

    # Pipeline — preprocess code version (bump manually when resize/normalize/color changes)
    # v2: letterbox fill 0.5 → 114/255 (YOLO standard, matches training)
    # v3: species 切换到 torch v3 单尺度 480×480（之前是 ONNX 双尺度 512+640）+
    #     1535 类（之前 1516）+ trained_mask 重新生成
    # v4: letterbox PIL LANCZOS + int 截断 → cv2 INTER_LINEAR + int(round)，
    #     对齐 MODEL_CARD §5.5 参考实现 → 启用 CoreML EP YOLO 加速时 bbox 不再错位
    preprocess_version: int = 4

    # Pipeline — concurrency
    # 每个 task 内部 ONNX 推理会 to_thread 释放 GIL，多 worker 并发 = 多张图同时跑 ONNX。
    # CoreML EP 多 session 共享 ANE/GPU 资源，并发 2 ≈ 1.5-1.8× 吞吐（不是线性）。
    analysis_concurrency: int = 2


settings = Settings()
