from __future__ import annotations

from datetime import datetime

from PIL import Image

from services.config import config
from services.image_file_utils import file_is_supported_image
from services.image_thumbnail_service import thumbnail_url_for_image_url


def _image_dimensions(path) -> tuple[int | None, int | None]:
    try:
        with Image.open(path) as image:
            return image.width, image.height
    except Exception:
        return None, None


def list_images(base_url: str, start_date: str = "", end_date: str = "") -> dict[str, object]:
    config.cleanup_old_images()
    items = []
    root = config.images_dir
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if not file_is_supported_image(path):
            continue
        rel = path.relative_to(root).as_posix()
        parts = rel.split("/")
        day = "-".join(parts[:3]) if len(parts) >= 4 else datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")
        if start_date and day < start_date:
            continue
        if end_date and day > end_date:
            continue
        url = f"{base_url.rstrip('/')}/images/{rel}"
        width, height = _image_dimensions(path)
        items.append({
            "name": path.name,
            "date": day,
            "size": path.stat().st_size,
            "width": width,
            "height": height,
            "url": url,
            "thumbnail_url": thumbnail_url_for_image_url(url),
            "created_at": datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        })
    items.sort(key=lambda item: str(item["created_at"]), reverse=True)
    groups: dict[str, list[dict[str, object]]] = {}
    for item in items:
        groups.setdefault(str(item["date"]), []).append(item)
    return {"items": items, "groups": [{"date": key, "items": value} for key, value in groups.items()]}
