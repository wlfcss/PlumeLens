"""完整管线 benchmark（YOLO + pose + IQA + pose 降档）— 跑指定文件夹的所有图。

用法:
    uv run python scripts/benchmark_full.py /path/to/folder

不写 db，只统计分布。
"""

from __future__ import annotations

import collections
import statistics
import sys
import time
from pathlib import Path

import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine.pipeline.detector import BirdDetector  # noqa: E402
from engine.pipeline.grader import (  # noqa: E402
    apply_pose_penalty,
    grade,
)
from engine.pipeline.models import QualityGrade  # noqa: E402
from engine.pipeline.pose import PoseDetector  # noqa: E402
from engine.pipeline.preprocess import (  # noqa: E402
    SUPPORTED_EXTENSIONS,
    crop_bbox,
    expand_for_iqa,
    load_image,
)
from engine.pipeline.quality import QualityAssessor  # noqa: E402

MODELS_DIR = ROOT / "engine" / "models"
EXPAND_RATIO = 2.5
MAX_ASPECT_RATIO = 2.0
PADDING_RATIO = 0.10  # pose 紧裁切

# 多套阈值
THRESHOLDS_SET = [
    ("当前 default (0.33, 0.43, 0.60)", (0.33, 0.43, 0.60)),
    ("已改 (0.20, 0.45, 0.85)", (0.20, 0.45, 0.85)),
    ("严苛 (0.30, 0.55, 0.85)", (0.30, 0.55, 0.85)),
    ("超严 (0.50, 0.65, 0.88)", (0.50, 0.65, 0.88)),
]


def make_session(path: Path) -> ort.InferenceSession:
    so = ort.SessionOptions()
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def hist(name: str, scores: list[float]) -> None:
    if not scores:
        print(f"{name}: 无")
        return
    s = sorted(scores)
    print(f"\n=== {name}（n={len(scores)}） ===")
    print(
        f"  min={s[0]:.3f}  median={s[len(s)//2]:.3f}  "
        f"mean={statistics.mean(scores):.3f}  max={s[-1]:.3f}"
    )
    buckets: dict[float, int] = collections.Counter()
    for x in scores:
        b = int(x * 10) / 10
        buckets[b] += 1
    for b in sorted(buckets):
        bar = "#" * (buckets[b] // (max(1, len(scores) // 100)))
        print(f"  [{b:.1f}, {b+0.1:.1f}): {buckets[b]:4}  {bar}")


def grade_label(g: QualityGrade) -> str:
    return g.value


def pct(value: int, total: int) -> str:
    return f"{100 * value / total:.0f}%" if total else "-"


def main(folder: str) -> None:
    root = Path(folder)
    files = sorted(p for p in root.rglob("*") if p.suffix.lower() in SUPPORTED_EXTENSIONS)
    print(f"扫到 {len(files)} 张")
    if not files:
        return

    print("加载模型...")
    detector = BirdDetector(
        make_session(MODELS_DIR / "yolo26l-bird-det.onnx"), input_size=1280,
    )
    pose = PoseDetector(make_session(MODELS_DIR / "bird_visibility11.onnx"), input_size=640)
    iqa = QualityAssessor(
        make_session(MODELS_DIR / "clipiqa_plus.onnx"),
        make_session(MODELS_DIR / "hyperiqa.onnx"),
        clipiqa_weight=0.40,
        hyperiqa_weight=0.60,
    )
    print("模型加载完成")

    # 收集统计
    n_no_bird = 0
    n_failed = 0
    bird_counts: list[int] = []
    clip_scores: list[float] = []
    hyper_scores: list[float] = []
    combined_scores: list[float] = []
    head_visible_n = 0
    eye_visible_n = 0
    no_pose_n = 0
    # 每个 (thresholds_name) → grade_counter
    grade_dist_iqa_only: dict[str, collections.Counter[str]] = {
        name: collections.Counter() for name, _ in THRESHOLDS_SET
    }
    grade_dist_with_pose: dict[str, collections.Counter[str]] = {
        name: collections.Counter() for name, _ in THRESHOLDS_SET
    }

    start_t = time.time()
    for i, path in enumerate(files):
        try:
            image = load_image(path)
            boxes = detector.detect(image, confidence_threshold=0.5)
            if not boxes:
                n_no_bird += 1
                # 无鸟 → 都标 reject（前端 UI 会单独处理 bird_count=0）
                for name, _ in THRESHOLDS_SET:
                    grade_dist_iqa_only[name]["no_bird"] += 1
                    grade_dist_with_pose[name]["no_bird"] += 1
                continue

            # 选最大 bbox（粗略对应 best 鸟）
            box = max(boxes, key=lambda b: (b.x2 - b.x1) * (b.y2 - b.y1))
            bird_counts.append(len(boxes))
            H, W = image.shape[:2]

            # IQA: 大裁切
            iqa_crop = expand_for_iqa(
                image,
                box.x1,
                box.y1,
                box.x2,
                box.y2,
                expand=EXPAND_RATIO,
                max_aspect_ratio=MAX_ASPECT_RATIO,
            )
            iqa_scores = iqa.assess(iqa_crop)
            clip_scores.append(iqa_scores.clipiqa)
            hyper_scores.append(iqa_scores.hyperiqa)
            combined_scores.append(iqa_scores.combined)

            # Pose: 紧裁切
            bw = box.x2 - box.x1
            bh = box.y2 - box.y1
            px = bw * PADDING_RATIO
            py = bh * PADDING_RATIO
            pad_x1 = max(0.0, box.x1 - px)
            pad_y1 = max(0.0, box.y1 - py)
            pad_x2 = min(float(W), box.x2 + px)
            pad_y2 = min(float(H), box.y2 + py)
            pose_crop = crop_bbox(image, pad_x1, pad_y1, pad_x2, pad_y2, expand_ratio=1.0)

            try:
                pose_info = pose.detect(pose_crop, crop_origin=(pad_x1, pad_y1))
            except Exception:
                pose_info = None

            if pose_info is None:
                no_pose_n += 1
            else:
                if pose_info.head_visible:
                    head_visible_n += 1
                if pose_info.eye_visible:
                    eye_visible_n += 1

            # 各阈值下的 grade
            for name, th in THRESHOLDS_SET:
                g_iqa = grade(iqa_scores.combined, th)
                g_final = apply_pose_penalty(g_iqa, pose_info)
                grade_dist_iqa_only[name][grade_label(g_iqa)] += 1
                grade_dist_with_pose[name][grade_label(g_final)] += 1

        except Exception as e:
            n_failed += 1
            print(f"  [skip] {path.name}: {e}")
            continue

        if (i + 1) % 100 == 0:
            elapsed = time.time() - start_t
            rate = (i + 1) / elapsed
            eta = (len(files) - i - 1) / rate
            print(f"  {i+1}/{len(files)}  [{rate:.1f} img/s, ETA {eta/60:.1f} min]")

    print(
        f"\n完成 {len(combined_scores)} 张  |  无鸟 {n_no_bird}  |  "
        f"失败 {n_failed}  |  总耗时 {(time.time() - start_t) / 60:.1f} min"
    )

    # === IQA 分布 ===
    print("\n" + "#" * 70)
    print("# IQA 分布（new crop expand 2.5×）")
    print("#" * 70)
    hist("CLIPIQA+", clip_scores)
    hist("HyperIQA", hyper_scores)
    hist("combined (0.35*CLIP + 0.65*Hyper)", combined_scores)

    # === 姿态统计 ===
    print("\n" + "#" * 70)
    print("# 姿态可见性")
    print("#" * 70)
    n_pose_total = len(combined_scores) - no_pose_n
    if n_pose_total > 0:
        print(f"  has pose:        {n_pose_total} ({100*n_pose_total/len(combined_scores):.1f}%)")
        print(
            f"  head_visible:    {head_visible_n} "
            f"({100 * head_visible_n / n_pose_total:.1f}% of with-pose)"
        )
        print(f"  eye_visible:     {eye_visible_n} ({100*eye_visible_n/n_pose_total:.1f}%)")
    print(f"  no pose result:  {no_pose_n}")

    # === 分档对比 ===
    n_total = len(files) - n_failed
    print("\n" + "#" * 70)
    print(f"# 分档分布（n={n_total}，含 {n_no_bird} 张 no_bird）")
    print("#" * 70)

    for name, _ in THRESHOLDS_SET:
        print(f"\n{name}")
        print(
            f"  {'':<22}  {'reject':>10} {'record':>10} {'usable':>10} "
            f"{'select':>10} {'no_bird':>10}"
        )
        for label, dist in [
            ("仅 IQA", grade_dist_iqa_only[name]),
            ("IQA+pose 降档", grade_dist_with_pose[name]),
        ]:
            r = dist.get("reject", 0)
            rc = dist.get("record", 0)
            us = dist.get("usable", 0)
            sel = dist.get("select", 0)
            nb = dist.get("no_bird", 0)
            tot = r + rc + us + sel + nb
            print(
                f"  {label:<22}  {r:>4} ({pct(r, tot):>4}) "
                f"{rc:>4} ({pct(rc, tot):>4}) {us:>4} ({pct(us, tot):>4}) "
                f"{sel:>4} ({pct(sel, tot):>4}) {nb:>4} ({pct(nb, tot):>4})"
            )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: benchmark_full.py /path/to/folder")
        sys.exit(1)
    main(sys.argv[1])
