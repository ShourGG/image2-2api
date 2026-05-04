from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

import tiktoken
from curl_cffi import CurlMime, requests

from services.account_service import account_service
from services.auth_service import (
    auth_service,
    image_point_cost_for_request,
    image_size_tier,
    paid_bonus_allowed_for_request,
    paid_image_coin_cost_for_request,
)
from services.config import config
from services.image_file_utils import sniff_image_mime_and_extension
from services.image_thumbnail_service import create_thumbnail_for_image_path
from services.openai_backend_api import CODEX_IMAGE_MODEL, OpenAIBackendAPI
from services.proxy_service import proxy_settings
from utils.helper import IMAGE_MODELS
from utils.log import logger


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


OPENAI_COMPATIBLE_IMAGE_TIMEOUT_SECONDS = max(
    60.0,
    _env_float("OPENAI_COMPATIBLE_IMAGE_TIMEOUT_SECONDS", 900.0),
)


class ImageGenerationError(Exception):
    def __init__(
        self,
        message: str,
        status_code: int = 502,
        error_type: str = "server_error",
        code: str | None = "upstream_error",
        param: str | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_type = error_type
        self.code = code
        self.param = param
        self.retry_after_seconds = retry_after_seconds

    def to_openai_error(self) -> dict[str, Any]:
        return {
            "error": {
                "message": str(self),
                "type": self.error_type,
                "param": self.param,
                "code": self.code,
            }
        }


def is_token_invalid_error(message: str) -> bool:
    text = str(message or "").lower()
    return (
        "token_invalidated" in text
        or "token_revoked" in text
        or "authentication token has been invalidated" in text
        or "invalidated oauth token" in text
    )


def image_stream_error_message(message: str) -> str:
    text = str(message or "")
    lower = text.lower()
    if "curl: (35)" in lower or "tls connect error" in lower or "openssl_internal" in lower:
        return "upstream image connection failed, please retry later"
    return text or "image generation failed"


def is_image_pool_busy_error(message: str) -> bool:
    lower = str(message or "").lower()
    return "pool is busy" in lower or "正在忙碌" in lower


def _image_billing_user_id(identity: dict[str, Any] | None) -> str:
    if not isinstance(identity, dict):
        return ""
    if str(identity.get("role") or "").strip() != "user":
        return ""
    return str(identity.get("id") or "").strip()


@dataclass(frozen=True)
class ImageBillingCharge:
    kind: str = ""
    amount: int = 0


def normalize_image_generation_mode(value: object, identity: dict[str, Any] | None = None) -> str:
    mode = str(value or "").strip().lower()
    if mode in {"free", "paid"}:
        return mode
    if isinstance(identity, dict) and str(identity.get("role") or "").strip() == "user":
        return "free"
    return ""


def consume_image_points(identity: dict[str, Any] | None, quality: str | None = None, size: str | None = None) -> int:
    user_id = _image_billing_user_id(identity)
    if not user_id:
        return 0
    cost = image_point_cost_for_request(quality, size)
    try:
        auth_service.change_user_points(user_id, -cost)
    except ValueError as exc:
        raise ImageGenerationError(
            "insufficient points",
            status_code=429,
            error_type="insufficient_quota",
            code="insufficient_points",
        ) from exc
    return cost


def refund_image_points(identity: dict[str, Any] | None, cost: int) -> None:
    user_id = _image_billing_user_id(identity)
    if not user_id or cost <= 0:
        return
    try:
        auth_service.change_user_points(user_id, cost)
    except ValueError:
        return


def consume_image_billing(
    identity: dict[str, Any] | None,
    generation_mode: str,
    quality: str | None = None,
    size: str | None = None,
) -> ImageBillingCharge:
    user_id = _image_billing_user_id(identity)
    if not user_id:
        return ImageBillingCharge()
    mode = normalize_image_generation_mode(generation_mode, identity)
    if mode == "paid":
        cost = paid_image_coin_cost_for_request(quality, size)
        try:
            charge = auth_service.consume_paid_image_credit(
                user_id,
                cost=cost,
                bonus_allowed=paid_bonus_allowed_for_request(quality, size),
            )
        except ValueError as exc:
            raise ImageGenerationError(
                "insufficient paid balance",
                status_code=429,
                error_type="insufficient_quota",
                code="insufficient_paid_balance",
            ) from exc
        return ImageBillingCharge(kind=str(charge.get("kind") or ""), amount=int(charge.get("amount") or 0))

    return ImageBillingCharge(kind="points", amount=consume_image_points(identity, quality, size))


def refund_image_billing(identity: dict[str, Any] | None, charge: ImageBillingCharge) -> None:
    user_id = _image_billing_user_id(identity)
    if not user_id or charge.amount <= 0:
        return
    if charge.kind == "points":
        refund_image_points(identity, charge.amount)
        return
    if charge.kind in {"bonus", "coins"}:
        auth_service.refund_paid_image_credit(user_id, kind=charge.kind, amount=charge.amount)


_openai_image_limit_condition = threading.Condition()
_openai_image_active_counts: dict[str, int] = {}
_openai_image_cooldown_until: dict[str, float] = {}
OPENAI_COMPATIBLE_BUSY_RETRY_SECONDS = 8.0


def enabled_openai_compatible_image_upstreams() -> list[dict[str, Any]]:
    return [
        item
        for item in config.image_generation_api_upstreams
        if item.get("enabled", True) and str(item.get("base_url") or "").strip()
    ]


def openai_compatible_upstream_id(upstream: dict[str, Any]) -> str:
    return str(upstream.get("id") or upstream.get("name") or upstream.get("base_url") or "").strip()


def openai_compatible_upstream_max_concurrency(upstream: dict[str, Any]) -> int:
    try:
        return max(1, int(upstream.get("max_concurrency") or config.image_generation_api_max_concurrency or 1))
    except (TypeError, ValueError):
        return max(1, config.image_generation_api_max_concurrency)


def openai_compatible_image_queue_capacity() -> int:
    upstreams = enabled_openai_compatible_image_upstreams()
    if not upstreams:
        return max(1, config.image_generation_api_total_max_concurrency)
    return max(1, sum(openai_compatible_upstream_max_concurrency(item) for item in upstreams))


def is_openai_compatible_upstream_busy_error(error: object) -> bool:
    text = str(error or "").lower()
    return (
        "concurrency limit exceeded" in text
        or ("http 429" in text and "retry later" in text)
        or ("http 429" in text and "concurrent" in text)
    )


def openai_compatible_upstream_runtime_state(upstream: dict[str, Any]) -> dict[str, Any]:
    upstream_id = openai_compatible_upstream_id(upstream)
    enabled = bool(upstream.get("enabled", True))
    max_concurrency = openai_compatible_upstream_max_concurrency(upstream)
    with _openai_image_limit_condition:
        now = time.time()
        cooldown_until = float(_openai_image_cooldown_until.get(upstream_id, 0.0) or 0.0)
        if cooldown_until > 0 and cooldown_until <= now:
            _openai_image_cooldown_until.pop(upstream_id, None)
            cooldown_until = 0.0
        active_count = max(0, int(_openai_image_active_counts.get(upstream_id, 0) or 0))

    cooldown_remaining_seconds = max(0, int(round(cooldown_until - time.time()))) if cooldown_until > 0 else 0
    available_slots = max(0, max_concurrency - active_count)
    if not enabled:
        status = "disabled"
    elif cooldown_remaining_seconds > 0:
        status = "cooldown"
        available_slots = 0
    elif active_count >= max_concurrency:
        status = "busy"
        available_slots = 0
    else:
        status = "available"

    return {
        "id": upstream_id,
        "name": str(upstream.get("name") or upstream_id or "OpenAI兼容上游").strip() or "OpenAI兼容上游",
        "enabled": enabled,
        "status": status,
        "active_count": active_count,
        "max_concurrency": max_concurrency,
        "available_slots": available_slots,
        "cooldown_remaining_seconds": cooldown_remaining_seconds,
    }


def list_openai_compatible_upstream_runtime_states(upstreams: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    items = list(upstreams or config.image_generation_api_upstreams or [])
    return [openai_compatible_upstream_runtime_state(item) for item in items if isinstance(item, dict)]


def mark_openai_compatible_upstream_busy(upstream: dict[str, Any], retry_after_seconds: float | None = None) -> None:
    wait_seconds = retry_after_seconds
    if wait_seconds is None or wait_seconds <= 0:
        wait_seconds = OPENAI_COMPATIBLE_BUSY_RETRY_SECONDS
    cooldown_until = time.time() + max(1.0, float(wait_seconds))
    with _openai_image_limit_condition:
        upstream_id = openai_compatible_upstream_id(upstream)
        _openai_image_cooldown_until[upstream_id] = max(_openai_image_cooldown_until.get(upstream_id, 0.0), cooldown_until)
        _openai_image_limit_condition.notify_all()


def _openai_image_slot_available_locked(upstream: dict[str, Any]) -> bool:
    upstream_id = openai_compatible_upstream_id(upstream)
    cooldown_until = float(_openai_image_cooldown_until.get(upstream_id, 0.0) or 0.0)
    if cooldown_until > 0:
        if cooldown_until > time.time():
            return False
        _openai_image_cooldown_until.pop(upstream_id, None)
    active_count = _openai_image_active_counts.get(upstream_id, 0)
    return active_count < openai_compatible_upstream_max_concurrency(upstream)


def openai_compatible_image_queue_is_saturated(upstreams: list[dict[str, Any]] | None = None) -> bool:
    candidates = upstreams or enabled_openai_compatible_image_upstreams()
    if not candidates:
        return False
    with _openai_image_limit_condition:
        return all(not _openai_image_slot_available_locked(item) for item in candidates)


def acquire_openai_compatible_image_slot(
    upstreams: list[dict[str, Any]] | None = None,
) -> tuple[bool, dict[str, Any]]:
    candidates = list(upstreams or enabled_openai_compatible_image_upstreams())
    if not candidates:
        raise ImageGenerationError("OpenAI兼容图片上游未配置")

    waited = False
    with _openai_image_limit_condition:
        while True:
            for upstream in candidates:
                if not _openai_image_slot_available_locked(upstream):
                    continue
                upstream_id = openai_compatible_upstream_id(upstream)
                _openai_image_active_counts[upstream_id] = _openai_image_active_counts.get(upstream_id, 0) + 1
                return waited, upstream
            waited = True
            _openai_image_limit_condition.wait(timeout=1.0)


def release_openai_compatible_image_slot(upstream: dict[str, Any] | None) -> None:
    if not isinstance(upstream, dict):
        return

    with _openai_image_limit_condition:
        upstream_id = openai_compatible_upstream_id(upstream)
        active_count = _openai_image_active_counts.get(upstream_id, 0)
        if active_count <= 1:
            _openai_image_active_counts.pop(upstream_id, None)
        else:
            _openai_image_active_counts[upstream_id] = active_count - 1
        _openai_image_limit_condition.notify_all()


def notify_image_request_started(request: "ConversationRequest") -> None:
    callback = request.on_start
    if not callable(callback):
        return
    request.on_start = None
    try:
        callback()
    except Exception:
        logger.warning({"event": "image_request_start_callback_failed"})


def encode_images(images: Iterable[tuple[bytes, str, str]]) -> list[str]:
    encoded: list[str] = []
    for data, filename, content_type in images:
        if not data:
            continue
        mime_type = str(content_type or "").strip()
        if not mime_type:
            mime_type = mimetypes.guess_type(str(filename or ""))[0] or "image/png"
        encoded.append(f"data:{mime_type};base64,{base64.b64encode(data).decode('ascii')}")
    return encoded


def decode_image_input(image: str, default_name: str = "image") -> tuple[bytes, str, str]:
    raw = str(image or "").strip()
    mime_type = "image/png"
    file_name = default_name
    payload = raw

    if raw and len(raw) < 512 and not raw.startswith("data:") and "\n" not in raw and "\r" not in raw:
        candidate_path = Path(os.path.expanduser(raw))
        if candidate_path.exists() and candidate_path.is_file():
            mime_type = mimetypes.guess_type(candidate_path.name)[0] or mime_type
            return candidate_path.read_bytes(), mime_type, candidate_path.name

    if raw.startswith("data:") and "," in raw:
        header, payload = raw.split(",", 1)
        match = re.match(r"^data:([^;,]+)", header, flags=re.IGNORECASE)
        if match:
            mime_type = str(match.group(1) or "").strip() or mime_type

    extension = mimetypes.guess_extension(mime_type) or ".png"
    if extension == ".jpe":
        extension = ".jpg"
    if not file_name.endswith(extension):
        file_name = f"{default_name}{extension}"
    return base64.b64decode(payload), mime_type, file_name


def save_image_bytes(image_data: bytes, base_url: str | None = None) -> str:
    config.cleanup_old_images()
    detected = sniff_image_mime_and_extension(image_data)
    if not detected:
        raise ImageGenerationError(
            "upstream returned invalid image bytes",
            status_code=502,
            error_type="server_error",
            code="invalid_upstream_image",
        )
    _mime_type, extension = detected
    file_hash = hashlib.md5(image_data).hexdigest()
    filename = f"{int(time.time())}_{file_hash}{extension}"
    relative_dir = Path(time.strftime("%Y"), time.strftime("%m"), time.strftime("%d"))
    file_path = config.images_dir / relative_dir / filename
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(image_data)
    create_thumbnail_for_image_path(file_path)
    return f"{(base_url or config.base_url)}/images/{relative_dir.as_posix()}/{filename}"


def message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and str(item.get("type") or "") in {"text", "input_text", "output_text"}:
                parts.append(str(item.get("text") or ""))
        return "".join(parts)
    return ""


def normalize_messages(messages: object, system: Any = None) -> list[dict[str, Any]]:
    normalized = []
    system_text = message_text(system)
    if system_text:
        normalized.append({"role": "system", "content": system_text})
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, dict):
                normalized.append({"role": message.get("role", "user"), "content": message_text(message.get("content", ""))})
    return normalized


def assistant_history_text(messages: list[dict[str, Any]]) -> str:
    return "".join(str(item.get("content") or "") for item in messages if item.get("role") == "assistant")


def assistant_history_messages(messages: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("content") or "") for item in messages if item.get("role") == "assistant" and item.get("content")]


def normalize_image_quality(quality: str | None) -> str:
    value = str(quality or "").strip().lower()
    return value if value in {"high", "xhigh"} else ""


def parse_image_dimensions(size: str | None) -> tuple[int, int] | None:
    value = str(size or "").strip().lower()
    if "x" not in value:
        return None
    width_text, _, height_text = value.partition("x")
    try:
        width = int(width_text)
        height = int(height_text)
    except ValueError:
        return None
    if width <= 0 or height <= 0:
        return None
    return width, height


def is_valid_gpt_image_size(size: str | None) -> bool:
    dimensions = parse_image_dimensions(size)
    if not dimensions:
        return False
    width, height = dimensions
    long_edge = max(width, height)
    short_edge = min(width, height)
    total_pixels = width * height
    return (
        long_edge <= 3840
        and width % 16 == 0
        and height % 16 == 0
        and long_edge / short_edge <= 3
        and 655_360 <= total_pixels <= 8_294_400
    )


def build_image_prompt(prompt: str, size: str | None, quality: str | None = None) -> str:
    parts = [prompt.strip()]
    dimensions = parse_image_dimensions(size)
    if dimensions:
        width, height = dimensions
        if width == height:
            orientation = "正方形"
        elif width > height:
            orientation = "横版"
        else:
            orientation = "竖版"
        parts.append(f"输出图片尺寸为 {width}x{height}，保持{orientation}构图。")
    elif size in {"1:1", "16:9", "9:16", "4:3", "3:4"}:
        parts.append({
            "1:1": "输出为 1:1 正方形构图，主体居中，适合正方形画幅。",
            "16:9": "输出为 16:9 横屏构图，适合宽画幅展示。",
            "9:16": "输出为 9:16 竖屏构图，适合竖版画幅展示。",
            "4:3": "输出为 4:3 比例，兼顾宽度与高度，适合展示画面细节。",
            "3:4": "输出为 3:4 比例，纵向构图，适合人物肖像或竖向场景。",
        }[size])
    normalized_quality = normalize_image_quality(quality)
    if normalized_quality == "xhigh":
        parts.append(
            "质量要求：使用超高清终稿效果，优先最高完成度、稳定构图、主体结构准确、边缘干净、纹理丰富、材质清晰、"
            "自然光影、层次分明和细节一致性；画面必须像最终成片，不要草稿感、低清、糊图、压缩感、畸形细节、乱码文字、"
            "脏噪点、过度锐化或未完成区域。"
        )
    elif normalized_quality == "high":
        parts.append(
            "质量要求：使用高清终稿效果，优先画面精细度、结构准确、边缘干净、纹理清晰、自然光影和高完成度；"
            "避免低清、糊图、压缩感、畸形细节、乱码文字和草稿感。"
        )
    return "\n\n".join(part for part in parts if part)


def uses_codex_image_backend(model: str) -> bool:
    value = str(model or "").strip()
    if value == CODEX_IMAGE_MODEL:
        return True
    return value == "gpt-image-2" and config.image_generation_strategy == "codex_responses"


def uses_openai_compatible_image_backend() -> bool:
    return config.image_generation_strategy == "openai_compatible"


def request_uses_openai_compatible_image_backend(request: ConversationRequest) -> bool:
    mode = normalize_image_generation_mode(request.generation_mode, request.identity)
    if mode == "paid":
        return True
    if mode == "free":
        return False
    return uses_openai_compatible_image_backend()


def validate_free_image_request(request: ConversationRequest) -> None:
    if image_size_tier(request.size) != "normal":
        raise ImageGenerationError(
            "free mode only supports normal image sizes",
            status_code=400,
            error_type="invalid_request_error",
            code="free_mode_size_not_allowed",
            param="size",
        )
    if normalize_image_quality(request.quality):
        raise ImageGenerationError(
            "free mode only supports standard quality",
            status_code=400,
            error_type="invalid_request_error",
            code="free_mode_quality_not_allowed",
            param="quality",
        )


def api_image_size(size: str | None) -> str:
    value = str(size or "").strip()
    if value == "auto":
        return value
    if is_valid_gpt_image_size(value):
        dimensions = parse_image_dimensions(value)
        if dimensions:
            return f"{dimensions[0]}x{dimensions[1]}"
    return {
        "1:1": "1024x1024",
        "16:9": "1536x1024",
        "4:3": "1536x1024",
        "9:16": "1024x1536",
        "3:4": "1024x1536",
    }.get(value, "")


def openai_compatible_image_data(item: dict[str, Any], session: requests.Session) -> dict[str, str] | None:
    revised_prompt = str(item.get("revised_prompt") or "").strip()
    b64_json = str(item.get("b64_json") or "").strip()
    if b64_json:
        return {"b64_json": b64_json, "revised_prompt": revised_prompt}

    url = str(item.get("url") or "").strip()
    if not url:
        return None
    response = session.get(url, timeout=120)
    if response.status_code >= 400:
        raise RuntimeError(f"download image failed: HTTP {response.status_code}")
    return {
        "b64_json": base64.b64encode(response.content).decode("ascii"),
        "revised_prompt": revised_prompt,
    }


def openai_compatible_image_outputs(
        request: ConversationRequest,
        index: int,
        total: int,
        upstream: dict[str, Any],
) -> Iterator[ImageOutput]:
    base_url = str(upstream.get("base_url") or "").strip().rstrip("/")
    api_key = str(upstream.get("api_key") or "").strip()
    upstream_name = str(upstream.get("name") or upstream.get("id") or "OpenAI兼容上游").strip()
    if not base_url:
        raise ImageGenerationError(f"{upstream_name} 未配置 base_url")
    if not api_key:
        raise ImageGenerationError(f"{upstream_name} 未配置 API Key")

    model = str(upstream.get("model") or config.image_generation_api_model or request.model or "gpt-image-2").strip() or "gpt-image-2"
    endpoint = "/v1/images/edits" if request.images else "/v1/images/generations"
    url = f"{base_url.rstrip('/')}{endpoint}"
    final_prompt = build_image_prompt(request.prompt, request.size, request.quality)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    image_size = api_image_size(request.size)
    normalized_quality = normalize_image_quality(request.quality)

    yield ImageOutput(
        kind="progress",
        model=model,
        index=index,
        total=total,
        upstream_event_type=f"openai_compatible.start:{upstream_name}",
    )

    session = requests.Session(**proxy_settings.build_session_kwargs(impersonate="edge101", verify=False))
    multipart: CurlMime | None = None
    try:
        if request.images:
            data: dict[str, str] = {"model": model, "prompt": final_prompt, "n": "1", "response_format": "b64_json"}
            if image_size:
                data["size"] = image_size
            if normalized_quality:
                data["quality"] = normalized_quality
            multipart = CurlMime()
            image_field = "image[]" if len(request.images or []) > 1 else "image"
            for image_index, image in enumerate(request.images or [], start=1):
                image_bytes, mime_type, file_name = decode_image_input(image, default_name=f"image_{image_index}")
                multipart.addpart(
                    image_field,
                    filename=file_name,
                    content_type=mime_type,
                    data=image_bytes,
                )
            response = session.post(
                url,
                headers=headers,
                data=data,
                multipart=multipart,
                timeout=OPENAI_COMPATIBLE_IMAGE_TIMEOUT_SECONDS,
            )
        else:
            payload: dict[str, Any] = {
                "model": model,
                "prompt": final_prompt,
                "n": 1,
                "response_format": "b64_json",
            }
            if image_size:
                payload["size"] = image_size
            if normalized_quality:
                payload["quality"] = normalized_quality
            response = session.post(
                url,
                headers={**headers, "Content-Type": "application/json"},
                json=payload,
                timeout=OPENAI_COMPATIBLE_IMAGE_TIMEOUT_SECONDS,
            )

        if response.status_code >= 400:
            message = response.text[:1000]
            retry_after_seconds: float | None = None
            try:
                body = response.json()
                error = body.get("error") if isinstance(body, dict) else None
                if isinstance(error, dict):
                    message = str(error.get("message") or message)
                elif isinstance(body, dict):
                    message = str(body.get("message") or message)
            except Exception:
                pass
            retry_after_header = str(response.headers.get("Retry-After") or "").strip()
            if retry_after_header:
                try:
                    retry_after_seconds = float(retry_after_header)
                except ValueError:
                    retry_after_seconds = None
            raise ImageGenerationError(
                f"{upstream_name} 失败：HTTP {response.status_code} {message}",
                status_code=response.status_code,
                error_type="rate_limit_error" if response.status_code == 429 else "server_error",
                code="upstream_rate_limit" if response.status_code == 429 else "upstream_error",
                retry_after_seconds=retry_after_seconds,
            )

        body = response.json()
        raw_data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(raw_data, list) or not raw_data:
            raise ImageGenerationError(f"{upstream_name} 未返回图片数据")
        image_items = []
        for item in raw_data:
            if not isinstance(item, dict):
                continue
            normalized = openai_compatible_image_data(item, session)
            if normalized:
                image_items.append(normalized)
                if len(image_items) >= 1:
                    break
        if len(raw_data) > 1:
            logger.warning({
                "event": "openai_compatible_image_extra_outputs_ignored",
                "upstream_id": str(upstream.get("id") or ""),
                "upstream_name": upstream_name,
                "returned": len(raw_data),
                "kept": len(image_items),
            })
        data = format_image_result(
            image_items,
            request.prompt,
            request.response_format,
            request.base_url,
            int(time.time()),
        )["data"]
        if not data:
            raise ImageGenerationError(f"{upstream_name} 返回内容里没有可用图片")
        yield ImageOutput(kind="result", model=model, index=index, total=total, data=data)
    finally:
        if multipart is not None:
            multipart.close()
        session.close()


def openai_compatible_image_outputs_with_failover(
    request: ConversationRequest,
    index: int,
    total: int,
) -> Iterator[ImageOutput]:
    upstreams = enabled_openai_compatible_image_upstreams()
    if not upstreams:
        raise ImageGenerationError("OpenAI兼容图片上游未配置")

    last_error = ""
    tried_upstream_ids: set[str] = set()
    started = False
    while len(tried_upstream_ids) < len(upstreams):
        remaining_upstreams = [
            item
            for item in upstreams
            if openai_compatible_upstream_id(item) not in tried_upstream_ids
        ]
        waited, upstream = acquire_openai_compatible_image_slot(remaining_upstreams)
        try:
            if waited:
                yield ImageOutput(
                    kind="progress",
                    model=request.model,
                    index=index,
                    total=total,
                    text="已开始处理排队任务。",
                    upstream_event_type="openai_compatible.dequeue",
                )
            if not started:
                notify_image_request_started(request)
                started = True
            yield from openai_compatible_image_outputs(request, index, total, upstream)
            return
        except Exception as exc:
            last_error = str(exc) or exc.__class__.__name__
            if is_openai_compatible_upstream_busy_error(exc):
                retry_after_seconds = exc.retry_after_seconds if isinstance(exc, ImageGenerationError) else None
                mark_openai_compatible_upstream_busy(upstream, retry_after_seconds)
                logger.warning({
                    "event": "openai_compatible_image_upstream_busy",
                    "upstream_id": str(upstream.get("id") or ""),
                    "upstream_name": str(upstream.get("name") or ""),
                    "error": last_error,
                    "retry_after_seconds": retry_after_seconds or OPENAI_COMPATIBLE_BUSY_RETRY_SECONDS,
                })
                yield ImageOutput(
                    kind="progress",
                    model=request.model,
                    index=index,
                    total=total,
                    text="上游并发已满，正在切换或排队等待空闲槽位...",
                    upstream_event_type="openai_compatible.busy",
                )
                continue
            tried_upstream_ids.add(openai_compatible_upstream_id(upstream))
            logger.warning({
                "event": "openai_compatible_image_upstream_failed",
                "upstream_id": str(upstream.get("id") or ""),
                "upstream_name": str(upstream.get("name") or ""),
                "error": last_error,
            })
            if len(tried_upstream_ids) < len(upstreams):
                yield ImageOutput(
                    kind="progress",
                    model=request.model,
                    index=index,
                    total=total,
                    text="当前上游失败，正在切换下一个上游...",
                    upstream_event_type="openai_compatible.failover",
                )
        finally:
            release_openai_compatible_image_slot(upstream)

    raise ImageGenerationError(f"OpenAI兼容图片上游全部失败：{last_error or 'no available upstream'}")


def encoding_for_model(model: str):
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError:
        try:
            return tiktoken.get_encoding("o200k_base")
        except KeyError:
            return tiktoken.get_encoding("cl100k_base")


def count_message_tokens(messages: list[dict[str, Any]], model: str) -> int:
    encoding = encoding_for_model(model)
    total = 0
    for message in messages:
        total += 3
        for key, value in message.items():
            if not isinstance(value, str):
                continue
            total += len(encoding.encode(value))
            if key == "name":
                total += 1
    return total + 3


def count_text_tokens(text: str, model: str) -> int:
    return len(encoding_for_model(model).encode(text))


def format_image_result(
    items: list[dict[str, Any]],
    prompt: str,
    response_format: str,
    base_url: str | None = None,
    created: int | None = None,
    message: str = "",
) -> dict[str, Any]:
    data: list[dict[str, Any]] = []
    for item in items:
        b64_json = str(item.get("b64_json") or "").strip()
        if not b64_json:
            continue
        revised_prompt = str(item.get("revised_prompt") or prompt).strip() or prompt
        if response_format == "b64_json":
            data.append({
                "b64_json": b64_json,
                "url": save_image_bytes(base64.b64decode(b64_json), base_url),
                "revised_prompt": revised_prompt,
            })
        else:
            data.append({
                "url": save_image_bytes(base64.b64decode(b64_json), base_url),
                "revised_prompt": revised_prompt,
            })
    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}
    if message and not data:
        result["message"] = message
    return result


@dataclass
class ConversationRequest:
    model: str = "auto"
    prompt: str = ""
    messages: list[dict[str, Any]] | None = None
    images: list[str] | None = None
    n: int = 1
    size: str | None = None
    quality: str | None = None
    response_format: str = "b64_json"
    base_url: str | None = None
    message_as_error: bool = False
    identity: dict[str, Any] | None = None
    generation_mode: str | None = None
    on_start: Callable[[], None] | None = None


@dataclass
class ConversationState:
    text: str = ""
    conversation_id: str = ""
    file_ids: list[str] = field(default_factory=list)
    sediment_ids: list[str] = field(default_factory=list)
    blocked: bool = False
    tool_invoked: bool | None = None
    turn_use_case: str = ""


@dataclass
class ImageOutput:
    kind: str
    model: str
    index: int
    total: int
    created: int = field(default_factory=lambda: int(time.time()))
    text: str = ""
    upstream_event_type: str = ""
    data: list[dict[str, Any]] = field(default_factory=list)

    def to_chunk(self) -> dict[str, Any]:
        chunk: dict[str, Any] = {
            "object": "image.generation.chunk",
            "created": self.created,
            "model": self.model,
            "index": self.index,
            "total": self.total,
            "progress_text": self.text,
            "upstream_event_type": self.upstream_event_type,
            "data": [],
        }
        if self.kind == "message":
            chunk.update({
                "object": "image.generation.message",
                "message": self.text,
            })
            chunk.pop("progress_text", None)
            chunk.pop("upstream_event_type", None)
        elif self.kind == "result":
            chunk.update({
                "object": "image.generation.result",
                "data": self.data,
            })
            chunk.pop("progress_text", None)
            chunk.pop("upstream_event_type", None)
        return chunk


def assistant_message_text(message: dict[str, Any]) -> str:
    content = message.get("content") or {}
    parts = content.get("parts") or []
    if not isinstance(parts, list):
        return ""
    return "".join(part for part in parts if isinstance(part, str))


def strip_history(text: str, history_text: str = "") -> str:
    text = str(text or "")
    history_text = str(history_text or "")
    while history_text and text.startswith(history_text):
        text = text[len(history_text):]
    return text


def assistant_text(event: dict[str, Any], current_text: str = "", history_text: str = "") -> str:
    for candidate in (event, event.get("v")):
        if not isinstance(candidate, dict):
            continue
        message = candidate.get("message")
        if not isinstance(message, dict):
            continue
        role = str((message.get("author") or {}).get("role") or "").strip().lower()
        if role != "assistant":
            continue
        text = assistant_message_text(message)
        if text:
            return strip_history(text, history_text)
    return apply_text_patch(event, current_text, history_text)


def event_assistant_text(event: dict[str, Any], history_text: str = "") -> str:
    for candidate in (event, event.get("v")):
        if not isinstance(candidate, dict):
            continue
        message = candidate.get("message")
        if isinstance(message, dict) and (message.get("author") or {}).get("role") == "assistant":
            return strip_history(assistant_message_text(message), history_text)
    return ""


def apply_text_patch(event: dict[str, Any], current_text: str = "", history_text: str = "") -> str:
    if event.get("p") == "/message/content/parts/0":
        return apply_patch_op(event, current_text, history_text)

    operations = event.get("v")
    if isinstance(operations, str) and current_text and not event.get("p") and not event.get("o"):
        return current_text + operations

    if event.get("o") == "patch" and isinstance(operations, list):
        text = current_text
        for item in operations:
            if isinstance(item, dict):
                text = apply_text_patch(item, text, history_text)
        return text

    if not isinstance(operations, list):
        return current_text

    text = current_text
    for item in operations:
        if isinstance(item, dict):
            text = apply_text_patch(item, text, history_text)
    return text


def apply_patch_op(operation: dict[str, Any], current_text: str, history_text: str = "") -> str:
    op = operation.get("o")
    value = str(operation.get("v") or "")
    if op == "append":
        return current_text + value
    if op == "replace":
        return strip_history(value, history_text)
    return current_text


def add_unique(values: list[str], candidates: list[str]) -> None:
    for candidate in candidates:
        if candidate and candidate not in values:
            values.append(candidate)


def extract_conversation_ids(payload: str) -> tuple[str, list[str], list[str]]:
    conversation_match = re.search(r'"conversation_id"\s*:\s*"([^"]+)"', payload)
    conversation_id = conversation_match.group(1) if conversation_match else ""
    file_ids = re.findall(r"(file[-_][A-Za-z0-9]+)", payload)
    sediment_ids = re.findall(r"sediment://([A-Za-z0-9_-]+)", payload)
    return conversation_id, file_ids, sediment_ids


def is_image_tool_event(event: dict[str, Any]) -> bool:
    value = event.get("v")
    message = event.get("message") or (value.get("message") if isinstance(value, dict) else None)
    if not isinstance(message, dict):
        return False
    metadata = message.get("metadata") or {}
    author = message.get("author") or {}
    return author.get("role") == "tool" and metadata.get("async_task_type") == "image_gen"


def update_conversation_state(state: ConversationState, payload: str, event: dict[str, Any] | None = None) -> None:
    conversation_id, file_ids, sediment_ids = extract_conversation_ids(payload)
    if conversation_id and not state.conversation_id:
        state.conversation_id = conversation_id
    if isinstance(event, dict) and is_image_tool_event(event):
        add_unique(state.file_ids, file_ids)
        add_unique(state.sediment_ids, sediment_ids)
    if not isinstance(event, dict):
        return
    state.conversation_id = str(event.get("conversation_id") or state.conversation_id)
    value = event.get("v")
    if isinstance(value, dict):
        state.conversation_id = str(value.get("conversation_id") or state.conversation_id)
    if event.get("type") == "moderation":
        moderation = event.get("moderation_response")
        if isinstance(moderation, dict) and moderation.get("blocked") is True:
            state.blocked = True
    if event.get("type") == "server_ste_metadata":
        metadata = event.get("metadata")
        if isinstance(metadata, dict):
            if isinstance(metadata.get("tool_invoked"), bool):
                state.tool_invoked = metadata["tool_invoked"]
            state.turn_use_case = str(metadata.get("turn_use_case") or state.turn_use_case)


def conversation_base_event(event_type: str, state: ConversationState, **extra: Any) -> dict[str, Any]:
    return {
        "type": event_type,
        "text": state.text,
        "conversation_id": state.conversation_id,
        "file_ids": list(state.file_ids),
        "sediment_ids": list(state.sediment_ids),
        "blocked": state.blocked,
        "tool_invoked": state.tool_invoked,
        "turn_use_case": state.turn_use_case,
        **extra,
    }


def iter_conversation_payloads(payloads: Iterator[str], history_text: str = "",
                               history_messages: list[str] | None = None) -> Iterator[dict[str, Any]]:
    state = ConversationState()
    history_messages = history_messages or []
    history_index = 0
    for payload in payloads:
        # print(f"[upstream_sse] {payload}", flush=True)
        if not payload:
            continue
        if payload == "[DONE]":
            yield conversation_base_event("conversation.done", state, done=True)
            break
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            update_conversation_state(state, payload)
            yield conversation_base_event("conversation.raw", state, payload=payload)
            continue
        if not isinstance(event, dict):
            yield conversation_base_event("conversation.event", state, raw=event)
            continue
        update_conversation_state(state, payload, event)
        if history_index < len(history_messages) and event_assistant_text(event, history_text) == history_messages[history_index]:
            history_index += 1
            state.text = ""
            continue
        next_text = assistant_text(event, state.text, history_text)
        if next_text != state.text:
            delta = next_text[len(state.text):] if next_text.startswith(state.text) else next_text
            state.text = next_text
            yield conversation_base_event("conversation.delta", state, raw=event, delta=delta)
            continue
        yield conversation_base_event("conversation.event", state, raw=event)


def conversation_events(
    backend: OpenAIBackendAPI,
    messages: list[dict[str, Any]] | None = None,
    model: str = "auto",
    prompt: str = "",
    images: list[str] | None = None,
    size: str | None = None,
    quality: str | None = None,
) -> Iterator[dict[str, Any]]:
    normalized = normalize_messages(messages or ([{"role": "user", "content": prompt}] if prompt else []))
    image_model = str(model or "").strip() in IMAGE_MODELS
    history_text = "" if image_model else assistant_history_text(normalized)
    history_messages = [] if image_model else assistant_history_messages(normalized)
    final_prompt = build_image_prompt(prompt, size, quality) if image_model else prompt
    payloads = backend.stream_conversation(
        messages=normalized,
        model=model,
        prompt=final_prompt,
        images=images if image_model else None,
        system_hints=["picture_v2"] if image_model else None,
    )
    yield from iter_conversation_payloads(payloads, history_text, history_messages)


def text_backend(identity: dict[str, Any] | None = None) -> OpenAIBackendAPI:
    return OpenAIBackendAPI(access_token=account_service.get_text_access_token(identity))


def stream_text_deltas(backend: OpenAIBackendAPI, request: ConversationRequest) -> Iterator[str]:
    for event in conversation_events(backend, messages=request.messages, model=request.model, prompt=request.prompt):
        if event.get("type") != "conversation.delta":
            continue
        delta = str(event.get("delta") or "")
        if delta:
            yield delta


def collect_text(backend: OpenAIBackendAPI, request: ConversationRequest) -> str:
    return "".join(stream_text_deltas(backend, request))


def stream_image_outputs(
        backend: OpenAIBackendAPI,
        request: ConversationRequest,
        index: int = 1,
        total: int = 1,
) -> Iterator[ImageOutput]:
    if uses_codex_image_backend(request.model):
        yield ImageOutput(
            kind="progress",
            model=request.model,
            index=index,
            total=total,
            upstream_event_type="codex_responses.start",
        )
        final_prompt = build_image_prompt(request.prompt, request.size, request.quality)
        image_items = backend.generate_codex_image_items(
            final_prompt,
            images=request.images or [],
            size=request.size,
            quality=request.quality,
        )
        data = format_image_result(
            image_items,
            request.prompt,
            request.response_format,
            request.base_url,
            int(time.time()),
        )["data"]
        if data:
            yield ImageOutput(kind="result", model=request.model, index=index, total=total, data=data)
            return
        yield ImageOutput(kind="message", model=request.model, index=index, total=total, text="Codex image backend returned no image data")
        return

    last: dict[str, Any] = {}
    for event in conversation_events(
            backend,
            prompt=request.prompt,
            model=request.model,
            images=request.images or [],
            size=request.size,
            quality=request.quality,
    ):
        last = event
        if event.get("type") == "conversation.delta":
            yield ImageOutput(
                kind="progress",
                model=request.model,
                index=index,
                total=total,
                text=str(event.get("delta") or ""),
                upstream_event_type="conversation.delta",
            )
            continue
        if event.get("type") == "conversation.event":
            raw = event.get("raw")
            raw_type = str(raw.get("type") or "") if isinstance(raw, dict) else ""
            yield ImageOutput(
                kind="progress",
                model=request.model,
                index=index,
                total=total,
                upstream_event_type=raw_type,
            )

    conversation_id = str(last.get("conversation_id") or "")
    file_ids = [str(item) for item in last.get("file_ids") or []]
    sediment_ids = [str(item) for item in last.get("sediment_ids") or []]
    message = str(last.get("text") or "").strip()
    is_text_response = last.get("tool_invoked") is False or last.get("turn_use_case") == "text"
    logger.info({
        "event": "image_stream_resolve_start",
        "conversation_id": conversation_id,
        "file_ids": file_ids,
        "sediment_ids": sediment_ids,
        "tool_invoked": last.get("tool_invoked"),
        "turn_use_case": last.get("turn_use_case"),
    })
    if message and not file_ids and not sediment_ids and (last.get("blocked") or is_text_response):
        yield ImageOutput(kind="message", model=request.model, index=index, total=total, text=message)
        return

    image_urls = backend.resolve_conversation_image_urls(conversation_id, file_ids, sediment_ids)
    if image_urls:
        image_items = [
            {"b64_json": base64.b64encode(image_data).decode("ascii")}
            for image_data in backend.download_image_bytes(image_urls)
        ]
        data = format_image_result(
            image_items,
            request.prompt,
            request.response_format,
            request.base_url,
            int(time.time()),
        )["data"]
        if data:
            yield ImageOutput(kind="result", model=request.model, index=index, total=total, data=data)
        return

    if message:
        yield ImageOutput(kind="message", model=request.model, index=index, total=total, text=message)


def stream_image_outputs_with_pool(request: ConversationRequest) -> Iterator[ImageOutput]:
    if str(request.model or "").strip() not in IMAGE_MODELS:
        raise ImageGenerationError("unsupported image model,supported models: " + ", ".join(IMAGE_MODELS))
    if parse_image_dimensions(request.size) and not api_image_size(request.size):
        raise ImageGenerationError(
            "unsupported image size, width and height must be multiples of 16, max edge <= 3840, ratio <= 3:1, total pixels 655360-8294400",
            status_code=400,
            error_type="invalid_request_error",
            code="invalid_size",
            param="size",
        )

    generation_mode = normalize_image_generation_mode(request.generation_mode, request.identity)
    if generation_mode == "free":
        validate_free_image_request(request)

    if request_uses_openai_compatible_image_backend(request):
        for index in range(1, request.n + 1):
            charged = consume_image_billing(request.identity, generation_mode, request.quality, request.size)
            try:
                upstreams = enabled_openai_compatible_image_upstreams()
                if openai_compatible_image_queue_is_saturated(upstreams):
                    yield ImageOutput(
                        kind="progress",
                        model=request.model,
                        index=index,
                        total=request.n,
                        text="正在排队中，等待上游空闲槽位...",
                        upstream_event_type="openai_compatible.queued",
                    )
                yield from openai_compatible_image_outputs_with_failover(request, index, request.n)
                charged = ImageBillingCharge()
            except Exception:
                refund_image_billing(request.identity, charged)
                charged = ImageBillingCharge()
                raise
        return

    emitted = False
    last_error = ""
    for index in range(1, request.n + 1):
        charged = consume_image_billing(request.identity, generation_mode, request.quality, request.size)
        while True:
            token = ""
            try:
                token = account_service.get_available_access_token(request.identity)
            except RuntimeError as exc:
                refund_image_billing(request.identity, charged)
                charged = ImageBillingCharge()
                if emitted:
                    return
                error_message = str(exc) or "image generation failed"
                if is_image_pool_busy_error(error_message):
                    raise ImageGenerationError(
                        error_message,
                        status_code=429,
                        error_type="rate_limit_error",
                        code="image_pool_busy",
                    ) from exc
                raise ImageGenerationError(error_message) from exc

            emitted_for_token = False
            returned_message = False
            returned_result = False
            try:
                backend = OpenAIBackendAPI(access_token=token)
                notify_image_request_started(request)
                for output in stream_image_outputs(backend, request, index, request.n):
                    if output.kind == "message" and request.message_as_error:
                        raise ImageGenerationError(
                            output.text or "Image generation was rejected by upstream policy.",
                            status_code=400,
                            error_type="invalid_request_error",
                            code="content_policy_violation",
                        )
                    emitted = True
                    emitted_for_token = True
                    returned_message = output.kind == "message"
                    returned_result = returned_result or output.kind == "result"
                    yield output
                if returned_message or not returned_result:
                    account_service.mark_image_result(token, False)
                    refund_image_billing(request.identity, charged)
                    charged = ImageBillingCharge()
                    return
                account_service.mark_image_result(token, True)
                charged = ImageBillingCharge()
                break
            except ImageGenerationError:
                account_service.mark_image_result(token, False)
                refund_image_billing(request.identity, charged)
                charged = ImageBillingCharge()
                raise
            except Exception as exc:
                account_service.mark_image_result(token, False)
                last_error = str(exc)
                logger.warning({"event": "image_stream_fail", "request_token": token, "error": last_error})
                if not emitted_for_token and is_token_invalid_error(last_error):
                    account_service.remove_invalid_token(token, "image_stream")
                    continue
                refund_image_billing(request.identity, charged)
                charged = ImageBillingCharge()
                raise ImageGenerationError(image_stream_error_message(last_error)) from exc
            finally:
                account_service.release_access_token(token)

    if not emitted:
        raise ImageGenerationError(image_stream_error_message(last_error))


def stream_image_chunks(outputs: Iterable[ImageOutput]) -> Iterator[dict[str, Any]]:
    for output in outputs:
        yield output.to_chunk()


def collect_image_outputs(outputs: Iterable[ImageOutput]) -> dict[str, Any]:
    created = None
    data: list[dict[str, Any]] = []
    message = ""
    progress_parts: list[str] = []
    for output in outputs:
        created = created or output.created
        if output.kind == "progress" and output.text:
            progress_parts.append(output.text)
        elif output.kind == "message":
            message = output.text
        elif output.kind == "result":
            data.extend(output.data)

    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}
    if not data:
        text = message or "".join(progress_parts).strip()
        if text:
            result["message"] = text
    return result
