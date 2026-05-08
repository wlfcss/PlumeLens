"""SQLite database connection management (WAL mode, aiosqlite)."""

from __future__ import annotations

import contextlib
from pathlib import Path

import aiosqlite
import structlog

logger = structlog.stdlib.get_logger()

SCHEMA_VERSION = 10

# SQL 放在模块常量里便于审阅与测试
_SCHEMA_STATEMENTS: tuple[str, ...] = (
    # --- libraries：用户导入的文件夹（选片工作区的根单位） ---
    """
    CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        parent_path TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'idle',
        recursive INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL,
        last_scanned_at TEXT,
        last_analyzed_at TEXT
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_libraries_status ON libraries(status);",
    """
    CREATE INDEX IF NOT EXISTS ix_libraries_last_opened
        ON libraries(last_opened_at DESC);
    """,
    # --- photos：扫描入库的照片元数据 ---
    """
    CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_mtime TEXT NOT NULL,
        file_hash TEXT,                  -- 后台补强（SHA-256 全量哈希）
        format TEXT,
        width INTEGER,
        height INTEGER,
        exif_json TEXT,
        thumb_grid TEXT,
        thumb_preview TEXT,
        scene_id INTEGER,                -- 场景分组 id（同 library 内部，从 0 起）
        -- v7：JPG/RAW 同名 pair 的同伴文件信息(主 entry 走 file_path,companion 不入
        -- photos 单独 entry,只在主 entry 里记。导出 RAW / UI 显示 +RAW 标签用)。
        -- pair 检测规则: 同目录 + 同 stem + 一个 IMAGE_EXTENSIONS + 一个 RAW_EXTENSIONS。
        -- 主 entry 优先 IMAGE(JPG 等,跑管线快);仅有 RAW 时主就是 RAW,companion=NULL。
        companion_path TEXT,             -- 同伴文件绝对路径,无 pair 时 NULL
        companion_format TEXT,           -- 同伴文件大写格式名(CR3/NEF/ARW/JPG...)
        companion_size INTEGER,          -- 同伴文件字节数(UI 显示+导出确认)
        -- v8: GPS reverse geocoding 持久化(羽迹三级地图聚合用)。photos 表里
        -- 这 5 列是从 exif.GPSInfo 解析后调 reverse_geocoding 填的;无 GPS 时全 NULL。
        -- lifespan 启动期 backfill_locations 后台扫一遍补全。
        country TEXT,                    -- "中国" / "United States" / ...
        province TEXT,                   -- "江苏省" / "California"  (admin1)
        city TEXT,                       -- "苏州市" / "San Francisco" (admin2)
        district TEXT,                   -- "姑苏区" / "Mission" (admin3 / 市辖区)
        place TEXT,                      -- POI 名称: "太湖湿地公园" / 街道地址 / 完整 display_name
        created_at TEXT NOT NULL,
        library_id TEXT NOT NULL,
        FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_photos_library ON photos(library_id, created_at);",
    "CREATE INDEX IF NOT EXISTS ix_photos_hash ON photos(file_hash);",
    # 注意：ix_photos_province (province 索引) 只能在 v8 migration 里建,
    # 不能放进 _SCHEMA_STATEMENTS — v7→v8 升级路径上 ALTER TABLE ADD COLUMN
    # province 还没跑,这里 CREATE INDEX 会报 "no such column: province"。
    # --- analysis_results：每张照片的分析结果（按 pipeline_version 区分） ---
    """
    CREATE TABLE IF NOT EXISTS analysis_results (
        id TEXT PRIMARY KEY,
        photo_id TEXT NOT NULL,
        pipeline_version TEXT NOT NULL,
        result_json TEXT NOT NULL,
        quality_score REAL,
        grade TEXT,
        bird_count INTEGER NOT NULL DEFAULT 0,
        species TEXT,
        created_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
        UNIQUE(photo_id, pipeline_version)
    );
    """,
    # 部分唯一索引：保证每张照片至多一条 active（数据库层约束，不依赖应用逻辑）
    """
    CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_active
        ON analysis_results(photo_id)
        WHERE is_active = 1;
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_analysis_quality
        ON analysis_results(quality_score DESC);
    """,
    "CREATE INDEX IF NOT EXISTS ix_analysis_grade ON analysis_results(grade);",
    # --- task_queue：批量分析任务队列（状态机持久化） ---
    """
    CREATE TABLE IF NOT EXISTS task_queue (
        id TEXT PRIMARY KEY,
        photo_id TEXT NOT NULL,
        library_id TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
        FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_queue_status_priority
        ON task_queue(status, priority, created_at);
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_queue_library_status
        ON task_queue(library_id, status);
    """,
    # --- photo_decisions：用户对每张照片的人工评级覆盖 ---
    # 只保存人工覆盖值；无行表示使用系统自动 grade。
    """
    CREATE TABLE IF NOT EXISTS photo_decisions (
        photo_id TEXT PRIMARY KEY,
        decision TEXT NOT NULL,  -- select / usable / record / reject
        updated_at TEXT NOT NULL,
        FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_decisions_decision ON photo_decisions(decision);",
    # --- photo_species_overrides：用户对每张照片中每只鸟的人工鸟种覆盖 ---
    # 主键 (photo_id, bird_index) — bird_index 是写入时 detections 数组的位置。
    # 但 bird_index 不是稳定 ID（pipeline_version bump / IoU dedup 后 detections
    # 数组重排会让旧 bird_index 错配）。read-time 优先用 bbox_x1/y1/x2/y2 与新
    # detections 做 IoU 匹配（>= IoU 阈值才认为是同一只鸟），bird_index 仅作为
    # 老数据 fallback。bbox 字段在 v6 schema 加入，老数据为 NULL。
    """
    CREATE TABLE IF NOT EXISTS photo_species_overrides (
        photo_id TEXT NOT NULL,
        bird_index INTEGER NOT NULL DEFAULT 0,
        canonical_sci TEXT NOT NULL,
        canonical_zh TEXT,
        canonical_en TEXT,
        bbox_x1 REAL,
        bbox_y1 REAL,
        bbox_x2 REAL,
        bbox_y2 REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (photo_id, bird_index),
        FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_species_overrides_photo
        ON photo_species_overrides(photo_id);
    """,
)


class Database:
    """Async SQLite wrapper with WAL mode and schema lifecycle.

    Single persistent connection — SQLite is single-writer by design, and WAL
    mode lets readers proceed concurrently with the writer. For higher
    concurrency we could add a read-replica connection later.

    Usage (typically from FastAPI lifespan):
        db = Database(path)
        await db.connect()
        app.state.db = db
        ...
        await db.close()

    Services access the underlying aiosqlite connection via `.conn`:
        async with db.conn.execute("SELECT ...") as cur:
            ...
    """

    def __init__(self, db_path: Path) -> None:
        self._path = db_path
        self._conn: aiosqlite.Connection | None = None

    @property
    def path(self) -> Path:
        return self._path

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            msg = "Database not connected; call connect() first"
            raise RuntimeError(msg)
        return self._conn

    async def connect(self) -> None:
        """Open the SQLite connection, configure PRAGMAs, ensure schema.

        Safe to call multiple times — subsequent calls are no-ops if connected.
        """
        if self._conn is not None:
            return

        # 保证父目录存在（首次启动时 ~/.plumelens/ 可能刚创建）
        self._path.parent.mkdir(parents=True, exist_ok=True)
        await logger.ainfo("Opening database", path=str(self._path))

        conn = await aiosqlite.connect(str(self._path))
        conn.row_factory = aiosqlite.Row
        self._conn = conn

        await self._configure_pragmas()
        await self._ensure_schema()

    async def _configure_pragmas(self) -> None:
        assert self._conn is not None
        # WAL：允许读写并发；崩溃恢复更强
        await self._conn.execute("PRAGMA journal_mode = WAL;")
        # 写超时 5 秒（在 busy 时自动重试）
        await self._conn.execute("PRAGMA busy_timeout = 5000;")
        # 外键约束打开（默认关闭，容易踩坑）
        await self._conn.execute("PRAGMA foreign_keys = ON;")
        # WAL 配合 NORMAL 同步模式，性能显著优于 FULL 且安全性足够
        await self._conn.execute("PRAGMA synchronous = NORMAL;")
        # 临时表使用内存
        await self._conn.execute("PRAGMA temp_store = MEMORY;")
        await self._conn.commit()

    async def _ensure_schema(self) -> None:
        assert self._conn is not None
        # 记录之前的 user_version（迁移用）
        async with self._conn.execute("PRAGMA user_version;") as cur:
            row = await cur.fetchone()
        prior_version = int(row[0]) if row else 0

        for stmt in _SCHEMA_STATEMENTS:
            await self._conn.execute(stmt)

        await self._migrate_from(prior_version)

        # 记录 schema 版本
        await self._conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION};")
        await self._conn.commit()

    async def _migrate_from(self, prior_version: int) -> None:
        """对老库做增量列添加（CREATE TABLE IF NOT EXISTS 不会改已存在的表结构）。"""
        assert self._conn is not None
        if prior_version < 3:
            # v3：photos 加 scene_id（之前 v1/v2 表没这列）
            try:
                await self._conn.execute(
                    "ALTER TABLE photos ADD COLUMN scene_id INTEGER",
                )
                await logger.ainfo(
                    "DB migrated",
                    from_version=prior_version,
                    added="photos.scene_id",
                )
            except Exception as e:
                # 如果列已存在（重复迁移），SQLite 会抛 OperationalError；忽略
                if "duplicate column" not in str(e).lower():
                    raise
        if prior_version < 4:
            # v4：人工筛选从 selected/maybe/rejected/unreviewed 迁移到
            # 与系统 grade 同一套 select/usable/record/reject。unreviewed 代表无人工覆盖，
            # 直接删行；maybe 无一一对应档位，按保守口径归入 record。
            await self._conn.execute(
                "UPDATE photo_decisions SET decision = 'select' WHERE decision = 'selected'",
            )
            await self._conn.execute(
                "UPDATE photo_decisions SET decision = 'record' WHERE decision = 'maybe'",
            )
            await self._conn.execute(
                "UPDATE photo_decisions SET decision = 'reject' WHERE decision = 'rejected'",
            )
            await self._conn.execute(
                "DELETE FROM photo_decisions WHERE decision = 'unreviewed'",
            )
            await logger.ainfo(
                "DB migrated",
                from_version=prior_version,
                changed="photo_decisions.grade_values",
            )
        if prior_version < 6:
            # v6：photo_species_overrides 加 bbox 字段 — 不再用 bird_index 这种
            # 不稳定下标作为主匹配（IoU dedup / pipeline_version bump 让数组
            # 重排，旧 bird_index 会错配）。新数据写入时记 bbox，read-time 用
            # IoU 匹配新 detections；老数据 bbox=NULL，仍 fallback 到 bird_index。
            for col in ("bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2"):
                try:
                    await self._conn.execute(
                        f"ALTER TABLE photo_species_overrides ADD COLUMN {col} REAL",
                    )
                except Exception as e:
                    if "duplicate column" not in str(e).lower():
                        raise
            await logger.ainfo(
                "DB migrated",
                from_version=prior_version,
                added="photo_species_overrides.bbox_*",
            )
        if prior_version < 7:
            # v7：photos 加 companion_path/format/size 三列。JPG/RAW 同名 pair 主
            # entry(优先 IMAGE,无 IMAGE 才 RAW)记 companion 同伴文件信息,RAW 同伴
            # 不入 photos 单独 entry — 避免一对照片被分析两次/各打一次决策。
            # 老数据列默认 NULL → 启动期 backfill_companion(scanner) 扫一次填充,
            # 之后 scan_library 每次都维护。
            for col, ctype in (
                ("companion_path", "TEXT"),
                ("companion_format", "TEXT"),
                ("companion_size", "INTEGER"),
            ):
                try:
                    await self._conn.execute(
                        f"ALTER TABLE photos ADD COLUMN {col} {ctype}",
                    )
                except Exception as e:
                    if "duplicate column" not in str(e).lower():
                        raise
            await logger.ainfo(
                "DB migrated",
                from_version=prior_version,
                added="photos.companion_*",
            )
        if prior_version < 8:
            # v8：photos 加 country/province/city/district/place 五列(reverse
            # geocoding 持久化)。羽迹页面三级地图聚合用 province / city,
            # 三级 marker 弹卡用 place。lifespan 启动期 backfill 后台填充。
            for col in ("country", "province", "city", "district", "place"):
                try:
                    await self._conn.execute(
                        f"ALTER TABLE photos ADD COLUMN {col} TEXT",
                    )
                except Exception as e:
                    if "duplicate column" not in str(e).lower():
                        raise
            # 索引 province 加快"羽迹按省聚合"查询
            with contextlib.suppress(Exception):
                await self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS ix_photos_province "
                    "ON photos(library_id, province) WHERE province IS NOT NULL",
                )
            await logger.ainfo(
                "DB migrated",
                from_version=prior_version,
                added="photos.{country,province,city,district,place}",
            )
        if prior_version < 9:
            # v9：补性能索引。这里只建不改数据，覆盖:
            # - library_detail / export 按库 + 拍摄时间顺序读取 photos
            # - queue.pick_next 按库领取 pending task
            # - archive geo 按省/市/place 查询
            performance_indexes = (
                "CREATE INDEX IF NOT EXISTS ix_photos_library_mtime "
                "ON photos(library_id, file_mtime)",
                "CREATE INDEX IF NOT EXISTS ix_queue_library_pick "
                "ON task_queue(library_id, status, priority DESC, created_at ASC)",
                "CREATE INDEX IF NOT EXISTS ix_photos_library_geo_city "
                "ON photos(library_id, province, city) "
                "WHERE province IS NOT NULL AND city IS NOT NULL",
                "CREATE INDEX IF NOT EXISTS ix_photos_library_geo_place "
                "ON photos(library_id, province, city, place) "
                "WHERE province IS NOT NULL AND city IS NOT NULL",
            )
            for stmt in performance_indexes:
                with contextlib.suppress(Exception):
                    await self._conn.execute(stmt)
            await logger.ainfo(
                "DB migrated",
                from_version=prior_version,
                added="performance_indexes_v9",
            )
        if prior_version < 10:
            # v10:修正学名拼写 — canonical_extended.parquet 历史版本误把 v4
            # extra 物种 "Lanius giganteus"(IOC/BirdLife/Przevalski 1887 标准)
            # 拼成 "Lanius giganteu"(少 's')。canonical 表已修正,这里同步修
            # 用户手动鸟种修正记录里的 sci 字段,避免老 override 与新 sci 不匹配。
            await self._conn.execute(
                "UPDATE photo_species_overrides SET canonical_sci = ? "
                "WHERE canonical_sci = ?",
                ("Lanius giganteus", "Lanius giganteu"),
            )
            await logger.ainfo(
                "DB migrated",
                from_version=prior_version,
                changed="photo_species_overrides.canonical_sci typo fix",
            )

    async def get_schema_version(self) -> int:
        """Return the PRAGMA user_version as stored in this database."""
        assert self._conn is not None
        async with self._conn.execute("PRAGMA user_version;") as cur:
            row = await cur.fetchone()
        return int(row[0]) if row else 0

    async def close(self) -> None:
        """Gracefully close the connection."""
        if self._conn is None:
            return
        try:
            await self._conn.close()
        finally:
            self._conn = None
            await logger.ainfo("Database closed")

    async def list_tables(self) -> list[str]:
        """List all user tables (utility for tests/diagnostics)."""
        assert self._conn is not None
        async with self._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
        ) as cur:
            rows = await cur.fetchall()
        return [str(r[0]) for r in rows]
