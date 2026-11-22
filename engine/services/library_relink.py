"""Verify candidate source files before attaching an existing library to them."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from engine.services.photo_input import (
    SourceStamp,
    encode_source_fingerprint,
    sha256_file,
    source_stamp,
)


@dataclass(frozen=True, slots=True)
class RelinkAnalysis:
    id: str
    source_path: str | None
    source_hash: str | None
    source_fingerprint: str | None


@dataclass(frozen=True, slots=True)
class RelinkedInput:
    path: Path
    stamp: SourceStamp | None
    verified: bool


@dataclass(frozen=True, slots=True)
class RelinkedPhoto:
    primary: RelinkedInput
    companion: RelinkedInput | None

    @property
    def verified(self) -> bool:
        return self.primary.verified and (self.companion is None or self.companion.verified)

    def unchanged(self) -> bool:
        for item in (self.primary, self.companion):
            if item is not None and item.verified and source_stamp(item.path) != item.stamp:
                return False
        return True

    def fingerprint(self) -> str:
        return encode_source_fingerprint(
            self.primary.path,
            self.primary.stamp,
            self.companion.path if self.companion else None,
            self.companion.stamp if self.companion else None,
        )


def _recorded_stamp(
    fingerprint: str | None, slot: int, path: Path
) -> tuple[int, int, int, int] | None:
    if not fingerprint:
        return None
    try:
        values: object = json.loads(fingerprint)
        if not isinstance(values, list) or len(cast(list[object], values)) != 2:
            return None
        field = cast(list[object], values)[slot]
    except ValueError:
        return None
    if isinstance(field, list):
        fields = cast(list[object], field)
        if (
            len(fields) == 5
            and isinstance(fields[0], str)
            and Path(fields[0]) == path
            and all(type(value) is int for value in fields[1:])
        ):
            return cast(tuple[int, int, int, int], tuple(fields[1:]))
    return None


def _old_device(path: Path, old_root: Path) -> int | None:
    # Legacy fingerprints have no device field. Check an accessible ancestor on
    # the old path before using inode equality. A missing/unmounted drive may
    # lack usable identity, so fall back to a recorded hash if available.
    for parent in path.parents:
        if not parent.is_relative_to(old_root.parent):
            break
        try:
            return parent.stat().st_dev
        except (FileNotFoundError, NotADirectoryError):
            continue
        except PermissionError:
            return None
    return None


def _verify_input(
    old_path: Path,
    new_path: Path,
    old_root: Path,
    slot: int,
    analyses: list[RelinkAnalysis],
    *,
    stored_hash: str | None = None,
) -> RelinkedInput:
    try:
        current = source_stamp(new_path)
    except PermissionError:
        current = None
    if current is None or not current.regular:
        return RelinkedInput(new_path, current, False)

    # SHA-256 is independent of inode, filesystem timestamp resolution, and
    # platform file IDs. It also verifies a copy whose write time was reset.
    known_hashes: set[str] = {stored_hash} if stored_hash else set()
    for analysis in analyses:
        if analysis.source_path and Path(analysis.source_path) == old_path and analysis.source_hash:
            known_hashes.add(analysis.source_hash)
    if known_hashes:
        try:
            verified = known_hashes == {sha256_file(new_path)}
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError, PermissionError):
            verified = False
        if source_stamp(new_path) != current:
            raise OSError("Source changed while verifying relink")
        return RelinkedInput(new_path, current, verified)

    # The companion may only have a physical stamp, even for analyzed photos.
    # Reuse a nonzero file ID on the same device after a directory rename.
    recorded = {
        stamp
        for analysis in analyses
        if (stamp := _recorded_stamp(analysis.source_fingerprint, slot, old_path)) is not None
    }
    verified = bool(
        current.inode
        and current.device
        and recorded == {current.fingerprint_fields()}
        and current.device == _old_device(old_path, old_root)
    )
    if not verified and recorded:
        # A cross-device copy can still be proven when the original companion
        # remains accessible and matches its recorded physical snapshot.
        try:
            original = source_stamp(old_path)
        except PermissionError:
            original = None
        if (
            original
            and original.regular
            and original.inode
            and recorded == {original.fingerprint_fields()}
        ):
            try:
                verified = sha256_file(old_path) == sha256_file(new_path)
            except (FileNotFoundError, IsADirectoryError, NotADirectoryError, PermissionError):
                verified = False
            if source_stamp(old_path) != original or source_stamp(new_path) != current:
                raise OSError("Source changed while verifying relink")
    return RelinkedInput(new_path, current, verified)


def verify_relinked_photo(
    old_root: Path,
    new_root: Path,
    old_primary: Path,
    old_companion: Path | None,
    file_hash: str | None,
    analyses: list[RelinkAnalysis],
) -> RelinkedPhoto:
    # Stored paths are rooted at the canonical library path. Use pathlib here
    # to retain Windows drive and case handling and native path separators.
    def destination(path: Path) -> Path:
        try:
            relative = path.relative_to(old_root)
        except ValueError:
            relative = path.resolve().relative_to(old_root.resolve())
        return new_root / relative

    primary = _verify_input(
        old_primary,
        destination(old_primary),
        old_root,
        0,
        analyses,
        stored_hash=file_hash,
    )
    companion = (
        _verify_input(
            old_companion,
            destination(old_companion),
            old_root,
            1,
            analyses,
        )
        if old_companion
        else None
    )
    return RelinkedPhoto(primary, companion)
