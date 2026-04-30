import base64
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
import unittest


ROOT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT_DIR / "data" / "output"
BASE_URL = str(os.getenv("CHATGPT2API_TEST_BASE_URL") or "http://127.0.0.1:8025").rstrip("/")
HTTP_TESTS_ENABLED = str(os.getenv("CHATGPT2API_RUN_HTTP_TESTS") or "").strip().lower() in {"1", "true", "yes", "on"}

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def load_auth_key() -> str:
    env_key = str(os.getenv("CHATGPT2API_TEST_AUTH_KEY") or os.getenv("CHATGPT2API_AUTH_KEY") or "").strip()
    if env_key:
        return env_key
    config_path = ROOT_DIR / "config.json"
    if config_path.is_file():
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            payload = {}
        auth_key = str(payload.get("auth-key") or "").strip()
        if auth_key:
            return auth_key
    return "chatgpt2api"


AUTH_KEY = load_auth_key()
requires_http_server = unittest.skipUnless(
    HTTP_TESTS_ENABLED,
    "set CHATGPT2API_RUN_HTTP_TESTS=1 to run HTTP integration tests",
)


def post_json(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {AUTH_KEY}"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode())


def detect_ext(image_bytes: bytes) -> str:
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        return ".webp"
    if image_bytes.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    return ".png"


def save_image(image_b64: str, name: str) -> Path:
    image_bytes = base64.b64decode(image_b64)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"{name}_{int(time.time())}{detect_ext(image_bytes)}"
    path.write_bytes(image_bytes)
    return path


def save_images_from_text(text: str, prefix: str) -> list[Path]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    matches = re.findall(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+", text or "")
    saved_paths: list[Path] = []
    timestamp = int(time.time() * 1000)
    for index, data_url in enumerate(matches, start=1):
        header, encoded = data_url.split(",", 1)
        image_type = header.split(";")[0].removeprefix("data:image/").strip() or "png"
        extension = "jpg" if image_type == "jpeg" else image_type
        path = OUTPUT_DIR / f"{prefix}_{timestamp}_{index}.{extension}"
        path.write_bytes(base64.b64decode(encoded))
        saved_paths.append(path)
    return saved_paths
