from __future__ import annotations

import threading
from pathlib import Path

from PIL import Image, ImageOps

from services.config import DATA_DIR, config
from services.image_file_utils import file_is_supported_image

THUMBNAILS_DIR = DATA_DIR / "image_thumbnails"
THUMBNAIL_MAX_SIDE = 768
THUMBNAIL_QUALITY = 82

_thumbnail_lock = threading.RLock()


def _safe_relative_path(value: str) -> Path:
    rel = Path(str(value or "").lstrip("/"))
    if rel.is_absolute() or ".." in rel.parts:
        raise FileNotFoundError("invalid image path")
    return rel


def _thumbnail_path_for_relative_path(relative_path: Path) -> Path:
    return THUMBNAILS_DIR / relative_path.with_name(f"{relative_path.name}.jpg")


def thumbnail_url_for_image_url(image_url: str) -> str:
    return str(image_url or "").replace("/images/", "/image-thumbnails/", 1)


def ensure_thumbnail_for_relative_path(relative_path: str) -> Path:
    rel = _safe_relative_path(relative_path)
    source = config.images_dir / rel
    if not source.is_file() or not file_is_supported_image(source):
        raise FileNotFoundError("image not found")

    target = _thumbnail_path_for_relative_path(rel)
    with _thumbnail_lock:
        if target.is_file() and target.stat().st_mtime >= source.stat().st_mtime:
            return target

        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image)
            image.thumbnail((THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE), Image.Resampling.LANCZOS)
            if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
                canvas = Image.new("RGB", image.size, (255, 255, 255))
                canvas.paste(image.convert("RGBA"), mask=image.convert("RGBA").getchannel("A"))
                image = canvas
            else:
                image = image.convert("RGB")
            image.save(target, "JPEG", quality=THUMBNAIL_QUALITY, optimize=True, progressive=True)
        return target


def create_thumbnail_for_image_path(path: Path) -> Path | None:
    try:
        relative_path = path.relative_to(config.images_dir).as_posix()
        return ensure_thumbnail_for_relative_path(relative_path)
    except Exception:
        return None
