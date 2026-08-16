# pyright: basic
"""Export endpoints (start + SSE progress + cancel).

导出是长任务(实测 964 张 / 80 GB 需要约两小时),不能塞在一个 HTTP 请求里 ——
所以 ``POST /export/library/{id}`` 只做预检并立刻返回 job_id,进度走 SSE,
用户可随时 cancel。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from engine.api.schemas.export import (
    ExportFormatsResponse,
    ExportJobCancelResponse,
    ExportJobStartResponse,
    ExportLibraryRequest,
)
from engine.core.database import Database
from engine.services.exporter import (
    JOB_RUNNING,
    ExportError,
    ExportJob,
    cancel_export_job,
    get_export_job,
    list_export_formats,
    start_export_job,
)

router = APIRouter(prefix="/export", tags=["export"])

# 进度帧最小间隔(秒)。单张 RAW 复制约 1s,0.5s 足够让 N/M 看起来是连续走的,
# 又不会把事件循环刷满;内容未变的帧直接跳过不发。
SSE_INTERVAL = 0.5

# ExportError.code → HTTP status。其余一律 400(请求本身不合法)。
_ERROR_STATUS: dict[str, int] = {
    "library_not_found": 404,
    "export_already_running": 409,
}


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


def _http_error(exc: ExportError) -> HTTPException:
    """把 ExportError 转成结构化 detail。

    前端按 ``code`` 查 i18n 表渲染中文,``context`` 里的数值(如 required_bytes /
    free_bytes)让文案能说清"还差多少";``message`` 只作为没有对应 i18n key 时的兜底。
    """
    return HTTPException(
        status_code=_ERROR_STATUS.get(exc.code, 400),
        detail={"code": exc.code, "message": str(exc), **exc.context},
    )


@router.post("/library/{library_id}", response_model=ExportJobStartResponse)
async def export_library_route(
    request: Request,
    library_id: str,
    body: ExportLibraryRequest,
) -> ExportJobStartResponse:
    db = await _db(request)
    try:
        job = await start_export_job(db, library_id, body)
    except ExportError as exc:
        raise _http_error(exc) from exc
    return ExportJobStartResponse(
        job_id=job.job_id,
        library_id=job.library_id,
        total=job.total,
        total_bytes=job.total_bytes,
    )


@router.get("/library/{library_id}/formats", response_model=ExportFormatsResponse)
async def export_formats_route(request: Request, library_id: str) -> ExportFormatsResponse:
    """源图库里实际存在哪些格式 —— 导出面板据此展示可勾选项。"""
    db = await _db(request)
    try:
        formats = await list_export_formats(db, library_id)
    except ExportError as exc:
        raise _http_error(exc) from exc
    return ExportFormatsResponse(formats=formats)


def _require_job(job_id: str) -> ExportJob:
    job = get_export_job(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "job_not_found", "message": "Export job not found"},
        )
    return job


@router.get("/jobs/{job_id}")
async def export_job_snapshot(job_id: str) -> dict:
    """一次性快照 — 供 SSE 断线重连后对齐状态。"""
    return _require_job(job_id).snapshot()


@router.post("/jobs/{job_id}/cancel", response_model=ExportJobCancelResponse)
async def cancel_export_job_route(job_id: str) -> ExportJobCancelResponse:
    job = cancel_export_job(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "job_not_found", "message": "Export job not found"},
        )
    return ExportJobCancelResponse(job_id=job.job_id, status=job.status)


async def _job_stream(job: ExportJob) -> AsyncIterator[str]:
    """SSE 帧生成器:内容有变化才发,进终态发完最后一帧即收流。

    与 analysis 的 progress 流不同 —— 那条流要一直挂着等用户点「开始分析」,
    而一个导出 job 有明确终点,收流后前端不该重连(否则会对一个已完成的 job
    反复建连)。
    """
    last: str | None = None
    try:
        while True:
            snapshot = job.snapshot()
            payload = json.dumps(snapshot, ensure_ascii=False)
            if payload != last:
                yield f"data: {payload}\n\n"
                last = payload
            if snapshot["status"] != JOB_RUNNING:
                return
            await asyncio.sleep(SSE_INTERVAL)
    except asyncio.CancelledError:
        # 客户端断开 —— 只停推送,不取消导出。收起/关闭面板不该毁掉跑了一半的导出,
        # 取消必须是用户显式点「取消导出」(POST /jobs/{id}/cancel)。
        return


@router.get("/jobs/{job_id}/events")
async def export_job_events(job_id: str) -> StreamingResponse:
    job = _require_job(job_id)
    return StreamingResponse(
        _job_stream(job),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
