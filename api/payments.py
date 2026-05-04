from __future__ import annotations

import json
from urllib.parse import parse_qsl

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from api.support import require_identity, resolve_public_base_url
from services.payment_service import payment_service


class CreateLinuxDoOrderRequest(BaseModel):
    package_id: str = ""


def _client_ip(request: Request) -> str:
    for header in ("cf-connecting-ip", "x-real-ip", "x-forwarded-for"):
        raw = str(request.headers.get(header) or "").strip()
        if raw:
            return raw.split(",", 1)[0].strip()
    if request.client and request.client.host:
        return str(request.client.host).strip()
    return "unknown"


async def _request_params(request: Request) -> dict[str, object]:
    params: dict[str, object] = dict(request.query_params)
    if request.method.upper() not in {"POST", "PUT", "PATCH"}:
        return params

    body = await request.body()
    if not body:
        return params
    content_type = str(request.headers.get("content-type") or "").lower()
    if "application/json" in content_type:
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            payload = {}
        if isinstance(payload, dict):
            params.update({str(key): value for key, value in payload.items()})
        return params

    decoded = body.decode("utf-8", errors="replace")
    params.update({key: value for key, value in parse_qsl(decoded, keep_blank_values=True)})
    return params


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/payments")
    async def list_payments(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {
            "linuxdo": payment_service.linuxdo_public_config(),
            "items": payment_service.list_orders(identity=identity),
        }

    @router.post("/api/payments/linuxdo/orders")
    async def create_linuxdo_order(
        request: Request,
        body: CreateLinuxDoOrderRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        base_url = resolve_public_base_url(request)
        try:
            item = payment_service.create_linuxdo_order(
                user=identity,
                package_id=body.package_id,
                notify_url=f"{base_url}/api/payments/linuxdo/notify",
                return_url=f"{base_url}/account",
                client_ip=_client_ip(request),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"item": item, "payment_url": item.get("payment_url")}

    async def handle_linuxdo_notify(request: Request) -> PlainTextResponse:
        try:
            params = await _request_params(request)
            payment_service.handle_linuxdo_notify(params)
        except ValueError as exc:
            return PlainTextResponse(f"fail: {str(exc)}", status_code=400)
        except Exception:
            return PlainTextResponse("fail", status_code=500)
        return PlainTextResponse("success")

    router.add_api_route(
        "/api/payments/linuxdo/notify",
        handle_linuxdo_notify,
        methods=["GET", "POST"],
        include_in_schema=False,
    )

    return router
