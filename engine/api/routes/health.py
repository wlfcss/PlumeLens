# pyright: basic
"""Health check endpoint with pipeline status."""

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/health")
async def health_check(request: Request) -> dict[str, Any]:
    """健康检查 — 永远返回 200,通过 payload 的 pipeline.ready 表达就绪状态。

    历史 bug:用 `request.app.state.pipeline` 直接属性访问。lifespan await
    pipeline.initialize() 期间(冷启 ~5s 哈希 + 模型加载),app.state 上还没装
    pipeline 属性 → AttributeError → FastAPI 返回 500。前端 react-query 对 5xx
    重试有限,叠加冷启窗口可能永久卡 error。改成 getattr 兜底,未就绪时返回
    `pipeline.ready=false`,前端能正确区分"engine 死了"vs"engine 在加载",而
    且永远拿到 200 不会触发 5xx 重试逻辑。
    """
    pipeline = getattr(request.app.state, "pipeline", None)

    # 从 FastAPI app 元数据动态读版本，与 main.py 单一来源同步
    # （之前硬编码 0.1.0 在 0.2.0 升级时漏改）
    if pipeline is None:
        return {
            "status": "ok",
            "version": request.app.version,
            "pipeline": {
                "ready": False,
                "version": None,
                "quality_available": False,
                "pose_available": False,
                "species_available": False,
                "models": {},
            },
        }

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
