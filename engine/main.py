"""PlumeLens Engine - FastAPI application entry point."""

import hmac
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.responses import Response

from engine.api.routes.analysis import router as analysis_router
from engine.api.routes.archive import router as archive_router
from engine.api.routes.decisions import router as decisions_router
from engine.api.routes.export import router as export_router
from engine.api.routes.geocoder import router as geocoder_router
from engine.api.routes.health import router as health_router
from engine.api.routes.library import router as library_router
from engine.core.config import settings
from engine.core.lifespan import lifespan


def _request_token(request: Request) -> str | None:
    """Read token from supported local client channels.

    Normal fetch requests use Authorization. Native EventSource cannot set
    headers, so SSE is allowed to pass the same one-time token in the query
    string. The server is loopback-only; the token prevents casual cross-origin
    probes from talking to the random local port.
    """
    auth = request.headers.get("authorization", "")
    scheme, _, value = auth.partition(" ")
    if scheme.lower() == "bearer" and value:
        return value
    header_value = request.headers.get("x-plumelens-token")
    if header_value:
        return header_value
    query_value = request.query_params.get("token")
    return query_value


def create_app() -> FastAPI:
    application = FastAPI(
        title="PlumeLens Engine",
        version="0.6.0",
        lifespan=lifespan,
    )

    async def require_local_token(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        expected = settings.api_token
        if expected and request.method != "OPTIONS":
            supplied = _request_token(request)
            if supplied is None or not hmac.compare_digest(supplied, expected):
                return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)

    application.middleware("http")(require_local_token)

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
    application.include_router(decisions_router)
    application.include_router(geocoder_router)
    application.include_router(archive_router)
    application.include_router(export_router)
    return application


app = create_app()
