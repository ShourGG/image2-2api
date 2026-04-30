from __future__ import annotations

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
import json

from api.support import require_identity, resolve_image_base_url
from services.image_task_service import image_task_service


class ImageGenerationTaskRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    size: str | None = None
    quality: str | None = None
    generation_mode: str | None = None


class ImageGenerationTaskBatchRequest(BaseModel):
    client_task_ids: list[str] = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    size: str | None = None
    quality: str | None = None
    generation_mode: str | None = None


def _parse_task_ids(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _normalize_client_task_ids(value: object) -> list[str]:
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = None
        if isinstance(parsed, list):
            return [str(item or "").strip() for item in parsed if str(item or "").strip()]
        return _parse_task_ids(raw)
    if isinstance(value, list):
        return [str(item or "").strip() for item in value if str(item or "").strip()]
    return []


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-tasks")
    async def list_image_tasks(
        ids: str = Query(default=""),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_task_service.list_tasks, identity, _parse_task_ids(ids))

    @router.post("/api/image-tasks/generations")
    async def create_generation_task(
        body: ImageGenerationTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                image_task_service.submit_generation,
                identity,
                client_task_id=body.client_task_id,
                prompt=body.prompt,
                model=body.model,
                size=body.size,
                quality=body.quality,
                generation_mode=body.generation_mode,
                base_url=resolve_image_base_url(request),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/generations/batch")
    async def create_generation_task_batch(
        body: ImageGenerationTaskBatchRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        task_ids = _normalize_client_task_ids(body.client_task_ids)
        if not task_ids:
            raise HTTPException(status_code=400, detail={"error": "client_task_ids is required"})
        try:
            return await run_in_threadpool(
                image_task_service.submit_generation_batch,
                identity,
                client_task_ids=task_ids,
                prompt=body.prompt,
                model=body.model,
                size=body.size,
                quality=body.quality,
                generation_mode=body.generation_mode,
                base_url=resolve_image_base_url(request),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/edits")
    async def create_edit_task(
        request: Request,
        authorization: str | None = Header(default=None),
        image: list[UploadFile] | None = File(default=None),
        image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
        client_task_id: str = Form(...),
        prompt: str = Form(...),
        model: str = Form(default="gpt-image-2"),
        size: str | None = Form(default=None),
        quality: str | None = Form(default=None),
        generation_mode: str | None = Form(default=None),
    ):
        identity = require_identity(authorization)
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})
        images: list[tuple[bytes, str, str]] = []
        for upload in uploads:
            image_data = await upload.read()
            if not image_data:
                raise HTTPException(status_code=400, detail={"error": "image file is empty"})
            images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
        try:
            return await run_in_threadpool(
                image_task_service.submit_edit,
                identity,
                client_task_id=client_task_id,
                prompt=prompt,
                model=model,
                size=size,
                quality=quality,
                generation_mode=generation_mode,
                base_url=resolve_image_base_url(request),
                images=images,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/edits/batch")
    async def create_edit_task_batch(
        request: Request,
        authorization: str | None = Header(default=None),
        image: list[UploadFile] | None = File(default=None),
        image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
        client_task_ids: str = Form(...),
        prompt: str = Form(...),
        model: str = Form(default="gpt-image-2"),
        size: str | None = Form(default=None),
        quality: str | None = Form(default=None),
        generation_mode: str | None = Form(default=None),
    ):
        identity = require_identity(authorization)
        normalized_task_ids = _normalize_client_task_ids(client_task_ids)
        if not normalized_task_ids:
            raise HTTPException(status_code=400, detail={"error": "client_task_ids is required"})
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})
        images: list[tuple[bytes, str, str]] = []
        for upload in uploads:
            image_data = await upload.read()
            if not image_data:
                raise HTTPException(status_code=400, detail={"error": "image file is empty"})
            images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
        try:
            return await run_in_threadpool(
                image_task_service.submit_edit_batch,
                identity,
                client_task_ids=normalized_task_ids,
                prompt=prompt,
                model=model,
                size=size,
                quality=quality,
                generation_mode=generation_mode,
                base_url=resolve_image_base_url(request),
                images=images,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    return router
