# pyright: basic
"""Settings, release metadata, and local-data maintenance endpoints."""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from engine.core.config import settings
from engine.core.database import Database
from engine.services import archive_cache
from engine.services.thumbnail import thumbnail_cache_root

router = APIRouter(prefix="/settings", tags=["settings"])
logger = structlog.stdlib.get_logger()


class ModelVersionItem(BaseModel):
    id: str
    label: str
    version: str
    revision: str
    assets: list[str]
    loaded: bool
    provider: str | None = None


class ModelVersionsResponse(BaseModel):
    pipeline_version: str | None
    manifest_generated_at: str | None
    models: list[ModelVersionItem]


class ClearHistoryRequest(BaseModel):
    confirm: bool = False


class ClearHistoryResponse(BaseModel):
    libraries_deleted: int
    photos_deleted: int
    analysis_results_deleted: int
    decisions_deleted: int
    species_overrides_deleted: int
    tasks_deleted: int
    thumbnails_deleted: bool


MODEL_ORDER = (
    "yolo",
    "bird_visibility",
    "bird_flight_classifier",
    "clipiqa",
    "hyperiqa",
    "dinov3_species_v4",
)

LEGACY_MODEL_GROUPS: dict[str, dict[str, object]] = {
    "yolo": {
        "label": "YOLOv26l-bird-det",
        "version": "v1.1",
        "assets": ["yolo26l-bird-det.onnx"],
    },
    "bird_visibility": {
        "label": "bird_visibility",
        "version": "v2.0",
        "assets": ["bird_visibility11.onnx", "bird_visibility11_config.json"],
    },
    "bird_flight_classifier": {
        "label": "bird flight classifier",
        "version": "v1",
        "assets": ["bird_flight_classifier.onnx", "bird_flight_classifier_config.json"],
    },
    "clipiqa": {
        "label": "CLIPIQA+",
        "version": "ONNX",
        "assets": ["clipiqa_plus.onnx"],
    },
    "hyperiqa": {
        "label": "HyperIQA",
        "version": "ONNX",
        "assets": ["hyperiqa.onnx"],
    },
    "dinov3_species_v4": {
        "label": "DINOv3 species",
        "version": "v4",
        "assets": [
            "species/backbone/config.json",
            "species/backbone/model.safetensors",
            "species/canonical_extended.parquet",
            "species/v4_calibration_policy.json",
            "species/v4/seed42_adapter.pt",
        ],
    },
}


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


def _manifest_path() -> Path:
    return settings.models_dir / "manifest.json"


def _model_revision(group_assets: list[str], assets: dict[str, Any]) -> str:
    digest = hashlib.sha256()
    found = False
    for rel in group_assets:
        asset = assets.get(rel)
        if not isinstance(asset, dict):
            continue
        sha = asset.get("sha256")
        if isinstance(sha, str) and sha:
            digest.update(sha.encode("ascii", errors="ignore"))
            found = True
    return digest.hexdigest()[:12] if found else "unknown"


def _meta_assets(meta: dict[str, object]) -> list[str]:
    """Return manifest/group asset paths with runtime validation for typed callers."""
    raw_assets = meta.get("assets", [])
    if not isinstance(raw_assets, list):
        return []
    return [str(item) for item in raw_assets]


def _read_model_manifest() -> tuple[str | None, dict[str, dict[str, object]]]:
    path = _manifest_path()
    if not path.is_file():
        return None, {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("Cannot read model manifest for settings panel", path=str(path))
        return None, {}

    generated_at = raw.get("generated_at") if isinstance(raw.get("generated_at"), str) else None
    assets = raw.get("assets") if isinstance(raw.get("assets"), dict) else {}
    manifest_models = raw.get("models")

    if isinstance(manifest_models, dict) and manifest_models:
        return generated_at, manifest_models

    # Older manifests did not carry grouped model metadata. Keep the settings page
    # useful by deriving asset revisions from the legacy asset section.
    models: dict[str, dict[str, object]] = {}
    for model_id, meta in LEGACY_MODEL_GROUPS.items():
        group_assets = _meta_assets(meta)
        models[model_id] = {
            "label": meta["label"],
            "version": meta["version"],
            "revision": _model_revision(group_assets, assets),
            "assets": group_assets,
        }
    return generated_at, models


@router.get("/models", response_model=ModelVersionsResponse)
async def model_versions(request: Request) -> ModelVersionsResponse:
    """Return model semantic versions plus hash-derived revisions.

    `version` is the human release line (for example bird_visibility v2.0), while
    `revision` is derived from the manifest SHA pins and changes automatically
    whenever a model bundle is regenerated.
    """

    manifest_generated_at, models = _read_model_manifest()
    pipeline = getattr(request.app.state, "pipeline", None)
    status = getattr(pipeline, "model_status", {}) or {}
    providers = getattr(pipeline, "model_providers", {}) or {}

    ordered_ids = [mid for mid in MODEL_ORDER if mid in models]
    ordered_ids.extend(mid for mid in sorted(models) if mid not in ordered_ids)

    return ModelVersionsResponse(
        pipeline_version=getattr(pipeline, "pipeline_version", None),
        manifest_generated_at=manifest_generated_at,
        models=[
            ModelVersionItem(
                id=model_id,
                label=str(models[model_id].get("label", model_id)),
                version=str(models[model_id].get("version", "unknown")),
                revision=str(models[model_id].get("revision", "unknown")),
                assets=_meta_assets(models[model_id]),
                loaded=bool(status.get(model_id, False)),
                provider=(
                    str(providers.get(model_id)) if providers.get(model_id) is not None else None
                ),
            )
            for model_id in ordered_ids
        ],
    )


async def _count_rows(db: Database, table: str) -> int:
    async with db.conn.execute(f"SELECT COUNT(*) AS c FROM {table}") as cur:
        row = await cur.fetchone()
    return int(row["c"]) if row else 0


@router.post("/history/clear", response_model=ClearHistoryResponse)
async def clear_local_history(request: Request, body: ClearHistoryRequest) -> ClearHistoryResponse:
    """Delete app-owned recognition history and thumbnail cache.

    Original source photo folders are never touched; only PlumeLens' own SQLite
    rows and generated thumbnails are removed.
    """

    if not body.confirm:
        raise HTTPException(status_code=400, detail="Explicit confirmation is required")

    db = await _db(request)
    from engine.api.routes.analysis import cancel_all_workers

    workers_stopped = await cancel_all_workers()
    if not workers_stopped:
        raise HTTPException(
            status_code=409,
            detail="Analysis workers are still stopping. Please try again shortly.",
        )

    counts = {
        "libraries": await _count_rows(db, "libraries"),
        "photos": await _count_rows(db, "photos"),
        "analysis_results": await _count_rows(db, "analysis_results"),
        "photo_decisions": await _count_rows(db, "photo_decisions"),
        "photo_species_overrides": await _count_rows(db, "photo_species_overrides"),
        "task_queue": await _count_rows(db, "task_queue"),
    }

    await db.conn.execute("DELETE FROM task_queue")
    await db.conn.execute("DELETE FROM photo_species_overrides")
    await db.conn.execute("DELETE FROM photo_decisions")
    await db.conn.execute("DELETE FROM analysis_results")
    await db.conn.execute("DELETE FROM photos")
    await db.conn.execute("DELETE FROM libraries")
    await db.conn.commit()
    archive_cache.invalidate()

    cache_root = thumbnail_cache_root(settings.data_dir)
    thumbnails_deleted = cache_root.exists()
    if thumbnails_deleted:
        await asyncio.to_thread(shutil.rmtree, cache_root, ignore_errors=True)

    await logger.ainfo("Local recognition history cleared", **counts)
    return ClearHistoryResponse(
        libraries_deleted=counts["libraries"],
        photos_deleted=counts["photos"],
        analysis_results_deleted=counts["analysis_results"],
        decisions_deleted=counts["photo_decisions"],
        species_overrides_deleted=counts["photo_species_overrides"],
        tasks_deleted=counts["task_queue"],
        thumbnails_deleted=thumbnails_deleted,
    )
