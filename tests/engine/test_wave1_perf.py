"""Wave 1 verification tests: orient_array parity, LoRA weight fusion, DB v14 pool & indexes."""

from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np
import pytest
import torch
import torch.nn as nn
from engine.core.database import SCHEMA_VERSION, Database
from engine.core.orientation import orient_array, orient_image
from engine.pipeline.species import LoRALinear
from PIL import Image


@pytest.mark.parametrize("orientation", [1, 2, 3, 4, 5, 6, 7, 8])
def test_orient_array_matches_pil_orient_image_exact(orientation: int) -> None:
    rng = np.random.default_rng(42 + orientation)
    arr = rng.integers(0, 256, size=(17, 29, 3), dtype=np.uint8)
    expected = np.asarray(orient_image(Image.fromarray(arr), orientation), dtype=np.uint8)
    actual = orient_array(arr, orientation)
    assert actual.flags["C_CONTIGUOUS"]
    assert actual.shape == expected.shape
    assert np.array_equal(actual, expected)


def test_lora_linear_merge_into_base_numerical_parity() -> None:
    torch.manual_seed(0)
    base = nn.Linear(32, 48, bias=True)
    lora = LoRALinear(base, r=8, alpha=16.0, dropout=0.0)
    nn.init.normal_(lora.lora_A.weight, std=0.05)
    nn.init.normal_(lora.lora_B.weight, std=0.05)
    lora.eval()

    x = torch.randn(4, 32)
    with torch.no_grad():
        expected = lora(x)
        fused = lora.merge_into_base()
        actual = fused(x)

    assert isinstance(fused, nn.Linear)
    assert torch.allclose(actual, expected, atol=1e-5, rtol=1e-5)


@pytest.mark.asyncio
async def test_database_v14_indexes_and_concurrent_read_pool(tmp_path: Path) -> None:
    db = Database(tmp_path / "pool.db")
    await db.connect()
    try:
        assert await db.get_schema_version() == SCHEMA_VERSION == 14
        async with db.read_snapshot() as conn, conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ) as cur:
            indexes = {str(r[0]) for r in await cur.fetchall()}
        for expected_ix in (
            "ix_photos_library_scene",
            "ix_photos_geo_province_city",
            "ix_photos_library_mtime_id",
            "ix_photos_pending_hash",
            "ix_queue_run_status",
            "ix_queue_processing_started",
            "ix_analysis_runs_state",
        ):
            assert expected_ix in indexes

        # Verify multiple readers can hold snapshots concurrently without blocking each other.
        entered = 0
        both_in = asyncio.Event()

        async def hold_snapshot() -> None:
            nonlocal entered
            async with db.read_snapshot() as conn:
                entered += 1
                if entered >= 2:
                    both_in.set()
                await asyncio.wait_for(both_in.wait(), timeout=2.0)
                async with conn.execute("SELECT 1") as cur:
                    row = await cur.fetchone()
                    assert row is not None and row[0] == 1

        await asyncio.gather(hold_snapshot(), hold_snapshot())
    finally:
        await db.close()
