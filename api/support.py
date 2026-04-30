from __future__ import annotations

from pathlib import Path
from threading import Event, Thread

from fastapi import HTTPException, Request, UploadFile

from services.account_service import account_service
from services.auth_service import auth_service
from services.config import config
from services.image_file_utils import (
    MAX_UPLOAD_IMAGE_BYTES,
    MAX_UPLOAD_IMAGE_COUNT,
    sniff_image_mime_and_extension,
)

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIST_DIR = BASE_DIR / "web_dist"


def extract_bearer_token(authorization: str | None) -> str:
    scheme, _, value = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return ""
    return value.strip()


def _legacy_admin_identity(token: str) -> dict[str, object] | None:
    auth_key = str(config.auth_key or "").strip()
    if auth_key and token == auth_key:
        return {"id": "admin", "name": "管理员", "role": "admin"}
    return None


def require_identity(authorization: str | None) -> dict[str, object]:
    token = extract_bearer_token(authorization)
    identity = _legacy_admin_identity(token) or auth_service.authenticate(token) or auth_service.authenticate_session(token)
    if identity is None:
        raise HTTPException(status_code=401, detail={"error": "authorization is invalid"})
    return identity


def require_auth_key(authorization: str | None) -> None:
    require_identity(authorization)


def require_admin(authorization: str | None) -> dict[str, object]:
    identity = require_identity(authorization)
    if identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail={"error": "admin permission required"})
    return identity


def resolve_image_base_url(request: Request) -> str:
    return config.base_url or f"{request.url.scheme}://{request.headers.get('host', request.url.netloc)}"


def raise_image_quota_error(exc: Exception) -> None:
    message = str(exc)
    if "no available image quota" in message.lower():
        raise HTTPException(status_code=429, detail={"error": message or "no available image quota"}) from exc
    if "pool is busy" in message.lower() or "正在忙碌" in message:
        raise HTTPException(status_code=429, detail={"error": message or "free image pool is busy, please retry later"}) from exc
    raise HTTPException(status_code=502, detail={"error": message}) from exc


def ensure_upload_count(uploads: list[UploadFile]) -> None:
    if len(uploads) > MAX_UPLOAD_IMAGE_COUNT:
        raise HTTPException(
            status_code=400,
            detail={"error": f"too many image files, max {MAX_UPLOAD_IMAGE_COUNT}"},
        )


async def read_validated_image_upload(upload: UploadFile) -> tuple[bytes, str, str]:
    image_data = await upload.read(MAX_UPLOAD_IMAGE_BYTES + 1)
    if not image_data:
        raise HTTPException(status_code=400, detail={"error": "image file is empty"})
    if len(image_data) > MAX_UPLOAD_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"error": f"image file is too large, max {MAX_UPLOAD_IMAGE_BYTES // 1024 // 1024}MB"},
        )
    detected = sniff_image_mime_and_extension(image_data)
    if not detected:
        raise HTTPException(status_code=400, detail={"error": "invalid image file"})
    mime_type, extension = detected
    filename = Path(str(upload.filename or f"image{extension}")).name or f"image{extension}"
    if "." not in filename:
        filename = f"{filename}{extension}"
    return image_data, mime_type, filename


def sanitize_cpa_pool(pool: dict | None) -> dict | None:
    if not isinstance(pool, dict):
        return None
    return {key: value for key, value in pool.items() if key != "secret_key"}


def sanitize_cpa_pools(pools: list[dict]) -> list[dict]:
    return [sanitized for pool in pools if (sanitized := sanitize_cpa_pool(pool)) is not None]


def sanitize_sub2api_server(server: dict | None) -> dict | None:
    if not isinstance(server, dict):
        return None
    sanitized = {key: value for key, value in server.items() if key not in {"password", "api_key"}}
    sanitized["has_api_key"] = bool(str(server.get("api_key") or "").strip())
    return sanitized


def sanitize_sub2api_servers(servers: list[dict]) -> list[dict]:
    return [sanitized for server in servers if (sanitized := sanitize_sub2api_server(server)) is not None]


def start_limited_account_watcher(stop_event: Event) -> Thread:
    interval_seconds = config.refresh_account_interval_minute * 60

    def worker() -> None:
        while not stop_event.is_set():
            try:
                limited_tokens = account_service.list_limited_tokens()
                if limited_tokens:
                    print(f"[account-limited-watcher] checking {len(limited_tokens)} limited accounts")
                    account_service.refresh_accounts(limited_tokens)
            except Exception as exc:
                print(f"[account-limited-watcher] fail {exc}")
            stop_event.wait(interval_seconds)

    thread = Thread(target=worker, name="limited-account-watcher", daemon=True)
    thread.start()
    return thread


def resolve_web_asset(requested_path: str) -> Path | None:
    if not WEB_DIST_DIR.exists():
        return None
    clean_path = requested_path.strip("/")
    base_dir = WEB_DIST_DIR.resolve()
    candidates = [base_dir / "index.html"] if not clean_path else [
        base_dir / Path(clean_path),
        base_dir / clean_path / "index.html",
        base_dir / f"{clean_path}.html",
    ]
    for candidate in candidates:
        try:
            candidate.resolve().relative_to(base_dir)
        except ValueError:
            continue
        if candidate.is_file():
            return candidate
    return None
