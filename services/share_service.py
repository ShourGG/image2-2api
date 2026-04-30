from __future__ import annotations

import json
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from services.config import DATA_DIR, config


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _clean_text(value: object, max_length: int) -> str:
    return _clean(value)[:max_length]


def _normalize_result(value: object) -> int | None:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result >= 1 else None


def _origin(value: object) -> str:
    text = _clean(value).rstrip("/")
    parsed = urlsplit(text)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


class ShareService:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with self._lock:
            self._items = self._load_locked()

    def create_share(
        self,
        identity: dict[str, object],
        *,
        image_url: str,
        prompt: str,
        revised_prompt: str,
        model: str,
        size: str,
        quality: str,
        result: int | None,
        created_at: str,
        base_url: str,
    ) -> dict[str, Any]:
        owner_id = _clean(identity.get("id")) or "anonymous"
        normalized_base_url = _origin(base_url)
        if not normalized_base_url:
            raise ValueError("base_url is invalid")

        allowed_origins = {normalized_base_url}
        configured_origin = _origin(config.base_url)
        if configured_origin:
            allowed_origins.add(configured_origin)

        item = {
            "id": self._new_share_id_locked(),
            "owner_id": owner_id,
            "image_url": self._normalize_image_url(
                image_url,
                canonical_origin=normalized_base_url,
                allowed_origins=allowed_origins,
            ),
            "prompt": _clean_text(prompt, 8000),
            "revised_prompt": _clean_text(revised_prompt, 24000),
            "model": _clean(model, "gpt-image-2"),
            "size": _clean(size),
            "quality": _clean(quality),
            "result": _normalize_result(result),
            "created_at": _clean(created_at),
            "shared_at": _now_iso(),
        }
        with self._lock:
            self._items[item["id"]] = item
            self._save_locked()
            return self._public_item_locked(item)

    def get_share(self, share_id: str) -> dict[str, Any] | None:
        normalized_id = _clean(share_id)
        if not normalized_id:
            return None
        with self._lock:
            item = self._items.get(normalized_id)
            if item is None:
                return None
            return self._public_item_locked(item)

    def _normalize_image_url(
        self,
        value: object,
        *,
        canonical_origin: str,
        allowed_origins: set[str],
    ) -> str:
        text = _clean(value)
        if not text:
            raise ValueError("image_url is required")

        if text.startswith("/images/"):
            path = text
        else:
            parsed = urlsplit(text)
            origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
            if not origin or origin not in allowed_origins:
                raise ValueError("image_url must use current site origin")
            path = parsed.path

        if not path.startswith("/images/"):
            raise ValueError("only generated images can be shared")
        return f"{canonical_origin}{path}"

    def _public_item_locked(self, item: dict[str, Any]) -> dict[str, Any]:
        public_item = {
            "id": item.get("id"),
            "image_url": item.get("image_url"),
            "prompt": item.get("prompt"),
            "model": item.get("model"),
            "size": item.get("size"),
            "quality": item.get("quality"),
            "shared_at": item.get("shared_at"),
        }
        if item.get("revised_prompt"):
            public_item["revised_prompt"] = item.get("revised_prompt")
        if item.get("created_at"):
            public_item["created_at"] = item.get("created_at")
        if item.get("result") is not None:
            public_item["result"] = item.get("result")
        return public_item

    def _new_share_id_locked(self) -> str:
        while True:
            candidate = secrets.token_urlsafe(6).replace("-", "").replace("_", "")
            candidate = candidate[:10] or secrets.token_hex(5)
            if candidate not in self._items:
                return candidate

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        raw_items = payload.get("items") if isinstance(payload, dict) else payload
        if not isinstance(raw_items, list):
            return {}
        items: dict[str, dict[str, Any]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            share_id = _clean(item.get("id"))
            image_url = _clean(item.get("image_url"))
            if not share_id or not image_url:
                continue
            items[share_id] = {
                "id": share_id,
                "owner_id": _clean(item.get("owner_id")),
                "image_url": image_url,
                "prompt": _clean_text(item.get("prompt"), 8000),
                "revised_prompt": _clean_text(item.get("revised_prompt"), 24000),
                "model": _clean(item.get("model"), "gpt-image-2"),
                "size": _clean(item.get("size")),
                "quality": _clean(item.get("quality")),
                "result": _normalize_result(item.get("result")),
                "created_at": _clean(item.get("created_at")),
                "shared_at": _clean(item.get("shared_at"), _now_iso()),
            }
        return items

    def _save_locked(self) -> None:
        payload = {
            "items": list(self._items.values()),
        }
        self.path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


share_service = ShareService(DATA_DIR / "shares.json")
