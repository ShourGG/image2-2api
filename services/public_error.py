from __future__ import annotations

import re

TOKEN_PATTERN = re.compile(r"(sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._~+/=-]+)")
URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+")
LOCAL_PATH_PATTERN = re.compile(r"(/root|/home|/etc|[A-Za-z]:\\)[^\s\"'<>]*")


def sanitize_public_error_message(message: object) -> str:
    text = str(message or "").strip()
    if not text:
        return "请求失败，请稍后重试"

    lowered = text.lower()
    if "no available image quota" in lowered:
        return "暂无可用图片额度，请稍后再试或切换生成方式"
    if "pool is busy" in lowered or "正在忙碌" in text:
        return "当前图片池正在忙碌中，请稍后重试"
    if "concurrency limit" in lowered or "too many requests" in lowered or "http 429" in lowered:
        return "上游并发繁忙，系统会排队或稍后重试"
    if "files is not supported" in lowered or "file is not supported" in lowered:
        return "当前上游不支持这种图生图参数，请减少参考图或切换上游"
    if "timeout" in lowered or "timed out" in lowered:
        return "图片生成超时，请稍后重试"
    if "traceback" in lowered or "stack" in lowered or LOCAL_PATH_PATTERN.search(text):
        return "服务处理失败，请稍后重试"
    if "upstream" in lowered or "http 5" in lowered or "bad gateway" in lowered:
        return "图片上游请求失败，请稍后重试"

    sanitized = TOKEN_PATTERN.sub("[redacted]", text)
    sanitized = URL_PATTERN.sub("[upstream-url]", sanitized)
    sanitized = LOCAL_PATH_PATTERN.sub("[local-path]", sanitized)
    return sanitized[:240] if len(sanitized) > 240 else sanitized
