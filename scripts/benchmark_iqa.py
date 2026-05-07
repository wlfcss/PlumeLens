"""仅重跑 IQA — 复用 db 里已存的 bbox，对照新旧 crop 策略下的分数分布。

用法：
    uv run python scripts/benchmark_iqa.py /path/to/images_root

逻辑：
- 从 db 读所有 active analysis_results（含 bbox），按 file_path 找原图
- 对每张图、每个 bbox：
  * 旧裁切：bbox + 10% padding（与之前 manager.py 行为一致）
  * 新裁切：expand_for_iqa(2.5×, max_ratio=2.0)
- 用同一对 IQA ONNX 模型分别打分，输出对比统计
"""

from __future__ import annotations

import collections
import json
import sqlite3
import sys
from pathlib import Path
from statistics import mean, median

import onnxruntime as ort

# 确保能 import engine
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine.pipeline.preprocess import crop_bbox, expand_for_iqa, load_image  # noqa: E402
from engine.pipeline.quality import QualityAssessor  # noqa: E402

DB_PATH = Path("/Users/wlfcss/Library/Application Support/plumelens/plumelens.db")
MODELS_DIR = ROOT / "engine" / "models"


def load_iqa() -> QualityAssessor:
    so = ort.SessionOptions()
    clipiqa = ort.InferenceSession(
        str(MODELS_DIR / "clipiqa_plus.onnx"),
        so,
        providers=["CPUExecutionProvider"],
    )
    hyperiqa = ort.InferenceSession(
        str(MODELS_DIR / "hyperiqa.onnx"),
        so,
        providers=["CPUExecutionProvider"],
    )
    return QualityAssessor(clipiqa, hyperiqa, clipiqa_weight=0.35, hyperiqa_weight=0.65)


def hist_summary(name: str, scores: list[float]) -> None:
    if not scores:
        print(f"{name}: 没数据")
        return
    print(f"\n=== {name}（n={len(scores)}） ===")
    s = sorted(scores)
    print(
        f"  min={s[0]:.3f}  median={s[len(s)//2]:.3f}  "
        f"mean={mean(scores):.3f}  max={s[-1]:.3f}"
    )
    buckets: dict[float, int] = collections.Counter()
    for x in scores:
        b = int(x * 10) / 10
        buckets[b] += 1
    for b in sorted(buckets):
        bar = "#" * (buckets[b] // 10)
        print(f"  [{b:.1f}, {b+0.1:.1f}): {buckets[b]:4}  {bar}")


def main(library_root: str | None) -> None:
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    where = ""
    params: tuple = ()
    if library_root:
        where = "AND p.file_path LIKE ?"
        params = (f"{library_root}%",)

    rows = db.execute(
        f"""
        SELECT p.id AS photo_id, p.file_path, ar.result_json
        FROM analysis_results ar JOIN photos p ON ar.photo_id = p.id
        WHERE ar.is_active = 1 {where}
        """,
        params,
    ).fetchall()
    print(f"待处理: {len(rows)} 张")
    if not rows:
        return

    iqa = load_iqa()

    old_clip: list[float] = []
    old_hyper: list[float] = []
    old_combined: list[float] = []
    new_clip: list[float] = []
    new_hyper: list[float] = []
    new_combined: list[float] = []
    failed = 0
    pad_ratio = 0.10
    expand_ratio = 2.5
    max_aspect_ratio = 2.0

    for i, row in enumerate(rows):
        path = Path(row["file_path"])
        try:
            data = json.loads(row["result_json"])
            best = data.get("best")
            if not best:
                continue
            bbox = best["bbox"]
            x1, y1, x2, y2 = bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]

            image = load_image(path)
            h, w = image.shape[:2]

            # 旧 crop（pose-style 紧裁切，复用之前 IQA 路径）
            bw, bh = x2 - x1, y2 - y1
            px = bw * pad_ratio
            py = bh * pad_ratio
            old_x1 = max(0.0, x1 - px)
            old_y1 = max(0.0, y1 - py)
            old_x2 = min(float(w), x2 + px)
            old_y2 = min(float(h), y2 + py)
            old_crop = crop_bbox(image, old_x1, old_y1, old_x2, old_y2, expand_ratio=1.0)

            # 新 crop（expand_for_iqa）
            new_crop = expand_for_iqa(
                image,
                x1,
                y1,
                x2,
                y2,
                expand=expand_ratio,
                max_aspect_ratio=max_aspect_ratio,
            )

            # 双跑 IQA
            old_scores = iqa.assess(old_crop)
            new_scores = iqa.assess(new_crop)

            old_clip.append(old_scores.clipiqa)
            old_hyper.append(old_scores.hyperiqa)
            old_combined.append(old_scores.combined)
            new_clip.append(new_scores.clipiqa)
            new_hyper.append(new_scores.hyperiqa)
            new_combined.append(new_scores.combined)
        except Exception as e:
            failed += 1
            print(f"  [skip] {path.name}: {e}")
            continue

        if (i + 1) % 50 == 0:
            print(f"  进度 {i+1}/{len(rows)}（失败 {failed}）")

    print(f"\n完成 {len(new_combined)} 张  失败 {failed} 张")

    print("\n##################  旧 crop（bbox + 10% padding） ##################")
    hist_summary("CLIPIQA+", old_clip)
    hist_summary("HyperIQA", old_hyper)
    hist_summary("combined", old_combined)

    print("\n##################  新 crop（bbox × 2.5，max ratio 2.0） ##################")
    hist_summary("CLIPIQA+", new_clip)
    hist_summary("HyperIQA", new_hyper)
    hist_summary("combined", new_combined)

    # 配对差异（同一张图新-旧）
    if old_combined and new_combined:
        diffs = [n - o for o, n in zip(old_combined, new_combined, strict=True)]
        diffs_clip = [n - o for o, n in zip(old_clip, new_clip, strict=True)]
        diffs_hyper = [n - o for o, n in zip(old_hyper, new_hyper, strict=True)]
        print("\n##################  Δ = 新 - 旧（配对差） ##################")
        print(f"  CLIPIQA Δ:   median={median(diffs_clip):+.3f}  mean={mean(diffs_clip):+.3f}")
        print(f"  HyperIQA Δ:  median={median(diffs_hyper):+.3f}  mean={mean(diffs_hyper):+.3f}")
        print(f"  combined Δ:  median={median(diffs):+.3f}  mean={mean(diffs):+.3f}")
        print(f"  分数下降的张数: {sum(1 for d in diffs if d < 0)} / {len(diffs)}")
        print(f"  分数上升的张数: {sum(1 for d in diffs if d > 0)} / {len(diffs)}")

    # 多套阈值在新 combined 分布上的分档结果
    if new_combined:
        thresholds_set = [
            ("当前 default (0.33, 0.43, 0.60)", (0.33, 0.43, 0.60)),
            ("已改 (0.20, 0.45, 0.85)", (0.20, 0.45, 0.85)),
            ("严苛 (0.30, 0.55, 0.85)", (0.30, 0.55, 0.85)),
            ("更严 (0.40, 0.60, 0.85)", (0.40, 0.60, 0.85)),
            ("超严 (0.50, 0.65, 0.88)", (0.50, 0.65, 0.88)),
        ]
        print("\n##################  分档规则在 新 combined 上的分布 ##################")
        print(
            f"  combined 分布：min={min(new_combined):.3f} "
            f"median={median(new_combined):.3f} mean={mean(new_combined):.3f} "
            f"max={max(new_combined):.3f}"
        )
        n = len(new_combined)
        print(f"\n{'阈值组':<35} {'reject':>10} {'record':>10} {'usable':>10} {'select':>10}")
        print("-" * 80)
        for name, (rmax, recmax, usmax) in thresholds_set:
            reject = sum(1 for s in new_combined if s < rmax)
            record = sum(1 for s in new_combined if rmax <= s < recmax)
            usable = sum(1 for s in new_combined if recmax <= s < usmax)
            select = sum(1 for s in new_combined if s >= usmax)
            print(
                f"{name:<35} {reject:>4} ({100 * reject / n:>3.0f}%) "
                f"{record:>4} ({100 * record / n:>3.0f}%) "
                f"{usable:>4} ({100 * usable / n:>3.0f}%) "
                f"{select:>4} ({100 * select / n:>3.0f}%)"
            )


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    main(arg)
