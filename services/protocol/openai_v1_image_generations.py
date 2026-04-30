from __future__ import annotations

from typing import Any, Iterator

from services.protocol.conversation import (
    ConversationRequest,
    collect_image_outputs,
    stream_image_chunks,
    stream_image_outputs_with_pool,
)


def handle(body: dict[str, Any]) -> dict[str, Any] | Iterator[dict[str, Any]]:
    prompt = str(body.get("prompt") or "")
    model = str(body.get("model") or "gpt-image-2")
    n = int(body.get("n") or 1)
    size = body.get("size")
    quality = body.get("quality")
    generation_mode = body.get("generation_mode")
    response_format = str(body.get("response_format") or "b64_json")
    base_url = str(body.get("base_url") or "") or None
    outputs = stream_image_outputs_with_pool(ConversationRequest(
        prompt=prompt,
        model=model,
        n=n,
        size=size,
        quality=quality,
        response_format=response_format,
        base_url=base_url,
        message_as_error=True,
        identity=body.get("identity") if isinstance(body.get("identity"), dict) else None,
        generation_mode=str(generation_mode or "") or None,
        on_start=body.get("_task_on_start") if callable(body.get("_task_on_start")) else None,
    ))
    if body.get("stream"):
        return stream_image_chunks(outputs)
    return collect_image_outputs(outputs)
