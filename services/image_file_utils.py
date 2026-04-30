from __future__ import annotations

from pathlib import Path


def sniff_image_mime_and_extension(image_data: bytes) -> tuple[str, str] | None:
    if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if image_data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if image_data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", ".gif"
    if len(image_data) >= 12 and image_data[:4] == b"RIFF" and image_data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


def file_is_supported_image(path: Path) -> bool:
    try:
        with path.open("rb") as file:
            header = file.read(32)
    except OSError:
        return False
    return sniff_image_mime_and_extension(header) is not None
