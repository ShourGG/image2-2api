from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
import math
from threading import Lock
import time


@dataclass(frozen=True)
class RateLimitRule:
    key: str
    limit: int
    window_seconds: int


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    retry_after_seconds: int = 0
    remaining: int = 0


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def clear(self) -> None:
        with self._lock:
            self._events.clear()

    def hit_many(self, rules: list[RateLimitRule]) -> RateLimitResult:
        normalized_rules = [
            RateLimitRule(
                key=str(rule.key or "").strip(),
                limit=max(1, int(rule.limit)),
                window_seconds=max(1, int(rule.window_seconds)),
            )
            for rule in rules
            if str(rule.key or "").strip()
        ]
        if not normalized_rules:
            return RateLimitResult(allowed=True, remaining=0)

        now = time.time()
        retry_after_seconds = 0
        windows: list[tuple[RateLimitRule, deque[float]]] = []

        with self._lock:
            for rule in normalized_rules:
                bucket = self._events[rule.key]
                cutoff = now - rule.window_seconds
                while bucket and bucket[0] <= cutoff:
                    bucket.popleft()
                if len(bucket) >= rule.limit:
                    retry_after_seconds = max(
                        retry_after_seconds,
                        int(math.ceil(rule.window_seconds - (now - bucket[0]))),
                    )
                windows.append((rule, bucket))

            if retry_after_seconds > 0:
                return RateLimitResult(allowed=False, retry_after_seconds=retry_after_seconds)

            for _, bucket in windows:
                bucket.append(now)

            remaining = min(max(0, rule.limit - len(bucket)) for rule, bucket in windows)
            return RateLimitResult(allowed=True, remaining=remaining)


rate_limit_service = SlidingWindowRateLimiter()
