import os
import time
from pathlib import Path

from engine.services.photo_input import source_fingerprint


def test_source_fingerprint_detects_same_size_rewrite_with_restored_mtime(tmp_path: Path):
    photo = tmp_path / "photo.CR3"
    photo.write_bytes(b"old-raw")
    original = photo.stat()
    before = source_fingerprint(photo)
    # Tiny fixture writes can fit inside one Windows filesystem clock tick;
    # real RAW rewrites span many ticks even when mtime is later restored.
    time.sleep(0.03)
    photo.write_bytes(b"new-raw")
    os.utime(photo, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert source_fingerprint(photo) != before
