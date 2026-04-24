"""SQLite database connection management (WAL mode, aiosqlite)."""

from __future__ import annotations

from pathlib import Path

import aiosqlite
import structlog

logger = structlog.stdlib.get_logger()

SCHEMA_VERSION = 2

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
        created_at TEXT NOT NULL,
        library_id TEXT NOT NULL,
        FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_photos_library ON photos(library_id, created_at);",
    "CREATE INDEX IF NOT EXISTS ix_photos_hash ON photos(file_hash);",
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
    # --- photo_decisions：用户对每张照片的复核决定 ---
    # 独立一张表而非扩展 photos，避免 scan 流程触及 user decision 数据
    """
    CREATE TABLE IF NOT EXISTS photo_decisions (
        photo_id TEXT PRIMARY KEY,
        decision TEXT NOT NULL,  -- unreviewed / selected / maybe / rejected
        updated_at TEXT NOT NULL,
        FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_decisions_decision ON photo_decisions(decision);",
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
        for stmt in _SCHEMA_STATEMENTS:
            await self._conn.execute(stmt)
        # 记录 schema 版本（供未来迁移判断）
        await self._conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION};")
        await self._conn.commit()

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
