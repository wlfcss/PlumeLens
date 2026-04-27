# pyright: basic
"""Health check endpoint with pipeline status."""

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/health")
async def health_check(request: Request) -> dict[str, Any]:
    pipeline = request.app.state.pipeline

    # 从 FastAPI app 元数据动态读版本，与 main.py 单一来源同步
    # （之前硬编码 0.1.0 在 0.2.0 升级时漏改）
    return {
        "status": "ok",
        "version": request.app.version,
        "pipeline": {
            "ready": pipeline.is_ready,
            "version": pipeline.pipeline_version,
            "quality_available": pipeline.quality_available,
            "pose_available": pipeline.pose_available,
            "species_available": pipeline.species_available,
            "models": {
                name: {
                    "loaded": loaded,
                    "provider": pipeline.model_providers.get(name),
                }
                for name, loaded in pipeline.model_status.items()
            },
        },
    }
