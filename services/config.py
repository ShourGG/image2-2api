from __future__ import annotations

from dataclasses import dataclass
import json
import os
import sys
from pathlib import Path
import time
from urllib.parse import urlsplit
import uuid

from services.storage.base import StorageBackend

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = BASE_DIR / "config.json"
VERSION_FILE = BASE_DIR / "VERSION"
IMAGE_GENERATION_STRATEGIES = {"chatgpt2api", "gpt2api", "codex_responses", "openai_compatible"}


@dataclass(frozen=True)
class LoadedSettings:
    auth_key: str
    refresh_account_interval_minute: int


def _normalize_auth_key(value: object) -> str:
    return str(value or "").strip()


def _is_invalid_auth_key(value: object) -> bool:
    return _normalize_auth_key(value) == ""


def _read_json_object(path: Path, *, name: str) -> dict[str, object]:
    if not path.exists():
        return {}
    if path.is_dir():
        print(
            f"Warning: {name} at '{path}' is a directory, ignoring it and falling back to other configuration sources.",
            file=sys.stderr,
        )
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _load_settings() -> LoadedSettings:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    raw_config = _read_json_object(CONFIG_FILE, name="config.json")
    auth_key = _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY") or raw_config.get("auth-key"))
    if _is_invalid_auth_key(auth_key):
        raise ValueError(
            "❌ auth-key 未设置！\n"
            "请在环境变量 CHATGPT2API_AUTH_KEY 中设置，或者在 config.json 中填写 auth-key。"
        )

    try:
        refresh_interval = int(raw_config.get("refresh_account_interval_minute", 5))
    except (TypeError, ValueError):
        refresh_interval = 5

    return LoadedSettings(
        auth_key=auth_key,
        refresh_account_interval_minute=refresh_interval,
    )


def _new_id() -> str:
    return uuid.uuid4().hex


def _coerce_bool(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _coerce_non_negative_int(value: object, default: int) -> int:
    try:
        normalized = int(value if value is not None else default)
    except (TypeError, ValueError):
        normalized = default
    return max(0, normalized)


def _normalize_origin(value: object) -> str:
    text = str(value or "").strip().rstrip("/")
    if not text:
        return ""
    parsed = urlsplit(text)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def _normalize_api_upstream(
    raw: object,
    *,
    previous: dict[str, object] | None = None,
    include_secret: bool = True,
    fallback_max_concurrency: int = 8,
) -> dict[str, object]:
    source = raw if isinstance(raw, dict) else {}
    upstream_id = str(source.get("id") or previous.get("id") if previous else source.get("id") or "").strip() or _new_id()
    base_url = str(source.get("base_url") or previous.get("base_url") if previous else source.get("base_url") or "").strip().rstrip("/")
    api_key = str(source.get("api_key") or "").strip()
    if not api_key and previous:
        api_key = str(previous.get("api_key") or "").strip()
    item: dict[str, object] = {
        "id": upstream_id,
        "name": str(source.get("name") or previous.get("name") if previous else source.get("name") or "OpenAI兼容上游").strip() or "OpenAI兼容上游",
        "base_url": base_url,
        "model": str(source.get("model") or previous.get("model") if previous else source.get("model") or "gpt-image-2").strip() or "gpt-image-2",
        "max_concurrency": max(
            1,
            _coerce_non_negative_int(
                source.get("max_concurrency")
                if source.get("max_concurrency") is not None
                else previous.get("max_concurrency") if previous else fallback_max_concurrency,
                _coerce_non_negative_int(previous.get("max_concurrency") if previous else fallback_max_concurrency, fallback_max_concurrency),
            ),
        ),
        "enabled": bool(source.get("enabled", previous.get("enabled", True) if previous else True)),
        "api_key_set": bool(api_key),
    }
    if include_secret:
        item["api_key"] = api_key
    return item


class ConfigStore:
    def __init__(self, path: Path):
        self.path = path
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.data = self._load()
        self._storage_backend: StorageBackend | None = None
        if _is_invalid_auth_key(self.auth_key):
            raise ValueError(
                "❌ auth-key 未设置！\n"
                "请按以下任意一种方式解决：\n"
                "1. 在 Render 的 Environment 变量中添加：\n"
                "   CHATGPT2API_AUTH_KEY = your_real_auth_key\n"
                "2. 或者在 config.json 中填写：\n"
                '   "auth-key": "your_real_auth_key"'
            )

    def _load(self) -> dict[str, object]:
        return _read_json_object(self.path, name="config.json")

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @property
    def auth_key(self) -> str:
        return _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY") or self.data.get("auth-key"))

    @property
    def accounts_file(self) -> Path:
        return DATA_DIR / "accounts.json"

    @property
    def refresh_account_interval_minute(self) -> int:
        try:
            return int(self.data.get("refresh_account_interval_minute", 5))
        except (TypeError, ValueError):
            return 5

    @property
    def image_retention_days(self) -> int:
        try:
            return max(1, int(self.data.get("image_retention_days", 30)))
        except (TypeError, ValueError):
            return 30

    @property
    def auth_rate_limit_login_ip_limit(self) -> int:
        return _coerce_non_negative_int(self.data.get("auth_rate_limit_login_ip_limit", 30), 30)

    @property
    def auth_rate_limit_login_ip_window_seconds(self) -> int:
        return max(1, _coerce_non_negative_int(self.data.get("auth_rate_limit_login_ip_window_seconds", 300), 300))

    @property
    def auth_rate_limit_login_ip_email_limit(self) -> int:
        return _coerce_non_negative_int(self.data.get("auth_rate_limit_login_ip_email_limit", 10), 10)

    @property
    def auth_rate_limit_login_ip_email_window_seconds(self) -> int:
        return max(1, _coerce_non_negative_int(self.data.get("auth_rate_limit_login_ip_email_window_seconds", 300), 300))

    @property
    def auth_rate_limit_register_ip_limit(self) -> int:
        return _coerce_non_negative_int(self.data.get("auth_rate_limit_register_ip_limit", 10), 10)

    @property
    def auth_rate_limit_register_ip_window_seconds(self) -> int:
        return max(1, _coerce_non_negative_int(self.data.get("auth_rate_limit_register_ip_window_seconds", 1800), 1800))

    @property
    def auth_rate_limit_register_ip_email_limit(self) -> int:
        return _coerce_non_negative_int(self.data.get("auth_rate_limit_register_ip_email_limit", 3), 3)

    @property
    def auth_rate_limit_register_ip_email_window_seconds(self) -> int:
        return max(1, _coerce_non_negative_int(self.data.get("auth_rate_limit_register_ip_email_window_seconds", 1800), 1800))

    @property
    def auth_register_ip_account_limit(self) -> int:
        return _coerce_non_negative_int(self.data.get("auth_register_ip_account_limit", 1), 1)

    @property
    def auto_remove_invalid_accounts(self) -> bool:
        return _coerce_bool(self.data.get("auto_remove_invalid_accounts", False), False)

    @property
    def auto_remove_rate_limited_accounts(self) -> bool:
        return _coerce_bool(self.data.get("auto_remove_rate_limited_accounts", False), False)

    @property
    def log_levels(self) -> list[str]:
        levels = self.data.get("log_levels")
        if not isinstance(levels, list):
            return []
        allowed = {"debug", "info", "warning", "error"}
        return [level for item in levels if (level := str(item or "").strip().lower()) in allowed]

    @property
    def image_generation_strategy(self) -> str:
        value = str(
            os.getenv("CHATGPT2API_IMAGE_GENERATION_STRATEGY")
            or self.data.get("image_generation_strategy")
            or "chatgpt2api"
        ).strip().lower()
        return value if value in IMAGE_GENERATION_STRATEGIES else "chatgpt2api"

    @property
    def image_generation_upstream_model(self) -> str:
        return str(
            os.getenv("CHATGPT2API_IMAGE_GENERATION_UPSTREAM_MODEL")
            or self.data.get("image_generation_upstream_model")
            or ""
        ).strip()

    @property
    def image_generation_enable_reasoning(self) -> bool:
        value = os.getenv("CHATGPT2API_IMAGE_GENERATION_ENABLE_REASONING")
        if value is None:
            value = self.data.get("image_generation_enable_reasoning", False)
        return _coerce_bool(value, False)

    @property
    def image_generation_codex_model(self) -> str:
        value = str(
            os.getenv("CHATGPT2API_IMAGE_GENERATION_CODEX_MODEL")
            or self.data.get("image_generation_codex_model")
            or "gpt-5.4"
        ).strip()
        # The Web picture_v2 route uses dash slugs such as gpt-5-5, while the
        # Codex Responses route uses dotted model names.
        if value == "gpt-5-5":
            return "gpt-5.5"
        if value == "gpt-5-4":
            return "gpt-5.4"
        return value or "gpt-5.4"

    @property
    def image_generation_codex_reasoning_effort(self) -> str:
        value = str(
            os.getenv("CHATGPT2API_IMAGE_GENERATION_CODEX_REASONING_EFFORT")
            or self.data.get("image_generation_codex_reasoning_effort")
            or "none"
        ).strip().lower()
        return value if value in {"none", "low", "medium", "high", "xhigh"} else "none"

    @property
    def image_generation_api_base_url(self) -> str:
        return str(
            os.getenv("CHATGPT2API_IMAGE_GENERATION_API_BASE_URL")
            or self.data.get("image_generation_api_base_url")
            or ""
        ).strip().rstrip("/")

    @property
    def image_generation_api_key(self) -> str:
        return str(
            os.getenv("CHATGPT2API_IMAGE_GENERATION_API_KEY")
            or self.data.get("image_generation_api_key")
            or ""
        ).strip()

    @property
    def image_generation_api_model(self) -> str:
        return str(
            os.getenv("CHATGPT2API_IMAGE_GENERATION_API_MODEL")
            or self.data.get("image_generation_api_model")
            or "gpt-image-2"
        ).strip() or "gpt-image-2"

    @property
    def image_generation_api_max_concurrency(self) -> int:
        value = os.getenv("CHATGPT2API_IMAGE_GENERATION_API_MAX_CONCURRENCY")
        if value is None:
            value = self.data.get("image_generation_api_max_concurrency", 8)
        try:
            return max(1, int(value))
        except (TypeError, ValueError):
            return 8

    @property
    def image_generation_api_upstreams(self) -> list[dict[str, object]]:
        env_base_url = self.image_generation_api_base_url
        env_api_key = self.image_generation_api_key
        if os.getenv("CHATGPT2API_IMAGE_GENERATION_API_BASE_URL") or os.getenv("CHATGPT2API_IMAGE_GENERATION_API_KEY"):
            return [
                _normalize_api_upstream(
                    {
                        "id": "env",
                        "name": "环境变量上游",
                        "base_url": env_base_url,
                        "api_key": env_api_key,
                        "model": self.image_generation_api_model,
                        "enabled": True,
                    },
                    include_secret=True,
                    fallback_max_concurrency=self.image_generation_api_max_concurrency,
                )
            ]

        raw = self.data.get("image_generation_api_upstreams")
        if isinstance(raw, list):
            items = [
                _normalize_api_upstream(
                    item,
                    include_secret=True,
                    fallback_max_concurrency=self.image_generation_api_max_concurrency,
                )
                for item in raw
            ]
            return [
                item
                for item in items
                if str(item.get("base_url") or "").strip()
            ]

        if self.image_generation_api_base_url or self.image_generation_api_key:
            return [
                _normalize_api_upstream(
                    {
                        "id": "default",
                        "name": "默认上游",
                        "base_url": self.image_generation_api_base_url,
                        "api_key": self.image_generation_api_key,
                        "model": self.image_generation_api_model,
                        "enabled": True,
                    },
                    include_secret=True,
                    fallback_max_concurrency=self.image_generation_api_max_concurrency,
                )
            ]
        return []

    def get_image_generation_api_upstream(self, upstream_id: str) -> dict[str, object] | None:
        target = str(upstream_id or "").strip()
        for item in self.image_generation_api_upstreams:
            if str(item.get("id") or "") == target:
                return item
        return None

    @property
    def image_generation_api_total_max_concurrency(self) -> int:
        enabled_upstreams = [
            item
            for item in self.image_generation_api_upstreams
            if item.get("enabled", True) and str(item.get("base_url") or "").strip()
        ]
        if not enabled_upstreams:
            return max(1, self.image_generation_api_max_concurrency)
        total = 0
        for item in enabled_upstreams:
            total += max(1, _coerce_non_negative_int(item.get("max_concurrency"), self.image_generation_api_max_concurrency))
        return max(1, total)

    @property
    def images_dir(self) -> Path:
        path = DATA_DIR / "images"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def cleanup_old_images(self) -> int:
        cutoff = time.time() - self.image_retention_days * 86400
        removed = 0
        for path in self.images_dir.rglob("*"):
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        for path in sorted((p for p in self.images_dir.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            try:
                path.rmdir()
            except OSError:
                pass
        return removed

    @property
    def base_url(self) -> str:
        return str(
            os.getenv("CHATGPT2API_BASE_URL")
            or self.data.get("base_url")
            or ""
        ).strip().rstrip("/")

    @property
    def enable_api_docs(self) -> bool:
        value = os.getenv("CHATGPT2API_ENABLE_API_DOCS")
        if value is None:
            value = self.data.get("enable_api_docs", False)
        return _coerce_bool(value, False)

    @property
    def cors_allowed_origins(self) -> list[str]:
        raw = os.getenv("CHATGPT2API_CORS_ALLOWED_ORIGINS")
        if raw is None:
            raw = self.data.get("cors_allowed_origins")

        candidates: list[object] = []
        base_origin = _normalize_origin(self.base_url)
        if base_origin:
            candidates.append(base_origin)

        if isinstance(raw, list):
            candidates.extend(raw)
        elif isinstance(raw, str):
            candidates.extend(part.strip() for part in raw.replace("\n", ",").split(","))

        if not base_origin:
            candidates.extend(["http://localhost:3000", "http://127.0.0.1:3000"])

        origins: list[str] = []
        seen: set[str] = set()
        for candidate in candidates:
            origin = _normalize_origin(candidate)
            if not origin or origin in seen:
                continue
            seen.add(origin)
            origins.append(origin)
        return origins

    @property
    def app_version(self) -> str:
        try:
            value = VERSION_FILE.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return "0.0.0"
        return value or "0.0.0"

    def get(self) -> dict[str, object]:
        data = dict(self.data)
        data["refresh_account_interval_minute"] = self.refresh_account_interval_minute
        data["image_retention_days"] = self.image_retention_days
        data["auth_rate_limit_login_ip_limit"] = self.auth_rate_limit_login_ip_limit
        data["auth_rate_limit_login_ip_window_seconds"] = self.auth_rate_limit_login_ip_window_seconds
        data["auth_rate_limit_login_ip_email_limit"] = self.auth_rate_limit_login_ip_email_limit
        data["auth_rate_limit_login_ip_email_window_seconds"] = self.auth_rate_limit_login_ip_email_window_seconds
        data["auth_rate_limit_register_ip_limit"] = self.auth_rate_limit_register_ip_limit
        data["auth_rate_limit_register_ip_window_seconds"] = self.auth_rate_limit_register_ip_window_seconds
        data["auth_rate_limit_register_ip_email_limit"] = self.auth_rate_limit_register_ip_email_limit
        data["auth_rate_limit_register_ip_email_window_seconds"] = self.auth_rate_limit_register_ip_email_window_seconds
        data["auth_register_ip_account_limit"] = self.auth_register_ip_account_limit
        data["auto_remove_invalid_accounts"] = self.auto_remove_invalid_accounts
        data["auto_remove_rate_limited_accounts"] = self.auto_remove_rate_limited_accounts
        data["log_levels"] = self.log_levels
        data["enable_api_docs"] = self.enable_api_docs
        data["cors_allowed_origins"] = self.cors_allowed_origins
        data["image_generation_strategy"] = self.image_generation_strategy
        data["image_generation_upstream_model"] = self.image_generation_upstream_model
        data["image_generation_enable_reasoning"] = self.image_generation_enable_reasoning
        data["image_generation_codex_model"] = self.image_generation_codex_model
        data["image_generation_codex_reasoning_effort"] = self.image_generation_codex_reasoning_effort
        data["image_generation_api_base_url"] = self.image_generation_api_base_url
        data["image_generation_api_model"] = self.image_generation_api_model
        data["image_generation_api_max_concurrency"] = self.image_generation_api_max_concurrency
        data["image_generation_api_total_max_concurrency"] = self.image_generation_api_total_max_concurrency
        data["image_generation_api_key_set"] = bool(self.image_generation_api_key)
        data["image_generation_api_upstreams"] = [
            _normalize_api_upstream(
                item,
                include_secret=False,
                fallback_max_concurrency=self.image_generation_api_max_concurrency,
            )
            for item in self.image_generation_api_upstreams
        ]
        data.pop("auth-key", None)
        data.pop("image_generation_api_key", None)
        return data

    def get_proxy_settings(self) -> str:
        return str(self.data.get("proxy") or "").strip()

    def update(self, data: dict[str, object]) -> dict[str, object]:
        next_data = dict(self.data)
        next_data.update(dict(data or {}))
        next_data.pop("image_generation_api_key_set", None)
        if isinstance((data or {}).get("image_generation_api_upstreams"), list):
            previous_items = {
                str(item.get("id") or ""): item
                for item in self.image_generation_api_upstreams
                if str(item.get("id") or "")
            }
            merged_items = []
            for raw_item in data.get("image_generation_api_upstreams") or []:
                if not isinstance(raw_item, dict):
                    continue
                item_id = str(raw_item.get("id") or "").strip()
                previous = previous_items.get(item_id)
                item = _normalize_api_upstream(
                    raw_item,
                    previous=previous,
                    include_secret=True,
                    fallback_max_concurrency=self.image_generation_api_max_concurrency,
                )
                if str(item.get("base_url") or "").strip():
                    merged_items.append(item)
            next_data["image_generation_api_upstreams"] = merged_items
        if "image_generation_api_key" in next_data and not str(next_data.get("image_generation_api_key") or "").strip():
            if self.data.get("image_generation_api_key"):
                next_data["image_generation_api_key"] = self.data.get("image_generation_api_key")
            else:
                next_data.pop("image_generation_api_key", None)
        self.data = next_data
        self._save()
        return self.get()

    def get_storage_backend(self) -> StorageBackend:
        """获取存储后端实例（单例）"""
        if self._storage_backend is None:
            from services.storage.factory import create_storage_backend
            self._storage_backend = create_storage_backend(DATA_DIR)
        return self._storage_backend


config = ConfigStore(CONFIG_FILE)
