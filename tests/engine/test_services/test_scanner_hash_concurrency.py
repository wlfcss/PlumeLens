"""Import preparation and Start must not hash the same large RAW simultaneously."""

import asyncio
import time
from pathlib import Path

from engine.core.database import Database
from engine.services import scanner


async def test_concurrent_hash_backfills_read_each_file_once(tmp_path: Path, monkeypatch):
    photo = tmp_path / "photo.CR3"
    photo.write_bytes(b"raw-photo-fixture")
    db = Database(tmp_path / "hashes.db")
    await db.connect()
    try:
        size, mtime = scanner._light_fingerprint(photo)
        async with db.transaction() as conn:
            await conn.execute(
                "INSERT INTO libraries (id,display_name,parent_path,root_path,status,recursive,"
                "created_at,last_opened_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                ("lib", "Library", str(tmp_path.parent), str(tmp_path), "ready", 1, mtime, mtime),
            )
            await conn.execute(
                "INSERT INTO photos (id,file_path,file_name,file_size,file_mtime,format,"
                "created_at,library_id) "
                "VALUES (?,?,?,?,?,?,?,?)",
                ("photo", str(photo), photo.name, size, mtime, "CR3", mtime, "lib"),
            )
        original = scanner._sha256_file
        reads = []

        def counted_hash(path):
            reads.append(path)
            time.sleep(0.05)
            return original(path)

        monkeypatch.setattr(scanner, "_sha256_file", counted_hash)
        counts = await asyncio.gather(
            scanner.backfill_hashes(db, "lib"), scanner.backfill_hashes(db, "lib")
        )
        assert sum(counts) == 1
        assert reads == [photo]
    finally:
        await db.close()
