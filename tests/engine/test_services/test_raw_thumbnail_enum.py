"""rawpy ThumbFormat is an Enum, not an integer-convertible value."""

import io
import sys
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from engine.services import thumbnail
from PIL import Image


def test_raw_jpeg_preview_uses_enum_without_full_raw_decode(monkeypatch):
    class ThumbFormat(Enum):
        JPEG = 0
        BITMAP = 1

    data = io.BytesIO()
    Image.new("RGB", (1920, 8)).save(data, format="JPEG")
    raw = MagicMock()
    raw.sizes.flip = 0
    raw.extract_thumb.return_value = SimpleNamespace(format=ThumbFormat.JPEG, data=data.getvalue())
    raw.postprocess.side_effect = AssertionError("Embedded JPEG must avoid full RAW decoding")
    context = MagicMock()
    context.__enter__.return_value = raw
    monkeypatch.setitem(
        sys.modules, "rawpy", SimpleNamespace(ThumbFormat=ThumbFormat, imread=lambda _: context)
    )
    monkeypatch.setattr(thumbnail, "raw_orientation", lambda *_: 1)
    assert thumbnail._load_raw_with_embedded_preview(Path("photo.CR3")).size == (1920, 8)
    raw.postprocess.assert_not_called()
