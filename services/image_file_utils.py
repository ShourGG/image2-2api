from __future__ import annotations

from pathlib import Path

MAX_UPLOAD_IMAGE_BYTES = 20 * 1024 * 1024
MAX_UPLOAD_IMAGE_COUNT = 8
MAX_IMAGE_PROMPT_LENGTH = 24000
MAX_IMAGE_TASK_ID_LENGTH = 96
MAX_IMAGE_BATCH_TASKS = 8
MAX_PENDING_IMAGE_TASKS_PER_OWNER = 20
MAX_PENDING_IMAGE_TASKS_TOTAL = 200


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
