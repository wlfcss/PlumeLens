"""Selection contract over real SQL/API data, including multi-bird identities."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest
from engine.api.schemas.selection import SelectionQueryRequest
from engine.core.database import Database
from engine.main import create_app
from engine.services.decisions import Decision, set_decision, set_species_override
from engine.services.selection import SelectionRevisionConflict, freeze_selection, query_selection
from httpx import ASGITransport, AsyncClient

KING = "sci:Alcedo atthis"
EGRET = "sci:Egretta garzetta"
UNKNOWN = "state:unidentified"
NAMES = {
    KING: ("普通翠鸟", "common kingfisher"),
    EGRET: ("白鹭", "little egret"),
    "sci:Urocissa erythroryncha": ("红嘴蓝鹊", "red-billed blue magpie"),
}


def bird(key: str, *, flying: bool = False, review: bool = False, index: int = 0) -> dict:
    name, english = NAMES.get(key, ("未知鸟", "unknown"))
    kp = {"x": 10, "y": 10, "confidence": 0.9}
    return {
        "bbox": {"x1": index * 100, "y1": 0, "x2": index * 100 + 80, "y2": 80, "confidence": 0.9},
        "pose": {
            **dict.fromkeys(("bill", "crown", "nape", "left_eye", "right_eye"), kp),
            "head_visible": True,
            "eye_visible": True,
            "posture": "flying" if flying else "perched",
        },
        "quality": {"combined": 0.8 - index * 0.1},
        "species": name,
        "species_candidates": [
            {
                "canonical_sci": key[4:] if key != UNKNOWN else "Alcedo atthis",
                "canonical_zh": name,
                "canonical_en": english,
                "confidence": 0.95 if not review else 0.38,
                "recognition_state": "unrecognized"
                if key == UNKNOWN
                else ("uncertain" if review else "recognized"),
            }
        ],
    }


async def seed_photo(
    db: Database,
    tmp: Path,
    photo_id: str,
    grade: str,
    birds: list[dict],
    *,
    scene_id: int | None = None,
    status: str = "done",
    library_id: str = "folder",
) -> None:
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO photos (id, library_id, file_path, file_name, file_size, "
            "file_mtime, file_hash, format, created_at, scene_id) "
            "VALUES (?, ?, ?, ?, 10, ?, ?, 'JPG', ?, ?)",
            (
                photo_id,
                library_id,
                str(tmp / f"{photo_id}.jpg"),
                f"{photo_id}.jpg",
                "2026-11-17T08:00:00",
                f"hash-{photo_id}",
                "2026-11-17T08:00:00",
                scene_id,
            ),
        )
        if status == "done":
            await conn.execute(
                "INSERT INTO analysis_results (id, photo_id, pipeline_version, result_json, "
                "quality_score, grade, bird_count, species, created_at, is_active) "
                "VALUES (?, ?, 'test-v1', ?, 0.8, ?, ?, ?, ?, 1)",
                (
                    f"result-{photo_id}",
                    photo_id,
                    json.dumps({"detections": birds}),
                    grade,
                    len(birds),
                    birds[0]["species"] if birds else None,
                    "2026-11-17T08:00:00",
                ),
            )
        elif status == "failed":
            await conn.execute(
                "INSERT INTO task_queue (id, photo_id, library_id, status, created_at) "
                "VALUES (?, ?, ?, 'dead', '2026-11-17T08:00:00')",
                (f"task-{photo_id}", photo_id, library_id),
            )


@pytest.fixture
async def selection_client(tmp_path: Path):
    app = create_app()
    db = Database(tmp_path / "selection.db")
    await db.connect()
    app.state.db = db
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO libraries (id, display_name, parent_path, root_path, created_at, "
            "last_opened_at) VALUES ('folder', '外拍', ?, ?, 'now', 'now')",
            (str(tmp_path.parent), str(tmp_path)),
        )
    data = [
        ("p1", "select", [bird(KING)]),
        ("p2", "usable", [bird(KING), bird(KING, index=1)]),
        ("p3", "record", [bird(KING, flying=True, review=True)]),
        ("p4", "select", [bird(EGRET, flying=True)]),
        ("p5", "record", [bird("sci:Urocissa erythroryncha")]),
        ("p6", "usable", [bird(KING), bird(EGRET, flying=True, index=1)]),
        ("p7", "reject", [bird(KING, flying=True)]),
        ("p8", "usable", [bird(UNKNOWN, flying=True)]),
        ("p9", "select", [bird(KING, review=True)]),
    ]
    for photo_id, grade, birds in data:
        await seed_photo(db, tmp_path, photo_id, grade, birds)
    await seed_photo(db, tmp_path, "p10", "reject", [], status="failed")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client, db, tmp_path
    await db.close()


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({}, {"p1", "p2", "p3", "p4", "p5", "p6", "p8", "p9"}),
        ({"species_keys": [KING]}, {"p1", "p2", "p3", "p6", "p9"}),
        ({"species_keys": [KING, EGRET]}, {"p1", "p2", "p3", "p4", "p6", "p9"}),
        ({"species_keys": [KING], "include_review": False}, {"p1", "p2", "p6"}),
        ({"species_keys": [KING], "only_flying": True}, {"p3"}),
        ({"species_keys": [KING], "only_flying": True, "include_review": False}, set()),
        ({"species_keys": [EGRET], "only_flying": True}, {"p4", "p6"}),
        ({"species_keys": [UNKNOWN], "only_flying": True}, {"p8"}),
        ({"species_keys": [KING], "only_flying": True, "grades": ["reject"]}, {"p7"}),
        ({"only_flying": True, "include_review": False}, {"p3", "p4", "p6", "p8"}),
        ({"include_review": False}, {"p1", "p2", "p3", "p4", "p5", "p6", "p8", "p9"}),
        ({"grades": []}, set()),
        ({"photo_query": "P6"}, {"p6"}),
    ],
)
async def test_membership_and_same_bird_flight(selection_client, body, expected) -> None:
    client, _db, _tmp = selection_client
    response = await client.post("/library/folder/selection/query", json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    assert set(data["matched_photo_ids"]) == expected
    assert data["matched_count"] == len(expected)


async def test_facets_ignore_own_selection_and_deduplicate(selection_client) -> None:
    client, _db, _tmp = selection_client
    first = (await client.post("/library/folder/selection/query", json={})).json()
    second = (
        await client.post("/library/folder/selection/query", json={"species_keys": [KING]})
    ).json()
    assert first["facets"] == second["facets"]
    assert first["projection_revision"] == second["projection_revision"]
    assert (await client.get("/library/folder")).json()["projection_revision"] == (
        first["projection_revision"]
    )
    assert (await client.get("/library/folder?limit=1")).json()["projection_revision"] is None
    facets = {row["key"]: row for row in first["facets"]}
    assert facets[KING]["photo_count"] == 5
    assert facets[KING]["review_photo_count"] == 2
    assert facets[EGRET]["photo_count"] == 2
    assert sum(row["photo_count"] for row in first["facets"]) == 9
    assert "common kingfisher" in facets[KING]["search_aliases"]
    flying = (
        await client.post("/library/folder/selection/query", json={"only_flying": True})
    ).json()
    counts = {row["key"]: row["photo_count"] for row in flying["facets"]}
    assert counts[KING] == 1
    assert counts[EGRET] == 2


async def test_selected_absent_species_is_retained_at_zero(selection_client) -> None:
    client, _db, _tmp = selection_client
    data = (
        await client.post(
            "/library/folder/selection/query",
            json={
                "species_keys": ["sci:Ardea cinerea"],
            },
        )
    ).json()
    assert data["matched_count"] == 0
    assert (
        next(row for row in data["facets"] if row["key"] == "sci:Ardea cinerea")["photo_count"] == 0
    )


async def test_pending_failed_and_no_bird_are_not_unknown_species(selection_client) -> None:
    client, db, tmp = selection_client
    await seed_photo(db, tmp, "pending", "record", [], status="pending")
    await seed_photo(db, tmp, "no-bird", "reject", [])
    all_data = (
        await client.post(
            "/library/folder/selection/query",
            json={
                "include_no_bird": True,
                "include_failed": True,
            },
        )
    ).json()
    assert {"pending", "p10", "no-bird"} <= set(all_data["matched_photo_ids"])
    assert all_data["pending_count"] == all_data["failed_count"] == all_data["no_bird_count"] == 1
    unknown = (
        await client.post(
            "/library/folder/selection/query",
            json={
                "species_keys": [UNKNOWN],
                "include_no_bird": True,
                "include_failed": True,
            },
        )
    ).json()
    assert unknown["matched_photo_ids"] == ["p8"]


async def test_pending_photos_respect_manual_grade_without_inventing_bird_evidence(
    selection_client,
) -> None:
    client, db, tmp = selection_client
    for photo_id in ("pending-rejected", "pending-usable", "pending-unrated"):
        await seed_photo(db, tmp, photo_id, "record", [], status="pending")
    for photo_id, decision in (("pending-rejected", "reject"), ("pending-usable", "usable")):
        response = await client.put(f"/decisions/photo/{photo_id}", json={"decision": decision})
        assert response.status_code == 200, response.text

    for filters, expected in (
        ({}, {"pending-usable", "pending-unrated"}),
        ({"grades": ["reject"]}, {"pending-rejected", "pending-unrated"}),
        ({"grades": ["select"]}, {"pending-unrated"}),
        ({"species_keys": [KING]}, set()),
        ({"only_flying": True}, set()),
    ):
        response = await client.post(
            "/library/folder/selection/query", json={"photo_query": "pending-", **filters}
        )
        assert response.status_code == 200, response.text
        assert set(response.json()["matched_photo_ids"]) == expected


async def test_manual_species_and_grade_override_raw_model(selection_client) -> None:
    client, db, _tmp = selection_client
    await set_species_override(
        db,
        "p8",
        0,
        {
            "canonical_sci": "Alcedo atthis",
            "canonical_zh": "普通翠鸟",
            "canonical_en": None,
        },
    )
    await set_decision(db, "p7", Decision.SELECT)
    unknown = await query_selection(db, "folder", SelectionQueryRequest(species_keys=[UNKNOWN]))
    assert "p8" not in unknown.matched_photo_ids
    king = (
        await client.post(
            "/library/folder/selection/query",
            json={
                "species_keys": [KING],
                "include_review": False,
            },
        )
    ).json()
    assert {"p7", "p8"} <= set(king["matched_photo_ids"])
    # A source replacement must not apply a previous input's manual boxes.
    async with db.transaction() as conn:
        await conn.execute("UPDATE photos SET input_revision = 1 WHERE id = 'p8'")
        await conn.execute("UPDATE analysis_results SET input_revision = 1 WHERE photo_id = 'p8'")
    restored = await query_selection(db, "folder", SelectionQueryRequest(species_keys=[UNKNOWN]))
    assert "p8" in restored.matched_photo_ids


@pytest.mark.parametrize("uncertain", [False, True])
async def test_full_scene_consensus_precedes_filter_and_matches_library(
    selection_client, uncertain
):
    client, db, tmp = selection_client
    for index in range(1, 4):
        await seed_photo(db, tmp, f"c{index}", "select", [bird(EGRET)], scene_id=22)
    await seed_photo(db, tmp, "c4", "select", [bird(KING, review=uncertain)], scene_id=22)
    rows = (await client.get("/library/folder")).json()["photos"]
    current = next(photo for photo in rows if photo["id"] == "c4")
    assert current["species_source"] == ("group_consensus" if uncertain else "conflict")
    key = EGRET if uncertain else KING
    response = (
        await client.post(
            "/library/folder/selection/query",
            json={
                "species_keys": [key],
                "photo_query": "c4",
                "include_review": False,
            },
        )
    ).json()
    assert response["matched_photo_ids"] == (["c4"] if uncertain else [])
    # Fetching just this photo still expands the same whole scene.
    index = next(i for i, photo in enumerate(rows) if photo["id"] == "c4")
    page = (await client.get(f"/library/folder?limit=1&offset={index}")).json()["photos"][0]
    assert page["species_source"] == current["species_source"]


async def test_topk_other_candidates_do_not_create_membership(selection_client) -> None:
    client, db, tmp = selection_client
    detection = bird(KING)
    detection["species_candidates"].append(bird(EGRET)["species_candidates"][0])
    await seed_photo(db, tmp, "topk", "select", [detection])
    data = (
        await client.post(
            "/library/folder/selection/query",
            json={
                "species_keys": [EGRET],
                "photo_query": "topk",
            },
        )
    ).json()
    assert data["matched_count"] == 0


async def test_manual_species_english_survives_replaced_raw_candidates(selection_client) -> None:
    client, db, _tmp = selection_client
    await set_species_override(
        db,
        "p1",
        0,
        {
            "canonical_sci": "Egretta garzetta",
            "canonical_zh": "白鹭",
            "canonical_en": "Little egret manual confirmation",
        },
    )
    # p1's original TopK still only contains kingfisher. Its effective English
    # metadata must come from the override, not from that superseded model.
    detail = (await client.get("/library/folder")).json()
    photo = next(photo for photo in detail["photos"] if photo["id"] == "p1")
    assert photo["best_detection"]["species_english"] == "Little egret manual confirmation"
    data = (
        await client.post(
            "/library/folder/selection/query",
            json={
                "species_keys": [EGRET],
                "photo_query": "manual confirmation",
            },
        )
    ).json()
    assert data["matched_photo_ids"] == ["p1"]
    egret = next(facet for facet in data["facets"] if facet["key"] == EGRET)
    assert "Little egret manual confirmation" in egret["search_aliases"]


async def test_freeze_and_revision_guard(selection_client) -> None:
    _client, db, _tmp = selection_client
    query = SelectionQueryRequest(species_keys=[KING])
    preview = await query_selection(db, "folder", query)
    snapshot = await freeze_selection(db, "folder", query, preview.projection_revision)
    assert snapshot.photo_ids == tuple(preview.matched_photo_ids)
    assert all(photo.file_hash and photo.input_revision == 0 for photo in snapshot.photos)
    await set_species_override(
        db,
        "p1",
        0,
        {
            "canonical_sci": "Egretta garzetta",
            "canonical_zh": "白鹭",
            "canonical_en": None,
        },
    )
    assert next(photo for photo in snapshot.photos if photo.id == "p1").species_latin == (
        "Alcedo atthis"
    )
    with pytest.raises(SelectionRevisionConflict):
        await freeze_selection(db, "folder", query, preview.projection_revision)
    new_preview = await query_selection(db, "folder", query)
    assert "p1" not in new_preview.matched_photo_ids
    async with db.transaction() as conn:
        await conn.execute("UPDATE photos SET input_revision = input_revision + 1 WHERE id = 'p2'")
    assert (await query_selection(db, "folder", query)).projection_revision != (
        new_preview.projection_revision
    )


async def test_query_is_read_only_and_folder_scoped(selection_client) -> None:
    client, db, tmp = selection_client
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO libraries (id, display_name, parent_path, root_path, created_at, "
            "last_opened_at) VALUES ('other', '其他', ?, ?, 'now', 'now')",
            (str(tmp), str(tmp / "other")),
        )
    await seed_photo(db, tmp, "foreign", "select", [bird(KING)], library_id="other")
    before = db.conn.total_changes
    response = await client.post("/library/folder/selection/query", json={})
    assert response.status_code == 200
    assert "foreign" not in response.json()["matched_photo_ids"]
    assert db.conn.total_changes == before
    assert (await client.post("/library/missing/selection/query", json={})).status_code == 404


async def test_projection_releases_write_lock_and_retains_sql_snapshot(
    selection_client, monkeypatch
) -> None:
    from engine.services import library_projection

    _client, db, _tmp = selection_client
    entered = threading.Event()
    released = threading.Event()
    original = library_projection.project_library_photos

    def blocked_projection(*args):
        entered.set()
        assert released.wait(5), "Projection test was not released"
        return original(*args)

    monkeypatch.setattr(library_projection, "project_library_photos", blocked_projection)
    task = asyncio.create_task(
        query_selection(db, "folder", SelectionQueryRequest(species_keys=[KING], grades=["select"]))
    )
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        # All SQL inputs precede this later write. CPU projection must neither
        # hold the write lock nor observe a mixture of those two revisions.
        await asyncio.wait_for(set_decision(db, "p1", Decision.REJECT), timeout=2)
    finally:
        released.set()
    before = await task
    assert "p1" in before.matched_photo_ids
    after = await query_selection(
        db, "folder", SelectionQueryRequest(species_keys=[KING], grades=["select"])
    )
    assert "p1" not in after.matched_photo_ids
    assert before.projection_revision != after.projection_revision


async def test_archive_projection_cannot_cache_another_tasks_uncommitted_grade(selection_client):
    from engine.api.routes.archive import _load_geo_photos

    _client, db, _tmp = selection_client
    entered = asyncio.Event()
    release = asyncio.Event()

    async def rollback_writer():
        try:
            async with db.transaction():
                await set_decision(db, "p1", Decision.REJECT)
                entered.set()
                await release.wait()
                raise RuntimeError("Rollback only this writer")
        except RuntimeError:
            pass

    writer = asyncio.create_task(rollback_writer())
    await entered.wait()
    reader = asyncio.create_task(_load_geo_photos(db, "p.library_id=?", ("folder",)))
    try:
        await asyncio.sleep(0.02)
        assert not reader.done(), "Archive read an uncommitted writer's grade"
    finally:
        release.set()
    await writer
    photos = await reader
    assert "p1" in {photo.photo.id for photo in photos}


@pytest.mark.parametrize(
    "body",
    [
        {"species_keys": ["翠鸟"]},
        {"species_keys": ["sci:"]},
        {"species_keys": ["state:no-bird"]},
        {"grades": ["精选"]},
        {"unexpected_filter": True},
        {"sort": "random"},
    ],
)
async def test_invalid_filters_are_rejected(selection_client, body) -> None:
    client, _db, _tmp = selection_client
    assert (await client.post("/library/folder/selection/query", json=body)).status_code == 422
