"""PlumeLens Engine - FastAPI application entry point."""

from fastapi import FastAPI

from engine.api.routes.health import router as health_router
from engine.core.lifespan import lifespan


def create_app() -> FastAPI:
    application = FastAPI(
        title="PlumeLens Engine",
        version="0.1.0",
        lifespan=lifespan,
    )
    application.include_router(health_router)
    return application


app = create_app()
