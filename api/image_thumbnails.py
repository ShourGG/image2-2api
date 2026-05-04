from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from services.image_thumbnail_service import ensure_thumbnail_for_relative_path


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/image-thumbnails/{full_path:path}", include_in_schema=False)
    async def serve_image_thumbnail(full_path: str):
        try:
            path = ensure_thumbnail_for_relative_path(full_path)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail={"error": "image not found"}) from exc
        return FileResponse(
            path,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    return router
