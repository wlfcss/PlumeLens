"""PlumeLens Engine - FastAPI application entry point."""

import hmac
from urllib.parse import parse_qs

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from engine.api.routes.analysis import router as analysis_router
from engine.api.routes.archive import router as archive_router
from engine.api.routes.decisions import router as decisions_router
from engine.api.routes.diagnostics import router as diagnostics_router
from engine.api.routes.export import router as export_router
from engine.api.routes.geocoder import router as geocoder_router
from engine.api.routes.health import router as health_router
from engine.api.routes.library import router as library_router
from engine.api.routes.settings import router as settings_router
from engine.core.config import settings
from engine.core.lifespan import lifespan
from engine.services.selection import SelectionProjectionCache


def _extract_scope_token(scope: Scope, *, allow_query: bool) -> str | None:
    """Read token from Authorization header, X-PlumeLens-Token, or (dev-only) query param."""
    headers = scope.get("headers") or ()
    header_token: str | None = None
    for raw_k, raw_v in headers:
        key = raw_k.lower()
        if key == b"authorization":
            auth = raw_v.decode("latin-1")
            scheme, _, value = auth.partition(" ")
            if scheme.lower() == "bearer" and value:
                return value
        elif key == b"x-plumelens-token":
            header_token = raw_v.decode("latin-1")
    if header_token:
        return header_token
    if allow_query:
        qs = (scope.get("query_string") or b"").decode("latin-1")
        if qs:
            vals = parse_qs(qs).get("token")
            if vals and vals[0]:
                return vals[0]
    return None


def _extract_request_id(scope: Scope) -> str | None:
    for raw_k, raw_v in scope.get("headers") or ():
        if raw_k.lower() == b"x-plumelens-request-id":
            return raw_v.decode("latin-1")[:32]
    return None


class _LocalAuthAndTraceMiddleware:
    """Pure ASGI middleware for local bearer-token auth and X-PlumeLens-Request-Id binding.

    Avoids Starlette BaseHTTPMiddleware streaming overhead and SSE cancellation issues.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        expected = settings.api_token
        method = str(scope.get("method", "GET")).upper()
        if expected and method != "OPTIONS":
            # In packaged production (require_api_token=True), disable ?token= query auth
            # so tokens can only travel in Authorization / X-PlumeLens-Token headers.
            supplied = _extract_scope_token(scope, allow_query=not settings.require_api_token)
            if supplied is None or not hmac.compare_digest(supplied, expected):
                response = JSONResponse({"detail": "Unauthorized"}, status_code=401)
                await response(scope, receive, send)
                return

        req_id = _extract_request_id(scope)
        if req_id:
            with structlog.contextvars.bound_contextvars(request_id=req_id):
                await self.app(scope, receive, send)
            return
        await self.app(scope, receive, send)


def create_app() -> FastAPI:
    if settings.require_api_token and not settings.api_token:
        raise RuntimeError("PLUMELENS_API_TOKEN is required when PLUMELENS_REQUIRE_API_TOKEN=1")

    application = FastAPI(
        title="PlumeLens Engine",
        version="0.7.9",
        lifespan=lifespan,
    )
    application.state.selection_projections = SelectionProjectionCache()
    application.add_middleware(_LocalAuthAndTraceMiddleware)

    # Dev 环境允许 electron-vite 的渲染进程跨源请求。5173 被占用时 Vite 会自动
    # 递增到 5174/5175；这里放开 loopback 的任意端口，实际访问仍由一次性
    # bearer token 保护，避免 dev 端口漂移导致 UI 误判后端离线。
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_origin_regex=r"^http://(localhost|127\.0\.0\.1|\[::1\]):\d+$",
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
    application.include_router(settings_router)
    application.include_router(diagnostics_router)
    return application


app = create_app()
