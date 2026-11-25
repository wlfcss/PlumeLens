"""Wave 2 verification tests: set-based batch enqueue, pure ASGI auth, lazy YOLO fallback."""

from __future__ import annotations

from pathlib import Path

import pytest
from engine.core.database import Database
from engine.services.queue import enqueue_photos, get_stats


@pytest.mark.asyncio
async def test_enqueue_photos_chunked_batch_over_500_items(tmp_path: Path) -> None:
    db = Database(tmp_path / "batch.db")
    await db.connect()
    try:
        async with db.transaction() as conn:
            await conn.execute(
                "INSERT INTO libraries "
                "(id, display_name, parent_path, root_path, status, created_at, last_opened_at) "
                "VALUES ('lib1', 'L1', '/tmp', '/tmp/L1', 'ready', '2026-01-01T00:00:00Z', "
                "'2026-01-01T00:00:00Z')"
            )
            rows = [
                (
                    f"p-{i:04d}",
                    f"/tmp/L1/IMG_{i:04d}.JPG",
                    f"IMG_{i:04d}.JPG",
                    1024,
                    "2026-01-01T00:00:00Z",
                    f"hash-{i:04d}",
                    "jpg",
                    "2026-01-01T00:00:00Z",
                    "lib1",
                )
                for i in range(620)
            ]
            await conn.executemany(
                "INSERT INTO photos "
                "(id, file_path, file_name, file_size, file_mtime, file_hash, format, "
                "created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )

        photo_ids = [f"p-{i:04d}" for i in range(620)]
        inserted = await enqueue_photos(
            db, "lib1", photo_ids, current_pipeline_version="v2-test"
        )
        assert inserted == 620
        stats = await get_stats(db, "lib1")
        assert stats["pending"] == 620

        # Idempotent re-enqueue skips already active rows via ON CONFLICT DO NOTHING
        inserted_again = await enqueue_photos(
            db, "lib1", photo_ids, current_pipeline_version="v2-test"
        )
        assert inserted_again == 0
    finally:
        await db.close()
