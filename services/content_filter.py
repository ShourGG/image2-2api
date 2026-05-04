from __future__ import annotations

from typing import Any

from curl_cffi import requests
from fastapi import HTTPException

from services.config import config
from services.proxy_service import proxy_settings

DEFAULT_REVIEW_PROMPT = "判断用户请求是否允许。只回答 ALLOW 或 REJECT。"


def _text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_text(item) for item in value)
    if isinstance(value, dict):
        parts: list[str] = []
        for key in ("text", "input_text", "content", "input", "instructions", "system", "prompt", "messages", "tools"):
            if key in value:
                parts.append(_text(value.get(key)))
        return "\n".join(part for part in parts if part.strip())
    return ""


def request_text(*values: object) -> str:
    return "\n".join(part for value in values if (part := _text(value).strip()))


def check_request(text: str) -> None:
    candidate = str(text or "")
    if not candidate:
        return

    for word in config.sensitive_words:
        if word and word in candidate:
            raise HTTPException(status_code=400, detail={"error": "检测到敏感词，拒绝本次任务"})

    review = config.ai_review
    if not bool(review.get("enabled")):
        return

    base_url = str(review.get("base_url") or "").strip().rstrip("/")
    api_key = str(review.get("api_key") or "").strip()
    model = str(review.get("model") or "").strip()
    if not base_url or not api_key or not model:
        raise HTTPException(status_code=400, detail={"error": "AI 审核配置不完整"})

    prompt = str(review.get("prompt") or DEFAULT_REVIEW_PROMPT).strip() or DEFAULT_REVIEW_PROMPT
    content = f"{prompt}\n\n用户请求:\n{candidate}\n\n只回答 ALLOW 或 REJECT。"
    session = requests.Session(**proxy_settings.build_session_kwargs(impersonate="edge101", verify=False))
    try:
        response = session.post(
            f"{base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": model, "messages": [{"role": "user", "content": content}], "temperature": 0},
            timeout=60,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code} {response.text[:300]}")
        data: Any = response.json()
        result = str(data["choices"][0]["message"]["content"]).strip().lower()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail={"error": f"AI 审核失败：{exc}"}) from exc
    finally:
        session.close()

    if result.startswith(("allow", "pass", "true", "yes", "通过", "允许", "安全")):
        return
    raise HTTPException(status_code=400, detail={"error": "AI 审核未通过，拒绝本次任务"})
