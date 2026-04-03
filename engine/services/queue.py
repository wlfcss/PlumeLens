"""Batch analysis task queue with state machine."""

# TODO: 状态机: pending → processing → completed/failed/dead
# TODO: 持久化到 SQLite task_queue 表
# TODO: 暂停/恢复/取消
# TODO: 断点续跑（应用重启后 processing → pending）
# TODO: 自动重试（max 3 次）
# TODO: SSE 进度推送
# TODO: Backpressure（队列满时暂停入队）
