from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import accounts, ai, image_tasks, register, shares, system
from api.support import resolve_web_asset, start_limited_account_watcher
from services.config import config


def _should_bypass_spa_fallback(clean_path: str) -> bool:
    if not clean_path:
        return False
    if clean_path.startswith(("_next/", "api/")):
        return True
    if clean_path in {"docs", "redoc"}:
        return True
    return bool(Path(clean_path).suffix)


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        config.cleanup_old_images()
        try:
            yield
        finally:
            stop_event.set()
            thread.join(timeout=1)

    docs_enabled = config.enable_api_docs
    app = FastAPI(
        title="chatgpt2api",
        version=app_version,
        lifespan=lifespan,
        docs_url="/docs" if docs_enabled else None,
        redoc_url="/redoc" if docs_enabled else None,
        openapi_url="/openapi.json" if docs_enabled else None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Accept", "Authorization", "Content-Type", "Origin"],
    )
    app.include_router(ai.create_router())
    app.include_router(accounts.create_router())
    app.include_router(image_tasks.create_router())
    app.include_router(register.create_router())
    app.include_router(shares.create_router())
    app.include_router(system.create_router(app_version))
    if config.images_dir.exists():
        app.mount("/images", StaticFiles(directory=str(config.images_dir)), name="images")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str):
        clean_path = full_path.strip("/")
        asset = resolve_web_asset(clean_path)
        if asset is not None:
            return FileResponse(asset)
        if _should_bypass_spa_fallback(clean_path):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    return app
