"""Central response and pagination budgets for large-library scalability."""

from __future__ import annotations

# Maximum photo rows returned by a single paginated GET /library/{id}?limit=... call.
MAX_LIBRARY_PAGE_LIMIT = 1_000

# Maximum photo IDs returned by a single paginated POST /library/{id}/selection/query call.
MAX_SELECTION_PAGE_LIMIT = 10_000

# Maximum photo IDs hydrated in a single POST /library/{id}/photos/batch call.
MAX_BATCH_PHOTO_IDS = 1_000

# Libraries at or above this size stream NDJSON summary batches to Electron.
SUMMARY_STREAM_THRESHOLD = 2_048

# Number of photo rows emitted per NDJSON / JSON streaming chunk.
SUMMARY_ROWS_PER_CHUNK = 256

# Archive per-species photo browser pagination bounds.
DEFAULT_ARCHIVE_SPECIES_PHOTOS_LIMIT = 200
MAX_ARCHIVE_SPECIES_PHOTOS_LIMIT = 500

# Target compact NDJSON wire budget per photo summary row (for observability & regression checks).
TARGET_COMPACT_SUMMARY_BYTES_PER_PHOTO = 1_024
