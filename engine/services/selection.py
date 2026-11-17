"""Selection membership, facets and export snapshots share effective bird identities.

The projection is computed for the complete folder before filtering so changing
filters or pagination never changes scene consensus. No inference runs here.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from engine.api.schemas.library import BestDetection, PhotoRow
from engine.api.schemas.selection import (
    SelectionQueryRequest,
    SelectionQueryResponse,
    SelectionSpeciesFacet,
)
from engine.core.database import Database
from engine.services.library_projection import (
    LibraryProjectionNotFound,
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


@dataclass(frozen=True)
class BirdIdentity:
    key: str
    name: str
    latin_name: str | None
    english_name: str | None
    review: bool
    flying: bool


def _bird_identity(bird: BestDetection) -> BirdIdentity:
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


def _photo_birds(photo: PhotoRow) -> list[BirdIdentity]:
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


def _matches_photo_conditions(
    photo: PhotoRow, birds: list[BirdIdentity], query: SelectionQueryRequest
) -> bool:
    keyword = query.photo_query.casefold()
    if keyword:
        texts = [photo.file_name, photo.species or "", photo.species_latin or ""]
        for bird in birds:
            texts.extend([bird.name, bird.latin_name or "", bird.english_name or ""])
        if not any(keyword in text.casefold() for text in texts):
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


def _sort_photos(photos: list[PhotoRow], query: SelectionQueryRequest) -> list[PhotoRow]:
    if query.sort == "name":
        return sorted(photos, key=lambda photo: (photo.file_name.casefold(), photo.id))
    if query.sort == "time":
        return sorted(photos, key=lambda photo: (photo.shot_at, photo.id), reverse=True)
    return sorted(
        photos,
        key=lambda photo: (
            photo.quality_score if photo.quality_score is not None else -1,
            photo.shot_at,
            photo.id,
        ),
        reverse=True,
    )


async def _query_unlocked(
    db: Database, library_id: str, query: SelectionQueryRequest
) -> tuple[SelectionQueryResponse, list[PhotoRow]]:
    try:
        photos = await load_library_photos(db, library_id)
    except LibraryProjectionNotFound as exc:
        raise SelectionLibraryNotFound(library_id) from exc
    return await asyncio.to_thread(_project_selection, library_id, photos, query)


def _project_selection(
    library_id: str, photos: list[PhotoRow], query: SelectionQueryRequest
) -> tuple[SelectionQueryResponse, list[PhotoRow]]:
    identities = {photo.id: _photo_birds(photo) for photo in photos}
    # Keep observed options even when other conditions make their counts zero.
    metadata: dict[str, BirdIdentity] = {}
    aliases: dict[str, set[str]] = {}
    for birds in identities.values():
        for bird in birds:
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
    base = [
        photo
        for photo in photos
        if _matches_photo_conditions(photo, identities[photo.id], facet_query)
    ]
    counts: dict[str, set[str]] = {key: set() for key in metadata}
    review_counts: dict[str, set[str]] = {key: set() for key in metadata}
    for photo in base:
        for bird in identities[photo.id]:
            if _eligible_bird(bird, query):
                counts[bird.key].add(photo.id)
                if bird.review:
                    review_counts[bird.key].add(photo.id)
    selected = set(query.species_keys)
    matched: list[PhotoRow] = []
    for photo in photos:
        birds = identities[photo.id]
        if not _matches_photo_conditions(photo, birds, query):
            continue
        if selected:
            if not any(bird.key in selected and _eligible_bird(bird, query) for bird in birds):
                continue
        elif query.only_flying and not any(bird.flying for bird in birds):
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
    response = SelectionQueryResponse(
        library_id=library_id,
        projection_revision=projection_revision(library_id, photos),
        query=query,
        matched_photo_ids=[photo.id for photo in matched],
        matched_count=len(matched),
        total_count=len(photos),
        pending_count=sum(photo.analysis_status == "pending" for photo in photos),
        failed_count=sum(photo.analysis_status == "failed" for photo in photos),
        no_bird_count=sum(
            photo.analysis_status == "done" and photo.bird_count == 0 for photo in photos
        ),
        facets=facets,
    )
    return response, matched


async def query_selection(
    db: Database, library_id: str, query: SelectionQueryRequest
) -> SelectionQueryResponse:
    """Return one consistent folder projection, membership and facets."""
    response, _photos = await _query_unlocked(db, library_id, query)
    return response


async def freeze_selection(
    db: Database,
    library_id: str,
    query: SelectionQueryRequest,
    expected_revision: str,
) -> SelectionSnapshot:
    """Freeze authoritative members and effective identities before file copying."""
    response, photos = await _query_unlocked(db, library_id, query)
    if response.projection_revision != expected_revision:
        raise SelectionRevisionConflict("Selection changed; refresh before exporting")
    return SelectionSnapshot(
        projection_revision=response.projection_revision,
        photo_ids=tuple(response.matched_photo_ids),
        photos=tuple(photo.model_copy(deep=True) for photo in photos),
        query=query.model_copy(deep=True),
    )
