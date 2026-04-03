"""FastAPI application lifespan management."""

import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI

from engine.core.config import settings
from engine.core.logging import setup_logging

logger = structlog.stdlib.get_logger()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    # Startup
    setup_logging(log_level=settings.log_level)

    # Ensure data directory exists
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    await logger.ainfo("PlumeLens Engine starting", data_dir=str(settings.data_dir))

    # Print ready signal for Electron process manager to parse
    # (uvicorn prints its own "Uvicorn running on ..." which ProcessManager watches)
    print("PLUMELENS_READY", file=sys.stderr, flush=True)

    yield

    # Shutdown
    await logger.ainfo("PlumeLens Engine shutting down")
