from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from api.support import require_identity, resolve_image_base_url
from services.share_service import share_service


class ShareCreateRequest(BaseModel):
    image_url: str = Field(..., min_length=1)
    prompt: str = ""
    revised_prompt: str = ""
    model: str = "gpt-image-2"
    size: str = ""
    quality: str = ""
    result: int | None = None
    created_at: str = ""


def create_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/shares")
    async def create_share(
        body: ShareCreateRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            item = share_service.create_share(
                identity,
                image_url=body.image_url,
                prompt=body.prompt,
                revised_prompt=body.revised_prompt,
                model=body.model,
                size=body.size,
                quality=body.quality,
                result=body.result,
                created_at=body.created_at,
                base_url=resolve_image_base_url(request),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

        base_url = resolve_image_base_url(request).rstrip("/")
        return {
            "item": item,
            "share_url": f"{base_url}/share/?id={item['id']}",
        }

    @router.get("/api/shares/{share_id}")
    async def get_share(share_id: str):
        item = share_service.get_share(share_id)
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "share not found"})
        return {"item": item}

    return router
