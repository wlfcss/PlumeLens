"""PlumeLens Engine - FastAPI application entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from engine.api.routes.analysis import router as analysis_router
from engine.api.routes.health import router as health_router
from engine.api.routes.library import router as library_router
from engine.core.lifespan import lifespan


def create_app() -> FastAPI:
    application = FastAPI(
        title="PlumeLens Engine",
        version="0.1.0",
        lifespan=lifespan,
    )
    # dev 环境允许 electron-vite 的渲染进程（http://localhost:5173）跨源请求。
    # prod 由 Electron 注入一次性 token；CORS 只影响开发期的 vite HMR shell。
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(health_router)
    application.include_router(library_router)
    application.include_router(analysis_router)
    return application


app = create_app()
