# pyright: basic
"""Health check endpoint with pipeline status."""

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/health")
async def health_check(request: Request) -> dict[str, Any]:
    pipeline = request.app.state.pipeline

    return {
        "status": "ok",
        "version": "0.1.0",
        "pipeline": {
            "ready": pipeline.is_ready,
            "version": pipeline.pipeline_version,
            "models": {
                name: {
                    "loaded": loaded,
                    "provider": pipeline.model_providers.get(name),
                }
                for name, loaded in pipeline.model_status.items()
            },
        },
    }
