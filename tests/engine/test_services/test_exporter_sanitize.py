"""Tests for engine.services.exporter._safe_path_part hardening (M22)."""

from __future__ import annotations

from engine.services.exporter import _safe_path_part


def test_strips_null_bytes() -> None:
    assert _safe_path_part("photo\x00.jpg") == "photo.jpg"


def test_strips_control_chars() -> None:
    assert _safe_path_part("photo\x07\x1b.jpg") == "photo.jpg"


def test_replaces_path_separators() -> None:
    assert _safe_path_part("foo/bar.jpg") == "foo_bar.jpg"
    assert _safe_path_part("foo\\bar.jpg") == "foo_bar.jpg"
    assert _safe_path_part("foo:bar.jpg") == "foo_bar.jpg"


def test_replaces_windows_reserved_chars() -> None:
    assert _safe_path_part('a<b>c"d|e?f*g.jpg') == "a_b_c_d_e_f_g.jpg"


def test_strips_trailing_dots_and_spaces() -> None:
    assert _safe_path_part("photo.jpg.  ") == "photo.jpg"
    assert _safe_path_part("photo.jpg . . ") == "photo.jpg"


def test_falls_back_for_dotted_segments() -> None:
    assert _safe_path_part(".") == "未命名文件夹"
    assert _safe_path_part("..") == "未命名文件夹"
    assert _safe_path_part("", fallback="empty") == "empty"


def test_prefixes_windows_reserved_names() -> None:
    assert _safe_path_part("CON") == "_CON"
    assert _safe_path_part("nul.txt") == "_nul.txt"
    assert _safe_path_part("COM1.dat") == "_COM1.dat"


def test_passes_normal_name() -> None:
    assert _safe_path_part("IMG_2013.jpg") == "IMG_2013.jpg"


def test_passes_chinese_name() -> None:
    assert _safe_path_part("山麻雀-001.jpg") == "山麻雀-001.jpg"
