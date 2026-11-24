"""Selection membership, facets and export snapshots share effective bird identities.

The projection is computed for the complete folder before filtering so changing
filters or pagination never changes scene consensus. No inference runs here.
"""

from __future__ import annotations

import asyncio
import math
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from engine.api.schemas.library import BestDetection, DetectionSummary, PhotoRow
from engine.api.schemas.selection import (
    SelectionQueryRequest,
    SelectionQueryResponse,
    SelectionSpeciesFacet,
)
from engine.core.database import Database
from engine.services.library_projection import (
    LibraryProjectionNotFound,
    ProjectedPhoto,
    load_library_photos,
    projection_revision,
)

UNIDENTIFIED_KEY = "state:unidentified"
REVIEW_SOURCES = frozenset({"model_unconfirmed", "conflict"})
NAMED_SOURCES = frozenset({"manual", "model", "group_consensus", *REVIEW_SOURCES})


class SelectionLibraryNotFound(RuntimeError):
    """The requested folder no longer exists."""


class SelectionRevisionConflict(RuntimeError):
    """The preview has changed; callers must refresh it before starting export."""


@dataclass(frozen=True)
class SelectionSnapshot:
    projection_revision: str
    photo_ids: tuple[str, ...]
    photos: tuple[PhotoRow, ...]
    query: SelectionQueryRequest


@dataclass(frozen=True, slots=True)
class BirdIdentity:
    key: str
    name: str
    latin_name: str | None
    english_name: str | None
    review: bool
    flying: bool


@dataclass(frozen=True, slots=True)
class SelectionPhoto:
    id: str
    file_name: str
    shot_at: str
    quality_score: float | None
    analysis_status: str
    grade: str | None
    decision: str | None
    bird_count: int | None
    search_texts: tuple[str, ...]
    birds: tuple[BirdIdentity, ...]
    review_revision: str | None


@dataclass(frozen=True, slots=True)
class SelectionProjection:
    revision: str
    photos: tuple[SelectionPhoto, ...]


class SelectionProjectionCache:
    """Keep the current and previous selection projections across detail refreshes."""

    def __init__(self) -> None:
        self._entries: OrderedDict[tuple[str, str], SelectionProjection] = OrderedDict()

    def get(self, library_id: str, revision: str) -> SelectionProjection | None:
        return self._entries.get((library_id, revision))

    def latest(self, library_id: str) -> SelectionProjection | None:
        return next(
            (self._entries[key] for key in reversed(self._entries) if key[0] == library_id),
            None,
        )

    def store(self, library_id: str, projection: SelectionProjection) -> None:
        key = (library_id, projection.revision)
        self._entries[key] = projection
        self._entries.move_to_end(key)
        if len(self._entries) > 2:
            self._entries.popitem(last=False)

    def discard_library(self, library_id: str) -> None:
        for key in tuple(self._entries):
            if key[0] == library_id:
                del self._entries[key]

    def clear(self) -> None:
        self._entries.clear()


def _bird_identity(bird: BestDetection | DetectionSummary) -> BirdIdentity:
    latin = " ".join((bird.species_latin or "").split())
    named = bool(latin) and bird.species_source in NAMED_SOURCES
    english = bird.species_english if named else None
    if named and not english:
        # Candidates are metadata only. Never treat lower-ranked candidates as
        # additional bird identities, or reuse a replaced model name as manual.
        for candidate in bird.species_candidates:
            if candidate.get("canonical_sci") == latin and candidate.get("canonical_en"):
                english = str(candidate["canonical_en"])
                break
    return BirdIdentity(
        key=f"sci:{latin}" if named else UNIDENTIFIED_KEY,
        name=(bird.species or latin) if named else "含未识别鸟",
        latin_name=latin if named else None,
        english_name=english,
        review=named and bird.species_source in REVIEW_SOURCES,
        flying=bird.pose is not None and bird.pose.posture == "flying",
    )


def _photo_birds(photo: ProjectedPhoto) -> list[BirdIdentity]:
    if photo.analysis_status != "done" or not photo.bird_count:
        return []
    if photo.detections:
        return [_bird_identity(bird) for bird in photo.detections]
    if photo.best_detection is not None:
        # Compatibility: one best detection remains one bird, never one per
        # bird_count. In particular, do not copy its species to other birds.
        return [_bird_identity(photo.best_detection)]
    # Old records without detection details have no verifiable canonical bird
    # identity. Keep them discoverable without inventing a species or flight.
    return [BirdIdentity(UNIDENTIFIED_KEY, "含未识别鸟", None, None, False, False)]


def _eligible_bird(bird: BirdIdentity, query: SelectionQueryRequest) -> bool:
    return (query.include_review or not bird.review) and (not query.only_flying or bird.flying)


def _selection_photo(photo: ProjectedPhoto) -> SelectionPhoto:
    birds = tuple(_photo_birds(photo))
    texts = [photo.file_name, photo.species or "", photo.species_latin or ""]
    for bird in birds:
        texts.extend((bird.name, bird.latin_name or "", bird.english_name or ""))
    return SelectionPhoto(
        id=photo.id,
        file_name=photo.file_name,
        shot_at=photo.shot_at,
        quality_score=photo.quality_score,
        analysis_status=photo.analysis_status,
        grade=photo.grade,
        decision=photo.decision,
        bird_count=photo.bird_count,
        search_texts=tuple(text.casefold() for text in texts),
        birds=birds,
        review_revision=photo.review_revision,
    )


def build_selection_projection(
    library_id: str,
    photos: Sequence[ProjectedPhoto],
    previous: SelectionProjection | None = None,
) -> SelectionProjection:
    # The per-photo review revision covers the effective identity, source,
    # filename, time, status and rating used by the selection projection.
    revision = projection_revision(library_id, photos)
    if previous is None:
        return SelectionProjection(revision, tuple(_selection_photo(photo) for photo in photos))

    previous_by_id = {photo.id: photo for photo in previous.photos}
    projected: list[SelectionPhoto] = []
    for photo in photos:
        projected.append(selection_photo_for_snapshot(photo, previous_by_id))
    return SelectionProjection(revision, tuple(projected))


def selection_photo_for_snapshot(
    photo: ProjectedPhoto, previous_by_id: dict[str, SelectionPhoto]
) -> SelectionPhoto:
    cached = previous_by_id.get(photo.id)
    if (
        cached is not None
        and photo.review_revision is not None
        and cached.review_revision == photo.review_revision
    ):
        return cached
    return _selection_photo(photo)


def _matches_photo_conditions(
    photo: SelectionPhoto, query: SelectionQueryRequest, keyword: str
) -> bool:
    if keyword and not any(keyword in text for text in photo.search_texts):
        return False
    if photo.analysis_status == "pending":
        # A folder without a species constraint keeps its unanalysed photos
        # visible unless their manual grade excludes them. Their unknown
        # species/posture cannot prove a positive match.
        return (
            not query.species_keys
            and not query.only_flying
            and (photo.decision is None or photo.decision in query.grades)
        )
    if photo.analysis_status == "failed":
        return query.include_failed and not query.species_keys and not query.only_flying
    if not photo.bird_count:
        return query.include_no_bird and not query.species_keys and not query.only_flying
    return (photo.decision or photo.grade) in query.grades


_GRADE_RANK: dict[str | None, int] = {
    "select": 3,
    "usable": 2,
    "record": 1,
    "reject": 0,
}


def _effective_grade_rank(photo: SelectionPhoto) -> int:
    return _GRADE_RANK.get(photo.decision or photo.grade, 0)


def _normalized_score(photo: SelectionPhoto) -> float:
    score = photo.quality_score
    return score if score is not None and math.isfinite(score) else -1.0


def _parse_shot_timestamp(value: str) -> float | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _shot_time_asc_key(photo: SelectionPhoto) -> tuple[int, float]:
    ts = _parse_shot_timestamp(photo.shot_at)
    return (0, ts) if ts is not None else (1, 0.0)


def _shot_time_desc_key(photo: SelectionPhoto) -> tuple[int, float]:
    ts = _parse_shot_timestamp(photo.shot_at)
    return (0, -ts) if ts is not None else (1, 0.0)


def _sort_photos(
    photos: list[SelectionPhoto], query: SelectionQueryRequest
) -> list[SelectionPhoto]:
    if query.sort == "name":
        return sorted(
            photos,
            key=lambda photo: (photo.file_name.casefold(), _shot_time_asc_key(photo), photo.id),
        )
    if query.sort == "time":
        return sorted(
            photos,
            key=lambda photo: (_shot_time_desc_key(photo), photo.file_name.casefold(), photo.id),
        )
    return sorted(
        photos,
        key=lambda photo: (
            -_effective_grade_rank(photo),
            -_normalized_score(photo),
            _shot_time_asc_key(photo),
            photo.file_name.casefold(),
            photo.id,
        ),
    )


async def _load_photos(db: Database, library_id: str) -> list[PhotoRow]:
    try:
        return await load_library_photos(db, library_id)
    except LibraryProjectionNotFound as exc:
        raise SelectionLibraryNotFound(library_id) from exc


def _project_selection(
    library_id: str,
    projection: SelectionProjection,
    query: SelectionQueryRequest,
    *,
    limit: int | None = None,
    offset: int = 0,
) -> SelectionQueryResponse:
    photos = projection.photos
    keyword = query.photo_query.casefold()
    # Keep observed options even when other conditions make their counts zero.
    metadata: dict[str, BirdIdentity] = {}
    aliases: dict[str, set[str]] = {}
    for photo in photos:
        for bird in photo.birds:
            current = metadata.get(bird.key)
            if current is None or (current.english_name is None and bird.english_name):
                metadata[bird.key] = bird
            aliases.setdefault(bird.key, set()).update(
                text for text in (bird.name, bird.latin_name, bird.english_name) if text
            )
    for key in query.species_keys:
        if key not in metadata:
            latin = key[4:] if key.startswith("sci:") else None
            metadata[key] = BirdIdentity(key, latin or "含未识别鸟", latin, None, False, False)
            aliases[key] = {metadata[key].name}

    # Species itself is deliberately absent from the facet base. Flight is
    # checked on each candidate bird rather than on a different bird in photo.
    facet_query = query.model_copy(update={"species_keys": []})
    base = [photo for photo in photos if _matches_photo_conditions(photo, facet_query, keyword)]
    counts: dict[str, set[str]] = {key: set() for key in metadata}
    review_counts: dict[str, set[str]] = {key: set() for key in metadata}
    for photo in base:
        for bird in photo.birds:
            if _eligible_bird(bird, query):
                counts[bird.key].add(photo.id)
                if bird.review:
                    review_counts[bird.key].add(photo.id)
    selected = set(query.species_keys)
    matched: list[SelectionPhoto] = []
    for photo in photos:
        if not _matches_photo_conditions(photo, query, keyword):
            continue
        if selected:
            if not any(
                bird.key in selected and _eligible_bird(bird, query) for bird in photo.birds
            ):
                continue
        elif query.only_flying and not any(bird.flying for bird in photo.birds):
            continue
        matched.append(photo)
    matched = _sort_photos(matched, query)
    facets = [
        SelectionSpeciesFacet(
            key=key,
            name=bird.name,
            latin_name=bird.latin_name,
            english_name=bird.english_name,
            search_aliases=sorted(aliases[key]),
            photo_count=len(counts[key]),
            review_photo_count=len(review_counts[key]),
        )
        for key, bird in metadata.items()
    ]
    facets.sort(key=lambda facet: (-facet.photo_count, facet.name.casefold(), facet.key))
    total_matched = len(matched)
    if limit is not None:
        page = matched[offset : offset + limit]
        next_offset = offset + len(page) if offset + len(page) < total_matched else None
    elif offset > 0:
        page = matched[offset:]
        next_offset = None
    else:
        page = matched
        next_offset = None
    return SelectionQueryResponse(
        library_id=library_id,
        projection_revision=projection.revision,
        query=query,
        matched_photo_ids=[photo.id for photo in page],
        matched_count=total_matched,
        total_count=len(photos),
        pending_count=sum(photo.analysis_status == "pending" for photo in photos),
        failed_count=sum(photo.analysis_status == "failed" for photo in photos),
        no_bird_count=sum(
            photo.analysis_status == "done" and photo.bird_count == 0 for photo in photos
        ),
        facets=facets,
        offset=offset,
        limit=limit,
        next_offset=next_offset,
    )


def _project_live_selection(
    library_id: str,
    photos: Sequence[ProjectedPhoto],
    query: SelectionQueryRequest,
    *,
    limit: int | None = None,
    offset: int = 0,
) -> SelectionQueryResponse:
    return _project_selection(
        library_id,
        build_selection_projection(library_id, photos),
        query,
        limit=limit,
        offset=offset,
    )


async def query_selection(
    db: Database,
    library_id: str,
    query: SelectionQueryRequest,
    *,
    projection: SelectionProjection | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> SelectionQueryResponse:
    """Return one consistent folder projection, membership and facets."""
    if projection is not None:
        return await asyncio.to_thread(
            _project_selection, library_id, projection, query, limit=limit, offset=offset
        )
    try:
        photos = await load_library_photos(db, library_id, summary=True)
    except LibraryProjectionNotFound as exc:
        raise SelectionLibraryNotFound(library_id) from exc
    return await asyncio.to_thread(
        _project_live_selection, library_id, photos, query, limit=limit, offset=offset
    )


async def freeze_selection(
    db: Database,
    library_id: str,
    query: SelectionQueryRequest,
    expected_revision: str,
) -> SelectionSnapshot:
    """Freeze authoritative members and effective identities before file copying."""
    photos = await _load_photos(db, library_id)
    response = await asyncio.to_thread(_project_live_selection, library_id, photos, query)
    if response.projection_revision != expected_revision:
        raise SelectionRevisionConflict("Selection changed; refresh before exporting")
    photo_by_id = {photo.id: photo for photo in photos}
    return SelectionSnapshot(
        projection_revision=response.projection_revision,
        photo_ids=tuple(response.matched_photo_ids),
        photos=tuple(
            photo_by_id[photo_id].model_copy(deep=True) for photo_id in response.matched_photo_ids
        ),
        query=query.model_copy(deep=True),
    )
