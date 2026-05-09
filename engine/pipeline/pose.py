# pyright: basic
"""Bird full-body pose + visibility via bird_visibility v2.0 + flight classifier v1."""

from __future__ import annotations

from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from engine.pipeline.models import Keypoint, PoseInfo
from engine.pipeline.preprocess import resize_letterbox, to_batch, to_chw

# Type alias for ONNX InferenceSession (avoid import at module level for testability)
OrtSession: TypeAlias = object  # onnxruntime.InferenceSession

# 关键点顺序固定(NABirds v2.0):头部 5 + 躯干 6 = 11
# flip_idx = [0, 1, 2, 4, 3, 5, 6, 7, 8, 10, 9]
PART_NAMES: tuple[str, ...] = (
    "bill",
    "crown",
    "nape",
    "left_eye",
    "right_eye",
    "belly",
    "breast",
    "back",
    "tail",
    "left_wing",
    "right_wing",
)
HEAD_PARTS: tuple[str, ...] = ("bill", "crown", "nape")
EYE_PARTS: tuple[str, ...] = ("left_eye", "right_eye")
BODY_PARTS: tuple[str, ...] = ("belly", "breast", "back")
WING_PARTS: tuple[str, ...] = ("left_wing", "right_wing")
TAIL_PART: str = "tail"

FLIGHT_CLASSIFIER_VERSION: str = "v1-yolo26m-cls-superflier"
POSTURE_HEURISTIC_VERSION: str = "v3-strict-side-open-wing"
DEFAULT_FLIGHT_CLASSIFIER_INPUT_SIZE = 224
DEFAULT_FLIGHT_CLASSIFIER_THRESHOLD = 0.35
_POSTURE_MIN_BBOX_WIDTH = 32.0
_POSTURE_WIDE_ASPECT_THRESHOLD = 1.3
_POSTURE_PERCHED_ASPECT_THRESHOLD = 1.05
_POSTURE_WING_SPAN_RATIO_THRESHOLD = 0.5
_POSTURE_OPEN_WING_MIN_ASPECT = 0.75
_POSTURE_OPEN_WING_MAX_ASPECT = 1.45
_POSTURE_OPEN_WING_STRONG_CONF = 0.75
_POSTURE_OPEN_WING_OPPOSITE_MIN_CONF = 0.20
_POSTURE_OPEN_WING_MIN_SPAN_RATIO = 0.15
_POSTURE_OPEN_WING_MAX_CORE_WIDTH_RATIO = 0.35
_POSTURE_OPEN_WING_MAX_TAIL_LATERAL_RATIO = 0.32
_POSTURE_OPEN_WING_OVERHANG_RATIO = 0.08
_POSTURE_OPEN_WING_MIN_OVERHANG = 8.0
_POSTURE_OPEN_WING_BODY_Y_MARGIN_RATIO = 0.10

# v2 ONNX 输出每检测槽位 39 维:
#   [0..3]   bbox xyxy
#   [4]      box_conf
#   [5]      cls(始终 0,只有 bird 一类)
#   [6..38]  11 keypoints × 3 (x, y, conf)
_DET_FIELDS: int = 6
_KPT_FIELDS: int = 3 * len(PART_NAMES)  # 33
_ROW_WIDTH: int = _DET_FIELDS + _KPT_FIELDS  # 39


class FlightClassifier:
    """Raw ONNX wrapper for bird_flight_classifier.onnx.

    The v2.1 posture pipeline separates flight detection into this dedicated
    YOLO26m-cls model. Its ONNX output is already a probability vector
    `[P(fly), P(nofly)]`; preprocessing follows
    Ultralytics 8.4.47 classification inference: resize shortest edge to 224,
    center-crop 224×224, RGB float 0-1, CHW.
    """

    def __init__(
        self,
        session: OrtSession,
        input_size: int = DEFAULT_FLIGHT_CLASSIFIER_INPUT_SIZE,
        threshold: float = DEFAULT_FLIGHT_CLASSIFIER_THRESHOLD,
    ) -> None:
        self._session = session
        self._input_size = input_size
        self._threshold = threshold
        self._input_name: str = session.get_inputs()[0].name  # type: ignore[union-attr]
        self._output_name: str = session.get_outputs()[0].name  # type: ignore[union-attr]

    @property
    def threshold(self) -> float:
        return self._threshold

    def classify(self, crop_image: NDArray[np.float32]) -> tuple[str, float, str] | None:
        """Return (posture, P(fly), method) or None if classifier output is unusable."""
        if crop_image.size == 0:
            return None

        input_tensor = self._preprocess(crop_image)
        outputs = self._session.run(  # type: ignore[union-attr]
            [self._output_name],
            {self._input_name: input_tensor},
        )
        probs = np.asarray(outputs[0], dtype=np.float32)
        if probs.ndim == 2:
            probs = probs[0]
        if probs.shape[0] < 2:
            return None
        probs = self._as_probability_vector(probs)
        if probs is None:
            return None

        fly_prob = float(probs[0])
        if not np.isfinite(fly_prob):
            return None
        fly_prob = min(1.0, max(0.0, fly_prob))
        posture = "flying" if fly_prob >= self._threshold else "perched"
        return posture, fly_prob, "classifier"

    @staticmethod
    def _as_probability_vector(values: NDArray[np.float32]) -> NDArray[np.float32] | None:
        if not np.all(np.isfinite(values)):
            return None
        if np.all((values >= 0.0) & (values <= 1.0)) and np.isclose(
            float(np.sum(values)), 1.0, atol=1e-3
        ):
            return values
        shifted = values - np.max(values)
        exp = np.exp(shifted)
        total = float(np.sum(exp))
        if not np.isfinite(total) or total <= 0:
            return None
        return np.asarray(exp / total, dtype=np.float32)

    def _preprocess(self, crop_image: NDArray[np.float32]) -> NDArray[np.float32]:
        """Mimic Ultralytics classify_transforms(size=224, mean=0, std=1)."""
        if crop_image.ndim != 3 or crop_image.shape[2] != 3:
            msg = f"flight classifier expects RGB HWC image, got shape={crop_image.shape}"
            raise ValueError(msg)

        arr = np.asarray(crop_image)
        if np.issubdtype(arr.dtype, np.floating):
            arr_u8 = np.clip(arr, 0.0, 1.0)
            arr_u8 = np.rint(arr_u8 * 255.0).astype(np.uint8)
        else:
            arr_u8 = np.clip(arr, 0, 255).astype(np.uint8)

        image = Image.fromarray(arr_u8)
        width, height = image.size
        if width <= 0 or height <= 0:
            msg = f"invalid flight classifier crop size: {width}x{height}"
            raise ValueError(msg)

        size = self._input_size
        if width < height:
            new_width = size
            new_height = max(size, int(round(height * size / width)))
        else:
            new_height = size
            new_width = max(size, int(round(width * size / height)))

        resampling = Image.Resampling.BILINEAR
        resized = image.resize((new_width, new_height), resampling)
        left = max(0, (new_width - size) // 2)
        top = max(0, (new_height - size) // 2)
        cropped = resized.crop((left, top, left + size, top + size))

        tensor = np.asarray(cropped, dtype=np.float32) / 255.0
        tensor = tensor.transpose(2, 0, 1)[np.newaxis, ...]
        return np.ascontiguousarray(tensor, dtype=np.float32)


class PoseDetector:
    """Wraps bird_visibility11.onnx for full-body keypoint + posture detection.

    Model:
      - bird_visibility11.onnx: bird_visibility v2.0, YOLO26l-pose 11 关键点
      - optional bird_flight_classifier.onnx: v1 YOLO26m-cls fly/nofly

    Input:  float32 [1, 3, 640, 640] RGB 0-1, letterbox 114/255 填充
    Output: float32 [1, 300, 39] top-k 槽位

    用法(crop 输入,与 v1 保持兼容签名):
        pose_info = pose_detector.detect(
            crop_image,              # YOLO det 的 bbox 裁切(含 padding)
            crop_origin=(x0, y0),    # crop 在原图中左上角坐标(用于关键点还原)
        )

    决策规则与阈值默认值见 bird_visibility11_config.json 的 best_* 校准段。
    """

    def __init__(
        self,
        session: OrtSession,
        input_size: int = 640,
        # crop 输入下 box_threshold 只用于"取最高置信度检测"后的低置信保护;
        # 产品默认 0.02。单鸟校准值 0.05 在遮挡长尾实拍里会吞掉可用关键点。
        box_threshold: float = 0.02,
        eye_threshold: float = 0.45,
        head_threshold: float = 0.45,
        head_eye_threshold: float = 0.40,
        body_threshold: float = 0.30,
        tail_threshold: float = 0.40,
        wing_threshold: float = 0.40,
        expanded_box_margin: float = 0.15,
        flight_classifier: FlightClassifier | None = None,
    ) -> None:
        self._session = session
        self._input_size = input_size
        self._box_threshold = box_threshold
        self._eye_threshold = eye_threshold
        self._head_threshold = head_threshold
        self._head_eye_threshold = head_eye_threshold
        self._body_threshold = body_threshold
        self._tail_threshold = tail_threshold
        self._wing_threshold = wing_threshold
        self._margin = expanded_box_margin
        self._flight_classifier = flight_classifier
        # Cache input/output names
        self._input_name: str = session.get_inputs()[0].name  # type: ignore[union-attr]
        self._output_name: str = session.get_outputs()[0].name  # type: ignore[union-attr]

    def detect(
        self,
        crop_image: NDArray[np.float32],
        crop_origin: tuple[float, float] = (0.0, 0.0),
    ) -> PoseInfo | None:
        """Run pose detection on a single-bird crop, return full PoseInfo or None.

        Args:
            crop_image: Pre-cropped image [H, W, 3] float32 0-1
                (由上游 YOLO det 按 bbox 裁切出的单鸟区域)。
            crop_origin: crop 在原图中左上角坐标 (x0, y0);用于把关键点还原到原图。

        Returns:
            PoseInfo(11 keypoints + 5 visibility + 3 posture);若无有效检测返回 None。
        """
        # Preprocess: letterbox to 640 → CHW → batch
        letterboxed, scale, (pad_top, pad_left) = resize_letterbox(crop_image, self._input_size)
        input_tensor = to_batch(to_chw(letterboxed))

        outputs = self._session.run(  # type: ignore[union-attr]
            [self._output_name],
            {self._input_name: input_tensor},
        )
        # shape: [1, 300, 39]
        raw: NDArray[np.float32] = outputs[0][0]  # [300, 39]

        if raw.shape[0] == 0 or raw.shape[1] != _ROW_WIDTH:
            return None
        best_idx = int(np.argmax(raw[:, 4]))
        det = raw[best_idx]
        box_conf = float(det[4])
        if box_conf < self._box_threshold:
            return None

        # 解析 bbox(letterbox 坐标系)
        bx1, by1, bx2, by2 = float(det[0]), float(det[1]), float(det[2]), float(det[3])

        # 解析 11 个关键点(letterbox 坐标系)
        kpt_raw = det[_DET_FIELDS:_ROW_WIDTH].reshape(len(PART_NAMES), 3)

        # 准备 letterbox→crop 的逆变换 + crop→原图位移
        crop_x0, crop_y0 = crop_origin

        def _to_crop(lx: float, ly: float) -> tuple[float, float]:
            return (lx - pad_left) / scale, (ly - pad_top) / scale

        # 原图坐标系(用户/UI 看到的,BirdAnalysis.pose 里的)
        kpts_by_name: dict[str, Keypoint] = {}
        # crop 坐标系(decision 用,与 bbox 同一空间)
        kpts_crop: dict[str, tuple[float, float, float]] = {}
        for i, name in enumerate(PART_NAMES):
            lx, ly, kc = float(kpt_raw[i][0]), float(kpt_raw[i][1]), float(kpt_raw[i][2])
            cx, cy = _to_crop(lx, ly)
            kpts_crop[name] = (cx, cy, kc)
            kpts_by_name[name] = Keypoint(x=cx + crop_x0, y=cy + crop_y0, confidence=kc)

        # bbox 转到 crop 空间(decision 在此空间内进行)
        cb_x1, cb_y1 = _to_crop(bx1, by1)
        cb_x2, cb_y2 = _to_crop(bx2, by2)
        bbox_crop = (cb_x1, cb_y1, cb_x2, cb_y2)

        head_v, eye_v, body_v, tail_v, wings_v = self._judge_visibility(bbox_crop, kpts_crop)
        view_angle = self._derive_view_angle(bbox_crop, kpts_crop)
        facing = self._derive_facing(view_angle, kpts_crop)
        posture, posture_confidence, posture_method = self._derive_posture_with_classifier(
            crop_image,
            bbox_crop,
            kpts_crop,
        )

        return PoseInfo(
            bill=kpts_by_name["bill"],
            crown=kpts_by_name["crown"],
            nape=kpts_by_name["nape"],
            left_eye=kpts_by_name["left_eye"],
            right_eye=kpts_by_name["right_eye"],
            belly=kpts_by_name["belly"],
            breast=kpts_by_name["breast"],
            back=kpts_by_name["back"],
            tail=kpts_by_name["tail"],
            left_wing=kpts_by_name["left_wing"],
            right_wing=kpts_by_name["right_wing"],
            head_visible=head_v,
            eye_visible=eye_v,
            body_visible=body_v,
            tail_visible=tail_v,
            wings_visible=wings_v,
            view_angle=view_angle,
            facing=facing,
            posture=posture,
            posture_confidence=posture_confidence,
            posture_method=posture_method,
        )

    # ------------------------------------------------------------------
    # 决策规则
    # ------------------------------------------------------------------

    def _in_box(
        self,
        xy: tuple[float, float],
        bbox: tuple[float, float, float, float],
    ) -> bool:
        x1, y1, x2, y2 = bbox
        w = max(1e-6, x2 - x1)
        h = max(1e-6, y2 - y1)
        x, y = xy
        mx, my = self._margin * w, self._margin * h
        return x1 - mx <= x <= x2 + mx and y1 - my <= y <= y2 + my

    def _judge_visibility(
        self,
        bbox: tuple[float, float, float, float],
        kpts: dict[str, tuple[float, float, float]],
    ) -> tuple[bool, bool, bool, bool, bool]:
        """5 项可见性判定。规则与 v2 detector.py 对齐(见 INTEGRATION_GUIDE §3.1)。"""

        def kpt_in_box_with_conf(name: str, threshold: float) -> bool:
            x, y, conf = kpts[name]
            return conf >= threshold and self._in_box((x, y), bbox)

        # Eye:任一眼置信达标
        eye_visible = any(kpt_in_box_with_conf(n, self._eye_threshold) for n in EYE_PARTS)

        # Head:≥2 个 head_parts 高置信 OR ≥1 head + ≥1 eye(用 head_eye_threshold)
        head_hits = sum(1 for n in HEAD_PARTS if kpt_in_box_with_conf(n, self._head_threshold))
        eye_hits_for_head = sum(
            1 for n in EYE_PARTS if kpt_in_box_with_conf(n, self._head_eye_threshold)
        )
        head_visible = head_hits >= 2 or (head_hits >= 1 and eye_hits_for_head >= 1)

        # Body / Tail / Wings:任一子关键点达标即可见
        body_visible = any(kpt_in_box_with_conf(n, self._body_threshold) for n in BODY_PARTS)
        tail_visible = kpt_in_box_with_conf(TAIL_PART, self._tail_threshold)
        wings_visible = any(kpt_in_box_with_conf(n, self._wing_threshold) for n in WING_PARTS)

        return head_visible, eye_visible, body_visible, tail_visible, wings_visible

    def _derive_view_angle(
        self,
        bbox: tuple[float, float, float, float],
        kpts: dict[str, tuple[float, float, float]],
    ) -> str:
        """视角:frontal / side / back / unknown。"""

        def is_visible(name: str, threshold: float) -> bool:
            x, y, conf = kpts[name]
            return conf >= threshold and self._in_box((x, y), bbox)

        eye_t = self._eye_threshold
        head_t = self._head_threshold
        left_eye_v = is_visible("left_eye", eye_t)
        right_eye_v = is_visible("right_eye", eye_t)
        bill_v = is_visible("bill", head_t)
        crown_v = is_visible("crown", head_t)
        nape_v = is_visible("nape", head_t)

        # Frontal:双眼 + bill 在两眼水平之间
        if left_eye_v and right_eye_v and bill_v:
            le_x = kpts["left_eye"][0]
            re_x = kpts["right_eye"][0]
            ex_min, ex_max = min(le_x, re_x), max(le_x, re_x)
            bill_x = kpts["bill"][0]
            tolerance = (ex_max - ex_min) * 0.2 + 5  # 双眼水平距离的 20% + 5px 容差
            if ex_min - tolerance <= bill_x <= ex_max + tolerance:
                return "frontal"

        # Back:双眼不可见 + crown + nape 都可见
        if not left_eye_v and not right_eye_v and crown_v and nape_v:
            return "back"

        # Side:仅一只眼可见(典型侧脸)
        if left_eye_v != right_eye_v:
            return "side"

        return "unknown"

    def _derive_facing(
        self,
        view_angle: str,
        kpts: dict[str, tuple[float, float, float]],
    ) -> str:
        """朝向 left/right(仅 side 时有效)。"""
        if view_angle != "side":
            return "unknown"
        bill_x, _, bill_c = kpts["bill"]
        nape_x, _, nape_c = kpts["nape"]
        # bill / nape 都需要可信才能定向
        if bill_c < 0.2 or nape_c < 0.2:
            return "unknown"
        if bill_x < nape_x - 1:
            return "left"
        if bill_x > nape_x + 1:
            return "right"
        return "unknown"

    def _derive_posture(
        self,
        bbox: tuple[float, float, float, float],
        kpts: dict[str, tuple[float, float, float]],
    ) -> str:
        """姿态:perched / flying / unknown(启发式,无 GT 标签)。

        flying 判定故意严格 — 错判 perched 比错判 flying 代价低(只是不上提
        档位而已;反向错判会让栖息照误升档,污染精选墙)。

        flying:
            1) 宽翼展型:aspect ratio (w/h) > 1.3
              AND 双翼都可见
              AND 翼跨度 / bbox 宽度 ≥ 0.5
            2) 长尾/侧飞型:非超宽 bbox 下,强置信翅膀 + 足够翼距 + 明显伸出
              头身核心区域

        规则 2 解决长尾寿带这类真实飞版:长尾会把 bbox 拉高,使 aspect < 1.3;
        侧飞/虚化时一侧翼尖 conf 也可能偏低。模型关键点本身能给出“展翼”
        信号,不能再只看 bbox 宽高比。但折叠翅/长尾在停栖时也会横向伸出,
        所以兜底规则必须比普通 wings_visible 严格得多。
        """
        bx1, by1, bx2, by2 = bbox
        bbox_w = bx2 - bx1
        bbox_h = by2 - by1
        # 极小 bbox(< 32px)是检测噪声/远距离微小目标,不应参与飞版判定 —
        # 32px 以下的鸟连翼形都难以解析,wing_span/bbox_w 比值在数像素差异下抖动剧烈,
        # 几个像素的差就能让比值跨过 0.5 阈值。32px 来自实测最小可识别飞版的经验下限。
        if bbox_w < _POSTURE_MIN_BBOX_WIDTH or bbox_h < 1:
            return "unknown"
        aspect = bbox_w / bbox_h

        def wing_visible(name: str) -> bool:
            x, y, conf = kpts[name]
            return conf >= self._wing_threshold and self._in_box((x, y), bbox)

        left_wing_v = wing_visible("left_wing")
        right_wing_v = wing_visible("right_wing")
        both_wings_v = left_wing_v and right_wing_v
        any_wing_v = left_wing_v or right_wing_v

        # Flying 三重条件(并且关系)
        if aspect > _POSTURE_WIDE_ASPECT_THRESHOLD and both_wings_v:
            wing_span = abs(kpts["left_wing"][0] - kpts["right_wing"][0])
            if wing_span / bbox_w >= _POSTURE_WING_SPAN_RATIO_THRESHOLD:
                return "flying"

        if any_wing_v and self._has_open_wing_signal(bbox, kpts):
            return "flying"

        # Perched:狭长 bbox 或没有可信翅膀关键点
        if aspect < _POSTURE_PERCHED_ASPECT_THRESHOLD or not any_wing_v:
            return "perched"

        return "unknown"

    def _has_open_wing_signal(
        self,
        bbox: tuple[float, float, float, float],
        kpts: dict[str, tuple[float, float, float]],
    ) -> bool:
        """True when a visible wing clearly protrudes from the head/body core.

        这是 posture=flying 的补充信号,专门覆盖长尾鸟/侧飞/单侧翼尖模糊:
        bbox 可能因长尾而变窄变高,但打开的翅膀仍会在 x 方向明显伸出
        bill/nape/breast/belly/back 构成的头身核心区。
        """
        bx1, by1, bx2, by2 = bbox
        bbox_w = max(1e-6, bx2 - bx1)
        bbox_h = max(1e-6, by2 - by1)
        aspect = bbox_w / bbox_h

        # 这个兜底只覆盖长尾/侧飞导致 aspect 不够宽的情况。超宽 bbox 若是明确
        # 飞版,应由上方"双翼 + 大翼距"强规则命中；否则多半是停栖鸟的尾/折叠
        # 翅在水平方向拉长,不应靠单侧 wing 点升为飞版。
        if aspect < _POSTURE_OPEN_WING_MIN_ASPECT or aspect > _POSTURE_OPEN_WING_MAX_ASPECT:
            return False
        if self._derive_view_angle(bbox, kpts) != "side":
            return False

        left_wing = kpts["left_wing"]
        right_wing = kpts["right_wing"]
        left_conf = left_wing[2]
        right_conf = right_wing[2]
        if max(left_conf, right_conf) < _POSTURE_OPEN_WING_STRONG_CONF:
            return False
        if min(left_conf, right_conf) < _POSTURE_OPEN_WING_OPPOSITE_MIN_CONF:
            return False
        if abs(left_wing[0] - right_wing[0]) / bbox_w < _POSTURE_OPEN_WING_MIN_SPAN_RATIO:
            return False

        core_names = ("bill", "nape", "breast", "belly", "back")
        core_points: list[tuple[float, float]] = []
        for name in core_names:
            x, y, conf = kpts[name]
            threshold = self._body_threshold if name in BODY_PARTS else self._head_threshold
            if conf >= threshold and self._in_box((x, y), bbox):
                core_points.append((x, y))
        if len(core_points) < 3:
            return False

        core_xs = [p[0] for p in core_points]
        core_ys = [p[1] for p in core_points]
        core_left = min(core_xs)
        core_right = max(core_xs)
        core_bottom = max(core_ys)
        if (core_right - core_left) / bbox_w > _POSTURE_OPEN_WING_MAX_CORE_WIDTH_RATIO:
            return False

        tail_x, tail_y, tail_conf = kpts[TAIL_PART]
        if tail_conf >= self._tail_threshold and self._in_box((tail_x, tail_y), bbox):
            tail_lateral = max(core_left - tail_x, tail_x - core_right, 0.0) / bbox_w
            if tail_lateral > _POSTURE_OPEN_WING_MAX_TAIL_LATERAL_RATIO:
                return False

        min_overhang = max(
            _POSTURE_OPEN_WING_MIN_OVERHANG, bbox_w * _POSTURE_OPEN_WING_OVERHANG_RATIO
        )
        y_margin = bbox_h * _POSTURE_OPEN_WING_BODY_Y_MARGIN_RATIO

        for name in WING_PARTS:
            wx, wy, conf = kpts[name]
            if conf < self._wing_threshold or not self._in_box((wx, wy), bbox):
                continue
            extends_laterally = wx < core_left - min_overhang or wx > core_right + min_overhang
            stays_near_body = wy <= core_bottom + y_margin
            if extends_laterally and stays_near_body:
                return True

        return False

    def _derive_posture_with_classifier(
        self,
        crop_image: NDArray[np.float32],
        bbox: tuple[float, float, float, float],
        kpts: dict[str, tuple[float, float, float]],
    ) -> tuple[str, float, str]:
        """Prefer v2.1 flight classifier; fall back to geometric heuristic."""
        if self._flight_classifier is not None:
            try:
                classified = self._flight_classifier.classify(crop_image)
            except Exception:
                classified = None
            if classified is not None:
                return classified

        posture = self._derive_posture(bbox, kpts)
        return posture, 0.0, "heuristic"
