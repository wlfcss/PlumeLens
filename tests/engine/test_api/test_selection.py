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


async def test_large_summary_stream_preserves_json_and_yields_between_batches(
    selection_client, monkeypatch
) -> None:
    from engine.api.routes import library

    client, _db, _tmp = selection_client
    url = "/library/folder?view=summary&include_selection_snapshot=true"
    buffered = await client.get(url)
    assert buffered.status_code == 200, buffered.text
    assert "content-length" in buffered.headers

    monkeypatch.setattr(library, "_SUMMARY_STREAM_THRESHOLD", 1)
    monkeypatch.setattr(library, "_SUMMARY_ROWS_PER_CHUNK", 3)
    encoded_sizes: list[int] = []
    between_chunks = asyncio.Event()
    between_chunks.set()
    encode = library._encode_summary_rows

    def observe_chunk(rows):
        assert between_chunks.is_set()
        between_chunks.clear()
        asyncio.get_running_loop().call_soon(between_chunks.set)
        encoded_sizes.append(len(rows))
        return encode(rows)

    monkeypatch.setattr(library, "_encode_summary_rows", observe_chunk)
    streamed = await client.get(url)
    assert streamed.status_code == 200, streamed.text
    assert streamed.headers["content-type"] == "application/json"
    assert "content-length" not in streamed.headers
    assert streamed.content == buffered.content
    assert encoded_sizes == [3, 3, 3, 1]

    query = await client.post(
        "/library/folder/selection/query",
        params={"projection_revision": streamed.json()["projection_revision"]},
        json={"species_keys": [KING]},
    )
    live = await client.post("/library/folder/selection/query", json={"species_keys": [KING]})
    assert query.status_code == 200, query.text
    assert live.status_code == 200, live.text
    assert query.json() == live.json()
    assert set(query.json()["matched_photo_ids"]) == {"p1", "p2", "p3", "p6", "p9"}

    page = await client.get("/library/folder?view=summary&limit=3")
    full = await client.get("/library/folder")
    assert "content-length" in page.headers
    assert "content-length" in full.headers
    assert page.json()["projection_revision"] is None
    assert full.json()["projection_revision"] == streamed.json()["projection_revision"]


async def test_summary_batches_keep_one_revision_and_reuse_unchanged_selection_rows(
    selection_client, monkeypatch
) -> None:
    from engine.api.routes import library
    from engine.services import library_summary

    client, db, tmp = selection_client
    await seed_photo(db, tmp, "p11", "select", [bird(KING)], scene_id=1)
    await seed_photo(db, tmp, "p12", "select", [bird(KING)], scene_id=1)
    async with db.transaction() as conn:
        # The larger scene crosses every output batch but is still projected
        # together. Its original positions must survive the scene ordering.
        await conn.execute("UPDATE photos SET scene_id = 1 WHERE id IN ('p1', 'p3', 'p9')")
        await conn.execute("UPDATE photos SET scene_id = 2 WHERE id IN ('p2', 'p4')")
    url = "/library/folder?view=summary&include_selection_snapshot=true"
    cache = client._transport.app.state.selection_projections
    original = (await client.get(url)).json()
    first = next(photo for photo in original["photos"] if photo["id"] == "p1")
    assert first["group_species_latin"] == KING[4:]
    assert first["group_species_total"] == 5
    previous = cache.get("folder", original["projection_revision"])
    assert previous is not None

    monkeypatch.setattr(library, "_SUMMARY_STREAM_THRESHOLD", 1)
    monkeypatch.setattr(library, "_SUMMARY_ROWS_PER_CHUNK", 3)
    monkeypatch.setattr(library_summary, "_SCENE_BATCH_SIZE", 2)
    headers = {"Accept": "application/x-ndjson"}

    def decode(batch_response):
        assert batch_response.status_code == 200
        assert batch_response.headers["content-type"] == "application/x-ndjson"
        frames = [json.loads(line) for line in batch_response.text.splitlines()]
        photos = [photo for batch in frames[1:-1] for photo in batch]
        assert len(photos) == frames[-1]
        return frames[0] | {"photos": photos}

    assert decode(await client.get(url, headers=headers)) == original
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
            "VALUES ('p1', 'reject', '2026-11-20')"
        )
    current = decode(await client.get(url, headers=headers))
    assert current["projection_revision"] != original["projection_revision"]
    updated = cache.get("folder", current["projection_revision"])
    assert updated is not None
    before_by_id = {photo.id: photo for photo in previous.photos}
    after_by_id = {photo.id: photo for photo in updated.photos}
    assert after_by_id["p1"] is not before_by_id["p1"]
    assert after_by_id["p1"].decision == "reject"
    assert after_by_id["p2"] is before_by_id["p2"]
    endpoint = "/library/folder/selection/query"
    query = {"species_keys": [KING], "sort": "name"}
    live = await client.post(endpoint, json=query)
    pinned = await client.post(
        endpoint, params={"projection_revision": current["projection_revision"]}, json=query
    )
    old = await client.post(
        endpoint, params={"projection_revision": original["projection_revision"]}, json=query
    )
    assert pinned.status_code == old.status_code == live.status_code == 200
    assert pinned.json() == live.json()
    assert "p1" in old.json()["matched_photo_ids"]
    assert "p1" not in pinned.json()["matched_photo_ids"]


async def test_summary_filters_match_full_view_and_review_loads_complete_metadata(
    selection_client,
) -> None:
    client, db, tmp = selection_client
    best = bird(KING, flying=True)
    best["pose"]["tail"] = {"x": 18, "y": 42, "confidence": 0.91}
    best["species_candidates"].append(bird(EGRET)["species_candidates"][0])
    await seed_photo(db, tmp, "review-row", "select", [best, bird(EGRET, index=1)])
    gps = {
        "GPSLatitude": [31, 0, 0],
        "GPSLatitudeRef": "N",
        "GPSLongitude": [121, 0, 0],
        "GPSLongitudeRef": "E",
    }
    exif = {"Make": "Test Camera", "LensModel": "600mm", "FocalLength": 600, "GPSInfo": gps}
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE photos SET exif_json = ? WHERE id = 'review-row'",
            (json.dumps(exif),),
        )

    summary_response = await client.get(
        "/library/folder?view=summary&include_selection_snapshot=true"
    )
    assert summary_response.status_code == 200, summary_response.text
    summary = summary_response.json()
    full = (await client.get("/library/folder")).json()
    assert summary["projection_revision"] == full["projection_revision"]
    assert [row["id"] for row in summary["photos"]] == [row["id"] for row in full["photos"]]
    compact = next(row for row in summary["photos"] if row["id"] == "review-row")
    assert compact["best_detection"]["pose"]["posture"] == "flying"
    assert compact["best_detection"]["pose"].get("tail") is None
    assert "species_candidates" not in compact["best_detection"]
    assert compact["best_detection"]["candidate_confidence"] == 0.95
    assert (compact.get("exif") or {}).get("Make") is None
    assert (compact.get("exif") or {}).get("FocalLength") == 600
    assert (compact.get("exif") or {}).get("GPSInfo") == gps

    review_response = await client.get("/library/photo/review-row/review")
    assert review_response.status_code == 200, review_response.text
    review = review_response.json()
    assert review["library_id"] == "folder"
    hydrated = review["photo"]
    assert hydrated == next(row for row in full["photos"] if row["id"] == "review-row")
    assert hydrated["review_revision"] == compact["review_revision"]
    assert hydrated["review_revision"]
    assert hydrated["best_detection"]["pose"]["tail"] == best["pose"]["tail"]
    assert hydrated["exif"] == exif
    assert len(hydrated["best_detection"]["species_candidates"]) == 2
    assert (await client.get("/library/photo/missing/review")).status_code == 404

    query = {
        "species_keys": [KING],
        "only_flying": True,
        "include_review": False,
        "sort": "name",
    }
    route = "/library/folder/selection/query"
    pinned = await client.post(
        route, params={"projection_revision": summary["projection_revision"]}, json=query
    )
    live = await client.post(route, json=query)
    assert pinned.status_code == live.status_code == 200
    assert pinned.json() == live.json()
    assert pinned.json()["matched_photo_ids"] == ["review-row"]

    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE photos SET thumb_preview = 'preview/repaired.jpg', city = 'Refreshed city' "
            "WHERE id = 'review-row'"
        )
    refreshed = (await client.get("/library/folder?view=summary")).json()
    assert refreshed["projection_revision"] == summary["projection_revision"]
    display_only = next(row for row in refreshed["photos"] if row["id"] == "review-row")
    assert display_only["review_revision"] != compact["review_revision"]

    # A re-analysis can replace heavy data while retaining the same source revision.
    best["pose"]["tail"]["x"] = 25
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE analysis_results SET result_json = ? WHERE photo_id = 'review-row'",
            (json.dumps({"detections": [best, bird(EGRET, index=1)]}),),
        )
    replacement = (await client.get("/library/photo/review-row/review")).json()["photo"]
    assert replacement["input_revision"] == hydrated["input_revision"]
    assert replacement["review_revision"] != display_only["review_revision"]
    assert replacement["best_detection"]["pose"]["tail"]["x"] == 25
    with pytest.raises(SelectionRevisionConflict):
        await freeze_selection(
            db, "folder", SelectionQueryRequest(**query), summary["projection_revision"]
        )


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
    review = (await client.get("/library/photo/c4/review")).json()["photo"]
    assert review == current


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


async def test_consensus_manual_vote_metadata_is_shared_by_summary_review_and_export(
    selection_client,
) -> None:
    client, db, tmp = selection_client
    for photo_id in ("a-manual", "b-vote", "c-vote"):
        await seed_photo(db, tmp, photo_id, "select", [bird(KING)], scene_id=83)
    await seed_photo(db, tmp, "z-follower", "select", [bird(EGRET, review=True)], scene_id=83)
    await set_species_override(
        db,
        "a-manual",
        0,
        {"canonical_sci": "Alcedo atthis", "canonical_zh": "普通翠鸟", "canonical_en": None},
    )
    full = (await client.get("/library/folder")).json()
    summary = (
        await client.get("/library/folder?view=summary&include_selection_snapshot=true")
    ).json()
    assert summary["projection_revision"] == full["projection_revision"]
    follower = next(row for row in summary["photos"] if row["id"] == "z-follower")
    assert follower["species_source"] == "group_consensus"
    review = (await client.get("/library/photo/z-follower/review")).json()["photo"]
    assert review["review_revision"] == follower["review_revision"]
    assert review["best_detection"]["species_english"] == "common kingfisher"
    query = {"species_keys": [KING], "photo_query": "common kingfisher"}
    selected = await client.post(
        "/library/folder/selection/query",
        params={"projection_revision": summary["projection_revision"]},
        json=query,
    )
    assert selected.status_code == 200, selected.text
    assert "z-follower" in selected.json()["matched_photo_ids"]
    frozen = await freeze_selection(
        db, "folder", SelectionQueryRequest(**query), summary["projection_revision"]
    )
    assert "z-follower" in frozen.photo_ids


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


async def test_selection_stays_on_the_requested_detail_revision(selection_client) -> None:
    client, db, _tmp = selection_client
    detail_url = "/library/folder?include_selection_snapshot=true"
    selection_url = "/library/folder/selection/query"
    body = {"species_keys": [KING], "sort": "name"}
    detail = (await client.get(detail_url)).json()
    revision = detail["projection_revision"]
    before = (await client.post(selection_url, json=body)).json()
    assert before["projection_revision"] == revision
    assert before["matched_photo_ids"] == ["p1", "p2", "p3", "p6", "p9"]

    await set_decision(db, "p1", Decision.REJECT)
    newer_detail = (await client.get(detail_url)).json()
    latest = (await client.post(selection_url, json=body)).json()
    assert latest["matched_photo_ids"] == ["p2", "p3", "p6", "p9"]
    assert latest["projection_revision"] == newer_detail["projection_revision"] != revision
    assert next(f["photo_count"] for f in latest["facets"] if f["key"] == KING) == 4

    pinned = await client.post(selection_url, params={"projection_revision": revision}, json=body)
    assert pinned.status_code == 200, pinned.text
    assert pinned.json() == before
    with pytest.raises(SelectionRevisionConflict):
        await freeze_selection(db, "folder", SelectionQueryRequest(**body), revision)

    await set_decision(db, "p2", Decision.REJECT)
    third = (await client.get(detail_url)).json()
    assert third["projection_revision"] not in {revision, latest["projection_revision"]}
    expired = await client.post(selection_url, params={"projection_revision": revision}, json=body)
    assert expired.status_code == 409
    assert expired.json() == {"detail": "Selection snapshot expired"}


async def test_selection_reads_committed_state_while_writer_is_open(selection_client) -> None:
    client, db, _tmp = selection_client
    selection_url = "/library/folder/selection/query"
    body = {"species_keys": [KING], "grades": ["select"], "sort": "name"}
    before = (await client.post(selection_url, json=body)).json()
    written = asyncio.Event()
    finish = asyncio.Event()

    async def writer() -> None:
        async with db.transaction():
            await set_decision(db, "p1", Decision.REJECT)
            written.set()
            await finish.wait()

    task = asyncio.create_task(writer())
    try:
        await asyncio.wait_for(written.wait(), timeout=2)
        response = await asyncio.wait_for(client.post(selection_url, json=body), timeout=2)
        assert response.status_code == 200, response.text
        assert response.json() == before
    finally:
        finish.set()
        await task

    after = (await client.post(selection_url, json=body)).json()
    assert before["matched_photo_ids"] == ["p1", "p9"]
    assert after["matched_photo_ids"] == ["p9"]
    assert after["projection_revision"] != before["projection_revision"]
    detail = (await client.get("/library/folder")).json()
    assert detail["projection_revision"] == after["projection_revision"]


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


async def test_score_sort_prioritizes_effective_grade_and_stable_tiebreakers_through_freeze(
    selection_client,
) -> None:
    client, db, tmp = selection_client
    burst_rows = [
        ("b-auto-high", "usable", 0.85, "2026-11-17T08:10:00+00:00", "BURST_0001.JPG"),
        ("b-manual-up", "record", 0.62, "2026-11-17T08:10:01+00:00", "BURST_0002.JPG"),
        ("b-tie-late", "usable", 0.75, "2026-11-17T08:10:03+00:00", "BURST_0003.JPG"),
        ("b-tie-early", "usable", 0.75, "2026-11-17T16:10:02+08:00", "BURST_0009.JPG"),
        ("b-tie-name-b", "usable", 0.75, "2026-11-17T08:10:03+00:00", "BURST_0004.JPG"),
        ("b-tie-id-b", "usable", 0.75, "2026-11-17T08:10:03+00:00", "BURST_0003.JPG"),
    ]
    async with db.transaction() as conn:
        for photo_id, grade, score, shot_at, file_name in burst_rows:
            await conn.execute(
                "INSERT INTO photos (id, library_id, file_path, file_name, file_size, "
                "file_mtime, file_hash, format, created_at, scene_id) "
                "VALUES (?, 'folder', ?, ?, 10, ?, ?, 'JPG', ?, 77)",
                (
                    photo_id,
                    str(tmp / f"{photo_id}.jpg"),
                    file_name,
                    shot_at,
                    f"hash-{photo_id}",
                    shot_at,
                ),
            )
            await conn.execute(
                "INSERT INTO analysis_results (id, photo_id, pipeline_version, result_json, "
                "quality_score, grade, bird_count, species, created_at, is_active) "
                "VALUES (?, ?, 'test-v1', ?, ?, ?, 1, '普通翠鸟', ?, 1)",
                (
                    f"result-{photo_id}",
                    photo_id,
                    json.dumps({"detections": [bird(KING)]}),
                    score,
                    grade,
                    shot_at,
                ),
            )
    await set_decision(db, "b-manual-up", Decision.SELECT)

    full_query = {"photo_query": "BURST_", "sort": "score"}
    full_response = await client.post("/library/folder/selection/query", json=full_query)
    assert full_response.status_code == 200, full_response.text
    full_data = full_response.json()
    expected_full = [
        "b-manual-up",
        "b-auto-high",
        "b-tie-early",
        "b-tie-id-b",
        "b-tie-late",
        "b-tie-name-b",
    ]
    assert full_data["matched_photo_ids"] == expected_full
    frozen_full = await freeze_selection(
        db,
        "folder",
        SelectionQueryRequest(**full_query),
        full_data["projection_revision"],
    )
    assert list(frozen_full.photo_ids) == expected_full

    usable_only = {"photo_query": "BURST_", "grades": ["usable"], "sort": "score"}
    filtered_response = await client.post("/library/folder/selection/query", json=usable_only)
    assert filtered_response.status_code == 200, filtered_response.text
    filtered_data = filtered_response.json()
    expected_filtered = [
        "b-auto-high",
        "b-tie-early",
        "b-tie-id-b",
        "b-tie-late",
        "b-tie-name-b",
    ]
    assert filtered_data["matched_photo_ids"] == expected_filtered
    frozen_filtered = await freeze_selection(
        db,
        "folder",
        SelectionQueryRequest(**usable_only),
        filtered_data["projection_revision"],
    )
    assert list(frozen_filtered.photo_ids) == expected_filtered
