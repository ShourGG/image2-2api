from __future__ import annotations

import base64
import hashlib
import hmac
import os
import random
import secrets
import uuid
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import datetime, timezone
from threading import Lock
from typing import Literal

from services.config import config
from services.storage.base import StorageBackend

AuthRole = Literal["admin", "user"]

_KIND_API_KEY = "api_key"
_KIND_USER_ACCOUNT = "user_account"
_PASSWORD_ALGO = "scrypt"
_PASSWORD_N = 1 << 14
_PASSWORD_R = 8
_PASSWORD_P = 1
DEFAULT_USER_POINTS = 50
DEFAULT_PAID_COINS = 0
DEFAULT_PAID_BONUS_USES = 1
COIN_EXCHANGE_RATE = 100
IMAGE_POINT_COST = 5
IMAGE_POINT_COSTS = {
    "standard": 5,
    "high": 20,
    "xhigh": 25,
}
IMAGE_POINT_COST_TABLE = {
    "normal": {
        "standard": 5,
        "high": 20,
        "xhigh": 25,
    },
    "2k": {
        "standard": 15,
        "high": 40,
        "xhigh": 50,
    },
    "4k": {
        "standard": 30,
        "high": 80,
        "xhigh": 100,
    },
}
PAID_IMAGE_COIN_COST_TABLE = {
    "normal": {
        "standard": 50,
        "high": 80,
        "xhigh": 100,
    },
    "2k": {
        "standard": 100,
        "high": 150,
        "xhigh": 200,
    },
    "4k": {
        "standard": 200,
        "high": 350,
        "xhigh": 500,
    },
}
NORMAL_CHECKIN_REWARD = 1.25
GAMBLE_MIN_RESERVED_POINTS = 10
GAMBLE_DEFAULT_BET = 10
CHECKIN_HISTORY_LIMIT = 20
POINTS_PRECISION = Decimal("0.01")
GAMBLE_OUTCOME_FACTORS = (-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _display_name_from_email(email: str) -> str:
    local, _, _ = email.partition("@")
    return local or email


def _normalize_invite_code(value: object) -> str:
    return "".join(ch for ch in str(value or "").strip().upper() if ch.isalnum())


def _default_invite_code(item_id: str) -> str:
    return f"U{_normalize_invite_code(item_id)}"


def _today_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _trimmed_decimal_text(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _coerce_decimal(value: object, default: float | int = 0) -> Decimal:
    try:
        return Decimal(str(value if value is not None else default)).quantize(POINTS_PRECISION, rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        return Decimal(str(default)).quantize(POINTS_PRECISION, rounding=ROUND_HALF_UP)


def _coerce_points(value: object, default: float = DEFAULT_USER_POINTS, *, allow_negative: bool = False) -> float:
    points = _coerce_decimal(value, default)
    if not allow_negative and points < 0:
        points = Decimal("0")
    return float(points)


def _coerce_non_negative_int(value: object, default: int = 0) -> int:
    try:
        normalized = int(value if value is not None else default)
    except (TypeError, ValueError):
        normalized = default
    return max(0, normalized)


def _normalize_image_mode(value: object) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in {"free", "paid"} else "free"


COMPATIBLE_4K_IMAGE_SIZES = {
    "2480x2480",
    "3056x2032",
    "2032x3056",
    "2880x2160",
    "2160x2880",
    "2784x2224",
    "2224x2784",
    "3312x1872",
    "1872x3312",
    "3808x1632",
}


def image_size_tier(value: object) -> str:
    size = str(value or "").strip().lower()
    mapped = {
        "1:1": "1024x1024",
        "16:9": "1536x1024",
        "4:3": "1536x1024",
        "9:16": "1024x1536",
        "3:4": "1024x1536",
        "auto": "",
        "": "",
    }.get(size, size)
    if "x" not in mapped:
        return "normal"
    width_text, _, height_text = mapped.partition("x")
    try:
        width = int(width_text)
        height = int(height_text)
    except ValueError:
        return "normal"
    if mapped in COMPATIBLE_4K_IMAGE_SIZES:
        return "4k"
    max_edge = max(width, height)
    total_pixels = width * height
    if max_edge >= 3600 or total_pixels >= 7_000_000:
        return "4k"
    if max_edge >= 2048 or total_pixels >= 2_000_000:
        return "2k"
    return "normal"


def image_point_cost_for_quality(value: object) -> int:
    quality = str(value or "").strip().lower()
    return IMAGE_POINT_COSTS.get(quality, IMAGE_POINT_COST)


def image_point_cost_for_request(quality: object, size: object = None) -> int:
    normalized_quality = str(quality or "").strip().lower()
    if normalized_quality not in IMAGE_POINT_COSTS:
        normalized_quality = "standard"
    tier = image_size_tier(size)
    return int(IMAGE_POINT_COST_TABLE.get(tier, IMAGE_POINT_COST_TABLE["normal"]).get(normalized_quality, IMAGE_POINT_COST))


def paid_image_coin_cost_for_request(quality: object, size: object = None) -> int:
    normalized_quality = str(quality or "").strip().lower()
    if normalized_quality not in IMAGE_POINT_COSTS:
        normalized_quality = "standard"
    tier = image_size_tier(size)
    return int(PAID_IMAGE_COIN_COST_TABLE.get(tier, PAID_IMAGE_COIN_COST_TABLE["normal"]).get(normalized_quality, 50))


def paid_bonus_allowed_for_request(quality: object, size: object = None) -> bool:
    return True


def _normalize_checkin_mode(value: object) -> str | None:
    mode = str(value or "").strip().lower()
    if mode in {"normal", "gamble"}:
        return mode
    return None


def _normalize_checkin_history(raw: object) -> list[dict[str, object]]:
    if not isinstance(raw, list):
        return []
    items: list[dict[str, object]] = []
    for entry in raw[:CHECKIN_HISTORY_LIMIT]:
        if not isinstance(entry, dict):
            continue
        mode = _normalize_checkin_mode(entry.get("mode"))
        date = str(entry.get("date") or "").strip()
        if not mode or not date:
            continue
        normalized_entry: dict[str, object] = {
            "mode": mode,
            "date": date,
            "at": str(entry.get("at") or "").strip() or None,
            "change": _coerce_points(entry.get("change"), 0, allow_negative=True),
            "points_before": _coerce_points(entry.get("points_before"), 0),
            "points_after": _coerce_points(entry.get("points_after"), 0),
        }
        if mode == "gamble":
            normalized_entry["bet"] = _coerce_points(entry.get("bet"), 0)
            normalized_entry["max_multiplier"] = _coerce_points(entry.get("max_multiplier"), 0)
            normalized_entry["actual_multiplier"] = _coerce_points(entry.get("actual_multiplier"), 0, allow_negative=True)
        items.append(normalized_entry)
    return items[:CHECKIN_HISTORY_LIMIT]


def _hash_password(password: str) -> str:
    salt = os.urandom(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_PASSWORD_N,
        r=_PASSWORD_R,
        p=_PASSWORD_P,
    )
    return "$".join(
        [
            _PASSWORD_ALGO,
            str(_PASSWORD_N),
            str(_PASSWORD_R),
            str(_PASSWORD_P),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(derived).decode("ascii"),
        ]
    )


def _verify_password(password: str, stored: str) -> bool:
    try:
        algo, n_text, r_text, p_text, salt_text, digest_text = str(stored or "").split("$", 5)
    except ValueError:
        return False
    if algo != _PASSWORD_ALGO:
        return False
    try:
        salt = base64.b64decode(salt_text.encode("ascii"))
        expected = base64.b64decode(digest_text.encode("ascii"))
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n_text),
            r=int(r_text),
            p=int(p_text),
        )
    except Exception:
        return False
    return hmac.compare_digest(derived, expected)


class AuthService:
    def __init__(self, storage: StorageBackend):
        self.storage = storage
        self._lock = Lock()
        self._items = self._load()
        self._last_used_flush_at: dict[str, datetime] = {}

    @staticmethod
    def _clean(value: object) -> str:
        return str(value or "").strip()

    @staticmethod
    def _default_key_name(role: object) -> str:
        return "管理员凭据" if str(role or "").strip().lower() == "admin" else "普通用户"

    def _clean_email(self, value: object) -> str:
        return self._clean(value).lower()

    def _normalize_api_key_item(self, raw: object) -> dict[str, object] | None:
        if not isinstance(raw, dict):
            return None
        role = self._clean(raw.get("role")).lower()
        if role not in {"admin", "user"}:
            return None
        key_hash = self._clean(raw.get("key_hash"))
        if not key_hash:
            return None
        item_id = self._clean(raw.get("id")) or uuid.uuid4().hex[:12]
        name = self._clean(raw.get("name")) or self._default_key_name(role)
        created_at = self._clean(raw.get("created_at")) or _now_iso()
        last_used_at = self._clean(raw.get("last_used_at")) or None
        return {
            "id": item_id,
            "kind": _KIND_API_KEY,
            "name": name,
            "role": role,
            "key_hash": key_hash,
            "enabled": bool(raw.get("enabled", True)),
            "created_at": created_at,
            "last_used_at": last_used_at,
        }

    def _normalize_user_item(self, raw: object) -> dict[str, object] | None:
        if not isinstance(raw, dict):
            return None
        email = self._clean_email(raw.get("email"))
        password_hash = self._clean(raw.get("password_hash"))
        if not email or not password_hash:
            return None
        role = self._clean(raw.get("role")).lower()
        if role not in {"admin", "user"}:
            role = "user"
        item_id = self._clean(raw.get("id")) or uuid.uuid4().hex[:12]
        name = self._clean(raw.get("name")) or _display_name_from_email(email)
        invite_code = _normalize_invite_code(raw.get("invite_code")) or _default_invite_code(item_id)
        invited_by_user_id = self._clean(raw.get("invited_by_user_id")) or None
        invited_by_invite_code = _normalize_invite_code(raw.get("invited_by_invite_code")) or None
        created_at = self._clean(raw.get("created_at")) or _now_iso()
        registration_ip = self._clean(raw.get("registration_ip")) or None
        last_login_at = self._clean(raw.get("last_login_at")) or None
        last_used_at = self._clean(raw.get("last_used_at")) or None
        session_hash = self._clean(raw.get("session_hash")) or None
        session_created_at = self._clean(raw.get("session_created_at")) or None
        points = _coerce_points(raw.get("points"))
        paid_coins = _coerce_non_negative_int(raw.get("paid_coins"), DEFAULT_PAID_COINS)
        paid_bonus_uses = _coerce_non_negative_int(raw.get("paid_bonus_uses"), DEFAULT_PAID_BONUS_USES)
        preferred_image_mode = _normalize_image_mode(raw.get("preferred_image_mode"))
        checkin_total_count = _coerce_non_negative_int(raw.get("checkin_total_count"))
        checkin_normal_count = _coerce_non_negative_int(raw.get("checkin_normal_count"))
        checkin_gamble_count = _coerce_non_negative_int(raw.get("checkin_gamble_count"))
        checkin_total_change = _coerce_points(raw.get("checkin_total_change"), 0, allow_negative=True)
        referral_count = _coerce_non_negative_int(raw.get("referral_count"))
        referral_points_earned = _coerce_points(raw.get("referral_points_earned"), 0)
        last_referral_at = self._clean(raw.get("last_referral_at")) or None
        last_checkin_date = self._clean(raw.get("last_checkin_date")) or None
        last_checkin_mode = _normalize_checkin_mode(raw.get("last_checkin_mode"))
        last_checkin_at = self._clean(raw.get("last_checkin_at")) or None
        checkin_history = _normalize_checkin_history(raw.get("checkin_history"))
        return {
            "id": item_id,
            "kind": _KIND_USER_ACCOUNT,
            "role": role,
            "email": email,
            "name": name,
            "invite_code": invite_code,
            "invited_by_user_id": invited_by_user_id,
            "invited_by_invite_code": invited_by_invite_code,
            "password_hash": password_hash,
            "enabled": bool(raw.get("enabled", True)),
            "created_at": created_at,
            "registration_ip": registration_ip,
            "last_login_at": last_login_at,
            "last_used_at": last_used_at,
            "session_hash": session_hash,
            "session_created_at": session_created_at,
            "points": points,
            "paid_coins": paid_coins,
            "paid_bonus_uses": paid_bonus_uses,
            "preferred_image_mode": preferred_image_mode,
            "checkin_total_count": checkin_total_count,
            "checkin_normal_count": checkin_normal_count,
            "checkin_gamble_count": checkin_gamble_count,
            "checkin_total_change": checkin_total_change,
            "referral_count": referral_count,
            "referral_points_earned": referral_points_earned,
            "last_referral_at": last_referral_at,
            "last_checkin_date": last_checkin_date,
            "last_checkin_mode": last_checkin_mode,
            "last_checkin_at": last_checkin_at,
            "checkin_history": checkin_history,
        }

    def _normalize_item(self, raw: object) -> dict[str, object] | None:
        if not isinstance(raw, dict):
            return None
        kind = self._clean(raw.get("kind")).lower()
        if kind == _KIND_USER_ACCOUNT or ("email" in raw and "password_hash" in raw):
            return self._normalize_user_item(raw)
        return self._normalize_api_key_item(raw)

    def _load(self) -> list[dict[str, object]]:
        try:
            items = self.storage.load_auth_keys()
        except Exception:
            return []
        if not isinstance(items, list):
            return []
        return [normalized for item in items if (normalized := self._normalize_item(item)) is not None]

    def _save(self) -> None:
        self.storage.save_auth_keys(self._items)

    def _has_key_name_locked(self, name: str, *, role: AuthRole, exclude_id: str = "") -> bool:
        candidate = self._clean(name)
        if not candidate:
            return False
        for item in self._items:
            if item.get("kind") != _KIND_API_KEY or item.get("role") != role:
                continue
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            if self._clean(item.get("name")) == candidate:
                return True
        return False

    def _build_default_key_name_locked(self, role: AuthRole, *, exclude_id: str = "") -> str:
        base_name = self._default_key_name(role)
        if not self._has_key_name_locked(base_name, role=role, exclude_id=exclude_id):
            return base_name
        suffix = 2
        while True:
            candidate = f"{base_name} {suffix}"
            if not self._has_key_name_locked(candidate, role=role, exclude_id=exclude_id):
                return candidate
            suffix += 1

    def _build_key_name_locked(self, name: str, *, role: AuthRole, exclude_id: str = "") -> str:
        candidate = self._clean(name)
        if not candidate:
            return self._build_default_key_name_locked(role, exclude_id=exclude_id)
        if self._has_key_name_locked(candidate, role=role, exclude_id=exclude_id):
            raise ValueError("这个名称已经在使用中了，换一个更容易区分的名称吧")
        return candidate

    def _has_key_hash_locked(self, key_hash: str, *, exclude_id: str = "") -> bool:
        for item in self._items:
            if item.get("kind") != _KIND_API_KEY:
                continue
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            stored_hash = self._clean(item.get("key_hash"))
            if stored_hash and hmac.compare_digest(stored_hash, key_hash):
                return True
        return False

    def _build_key_hash_locked(self, raw_key: str, *, exclude_id: str = "") -> str:
        candidate = self._clean(raw_key)
        if not candidate:
            raise ValueError("请输入新的专用密钥")
        admin_key = self._clean(config.auth_key)
        if admin_key and hmac.compare_digest(candidate, admin_key):
            raise ValueError("这个密钥和管理员密钥冲突了，请换一个新的密钥")
        key_hash = _hash_key(candidate)
        if self._has_key_hash_locked(key_hash, exclude_id=exclude_id):
            raise ValueError("这个专用密钥已经存在，请换一个新的密钥")
        return key_hash

    def _iter_items(self, *, kind: str | None = None, role: AuthRole | None = None):
        for index, item in enumerate(self._items):
            if kind is not None and item.get("kind") != kind:
                continue
            if role is not None and item.get("role") != role:
                continue
            yield index, item

    def _find_user_by_invite_code_locked(self, invite_code: str) -> tuple[int | None, dict[str, object] | None]:
        normalized_code = _normalize_invite_code(invite_code)
        if not normalized_code:
            return None, None
        for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
            if _normalize_invite_code(item.get("invite_code")) == normalized_code:
                return index, item
        return None, None

    def _new_invite_code_locked(self) -> str:
        while True:
            candidate = _normalize_invite_code(secrets.token_urlsafe(8))[:10]
            if len(candidate) < 6:
                continue
            if self._find_user_by_invite_code_locked(candidate)[1] is None:
                return candidate

    @staticmethod
    def _public_key_item(item: dict[str, object]) -> dict[str, object]:
        return {
            "id": item.get("id"),
            "name": item.get("name"),
            "role": item.get("role"),
            "enabled": bool(item.get("enabled", True)),
            "created_at": item.get("created_at"),
            "last_used_at": item.get("last_used_at"),
        }

    @staticmethod
    def _public_user_item(item: dict[str, object]) -> dict[str, object]:
        return {
            "id": item.get("id"),
            "name": item.get("name"),
            "role": item.get("role") if item.get("role") in {"admin", "user"} else "user",
            "email": item.get("email"),
            "invite_code": item.get("invite_code"),
            "invited_by_user_id": item.get("invited_by_user_id"),
            "invited_by_invite_code": item.get("invited_by_invite_code"),
            "enabled": bool(item.get("enabled", True)),
            "created_at": item.get("created_at"),
            "registration_ip": item.get("registration_ip"),
            "last_login_at": item.get("last_login_at"),
            "last_used_at": item.get("last_used_at"),
            "points": _coerce_points(item.get("points")),
            "paid_coins": _coerce_non_negative_int(item.get("paid_coins"), DEFAULT_PAID_COINS),
            "paid_bonus_uses": _coerce_non_negative_int(item.get("paid_bonus_uses"), DEFAULT_PAID_BONUS_USES),
            "preferred_image_mode": _normalize_image_mode(item.get("preferred_image_mode")),
            "checkin_total_count": _coerce_non_negative_int(item.get("checkin_total_count")),
            "checkin_normal_count": _coerce_non_negative_int(item.get("checkin_normal_count")),
            "checkin_gamble_count": _coerce_non_negative_int(item.get("checkin_gamble_count")),
            "checkin_total_change": _coerce_points(item.get("checkin_total_change"), 0, allow_negative=True),
            "referral_count": _coerce_non_negative_int(item.get("referral_count")),
            "referral_points_earned": _coerce_points(item.get("referral_points_earned"), 0),
            "last_referral_at": item.get("last_referral_at"),
            "last_checkin_date": item.get("last_checkin_date"),
            "last_checkin_mode": _normalize_checkin_mode(item.get("last_checkin_mode")),
            "last_checkin_at": item.get("last_checkin_at"),
        }

    @staticmethod
    def checkin_rules() -> dict[str, object]:
        return {
            "normal_reward": NORMAL_CHECKIN_REWARD,
            "min_reserved_points": GAMBLE_MIN_RESERVED_POINTS,
            "default_bet": GAMBLE_DEFAULT_BET,
            "max_history": CHECKIN_HISTORY_LIMIT,
            "gamble_outcome_factors": list(GAMBLE_OUTCOME_FACTORS),
            "summary": [
                "每天只能签到一次，普通签到和赌狗签到二选一。",
                "普通签到固定获得 1.25 积分。",
                "赌狗签到不是白嫖奖励，你自己定下注积分和最大倍率，系统会在正负倍率里随机结算。",
                "为了不把号玩死，最差结果也必须给自己留 10 积分。",
            ],
        }

    @staticmethod
    def _public_checkin_state(item: dict[str, object], latest_result: dict[str, object] | None = None) -> dict[str, object]:
        today = _today_key()
        payload: dict[str, object] = {
            "today": today,
            "checked_in_today": str(item.get("last_checkin_date") or "") == today,
            "last_checkin_date": item.get("last_checkin_date"),
            "last_checkin_mode": _normalize_checkin_mode(item.get("last_checkin_mode")),
            "last_checkin_at": item.get("last_checkin_at"),
            "history": _normalize_checkin_history(item.get("checkin_history")),
            "stats": {
                "total_count": _coerce_non_negative_int(item.get("checkin_total_count")),
                "normal_count": _coerce_non_negative_int(item.get("checkin_normal_count")),
                "gamble_count": _coerce_non_negative_int(item.get("checkin_gamble_count")),
                "total_change": _coerce_points(item.get("checkin_total_change"), 0, allow_negative=True),
            },
            "rules": AuthService.checkin_rules(),
        }
        if latest_result is not None:
            payload["latest_result"] = latest_result
        return payload

    def _public_user_profile(
        self,
        item: dict[str, object],
        *,
        latest_result: dict[str, object] | None = None,
    ) -> dict[str, object]:
        return {
            "item": self._public_user_item(item),
            "checkins": self._public_checkin_state(item, latest_result=latest_result),
        }

    @staticmethod
    def _require_checkin_available(item: dict[str, object]) -> None:
        if str(item.get("last_checkin_date") or "") == _today_key():
            raise ValueError("今天已经签到过了")

    @staticmethod
    def _append_checkin_history(item: dict[str, object], entry: dict[str, object]) -> list[dict[str, object]]:
        history = [entry, *_normalize_checkin_history(item.get("checkin_history"))]
        return history[:CHECKIN_HISTORY_LIMIT]

    def _apply_checkin_entry(
        self,
        item: dict[str, object],
        *,
        mode: str,
        change: Decimal,
        points_before: Decimal,
        points_after: Decimal,
        bet: Decimal | None = None,
        max_multiplier: Decimal | None = None,
        actual_multiplier: Decimal | None = None,
    ) -> tuple[dict[str, object], dict[str, object]]:
        now = _now_iso()
        today = _today_key()
        entry: dict[str, object] = {
            "mode": mode,
            "date": today,
            "at": now,
            "change": _coerce_points(change, 0, allow_negative=True),
            "points_before": _coerce_points(points_before, 0),
            "points_after": _coerce_points(points_after, 0),
        }
        if mode == "gamble":
            entry["bet"] = _coerce_points(bet, 0)
            entry["max_multiplier"] = _coerce_points(max_multiplier, 0)
            entry["actual_multiplier"] = _coerce_points(actual_multiplier, 0, allow_negative=True)

        next_item = dict(item)
        next_item["points"] = _coerce_points(points_after, 0)
        next_item["last_checkin_date"] = today
        next_item["last_checkin_mode"] = mode
        next_item["last_checkin_at"] = now
        next_item["checkin_total_count"] = _coerce_non_negative_int(item.get("checkin_total_count")) + 1
        next_item["checkin_normal_count"] = _coerce_non_negative_int(item.get("checkin_normal_count")) + (1 if mode == "normal" else 0)
        next_item["checkin_gamble_count"] = _coerce_non_negative_int(item.get("checkin_gamble_count")) + (1 if mode == "gamble" else 0)
        next_item["checkin_total_change"] = _coerce_points(
            _coerce_decimal(item.get("checkin_total_change"), 0) + change,
            0,
            allow_negative=True,
        )
        next_item["checkin_history"] = self._append_checkin_history(item, entry)
        return next_item, entry

    def list_keys(self, role: AuthRole | None = None) -> list[dict[str, object]]:
        with self._lock:
            return [self._public_key_item(item) for _, item in self._iter_items(kind=_KIND_API_KEY, role=role)]

    def create_key(self, *, role: AuthRole, name: str = "") -> tuple[dict[str, object], str]:
        with self._lock:
            normalized_name = self._build_key_name_locked(name, role=role)
            while True:
                raw_key = f"sk-{secrets.token_urlsafe(24)}"
                try:
                    key_hash = self._build_key_hash_locked(raw_key)
                    break
                except ValueError:
                    continue
            item = {
                "id": uuid.uuid4().hex[:12],
                "kind": _KIND_API_KEY,
                "name": normalized_name,
                "role": role,
                "key_hash": key_hash,
                "enabled": True,
                "created_at": _now_iso(),
                "last_used_at": None,
            }
            self._items.append(item)
            self._save()
            return self._public_key_item(item), raw_key

    def update_key(
        self,
        key_id: str,
        updates: dict[str, object],
        *,
        role: AuthRole | None = None,
    ) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return None
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_API_KEY, role=role):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                if "name" in updates and updates.get("name") is not None:
                    next_role: AuthRole = "admin" if next_item.get("role") == "admin" else "user"
                    next_item["name"] = self._build_key_name_locked(
                        str(updates.get("name") or ""),
                        role=next_role,
                        exclude_id=normalized_id,
                    )
                if "enabled" in updates and updates.get("enabled") is not None:
                    next_item["enabled"] = bool(updates.get("enabled"))
                if "key" in updates and updates.get("key") is not None:
                    next_item["key_hash"] = self._build_key_hash_locked(
                        str(updates.get("key") or ""),
                        exclude_id=normalized_id,
                    )
                self._items[index] = next_item
                self._save()
                return self._public_key_item(next_item)
        return None

    def delete_key(self, key_id: str, *, role: AuthRole | None = None) -> bool:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return False
        with self._lock:
            before = len(self._items)
            self._items = [
                item
                for item in self._items
                if not (
                    item.get("kind") == _KIND_API_KEY
                    and item.get("id") == normalized_id
                    and (role is None or item.get("role") == role)
                )
            ]
            if len(self._items) == before:
                return False
            self._save()
            return True

    def authenticate(self, raw_key: str) -> dict[str, object] | None:
        candidate = self._clean(raw_key)
        if not candidate:
            return None
        candidate_hash = _hash_key(candidate)
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_API_KEY):
                if not bool(item.get("enabled", True)):
                    continue
                stored_hash = self._clean(item.get("key_hash"))
                if not stored_hash or not hmac.compare_digest(stored_hash, candidate_hash):
                    continue
                next_item = dict(item)
                now = datetime.now(timezone.utc)
                next_item["last_used_at"] = now.isoformat()
                self._items[index] = next_item
                item_id = self._clean(next_item.get("id"))
                last_flush_at = self._last_used_flush_at.get(item_id)
                if last_flush_at is None or (now - last_flush_at).total_seconds() >= 60:
                    try:
                        self._save()
                        self._last_used_flush_at[item_id] = now
                    except Exception:
                        pass
                return self._public_key_item(next_item)
        return None

    def authenticate_admin_key(self, raw_key: str) -> dict[str, object] | None:
        candidate = self._clean(raw_key)
        if not candidate:
            return None
        legacy_auth_key = self._clean(config.auth_key)
        if legacy_auth_key and hmac.compare_digest(candidate, legacy_auth_key):
            return {"id": "admin", "name": "管理员", "role": "admin"}
        identity = self.authenticate(candidate)
        if identity and identity.get("role") == "admin":
            return identity
        return None

    def _find_user_by_email(self, email: str) -> tuple[int, dict[str, object]] | tuple[None, None]:
        normalized_email = self._clean_email(email)
        for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT):
            if item.get("email") == normalized_email:
                return index, item
        return None, None

    def _issue_user_session(self, item: dict[str, object]) -> tuple[dict[str, object], str]:
        raw_token = f"usr-{secrets.token_urlsafe(32)}"
        now = _now_iso()
        next_item = dict(item)
        next_item["session_hash"] = _hash_key(raw_token)
        next_item["session_created_at"] = now
        next_item["last_login_at"] = now
        next_item["last_used_at"] = now
        return next_item, raw_token

    def get_user(self, user_id: str) -> dict[str, object] | None:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            return None
        with self._lock:
            for _, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") == normalized_id:
                    return self._public_user_item(item)
        return None

    def list_users(self) -> list[dict[str, object]]:
        with self._lock:
            return [self._public_user_item(item) for _, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user")]

    def get_user_by_invite_code(self, invite_code: str) -> dict[str, object] | None:
        with self._lock:
            _index, item = self._find_user_by_invite_code_locked(invite_code)
            if item is None or not bool(item.get("enabled", True)):
                return None
            return self._public_user_item(item)

    def has_admin_account(self) -> bool:
        with self._lock:
            return any(True for _index, _item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="admin"))

    def get_user_profile(self, user_id: str) -> dict[str, object] | None:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            return None
        with self._lock:
            for _, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") == normalized_id:
                    return self._public_user_profile(item)
        return None

    def register_user(
        self,
        *,
        email: str,
        password: str,
        name: str = "",
        registration_ip: str = "",
        registration_ip_limit: int = 0,
        password_min_length: int = 6,
        name_required: bool = False,
        total_user_limit: int = 0,
        initial_points: object = DEFAULT_USER_POINTS,
        initial_paid_coins: object = DEFAULT_PAID_COINS,
        initial_paid_bonus_uses: object = DEFAULT_PAID_BONUS_USES,
        preferred_image_mode: str = "free",
        referrer_user_id: str = "",
        referral_reward_points: object = 0,
    ) -> tuple[dict[str, object], str]:
        normalized_email = self._clean_email(email)
        if "@" not in normalized_email:
            raise ValueError("email is invalid")
        try:
            normalized_password_min_length = max(1, int(password_min_length))
        except (TypeError, ValueError):
            normalized_password_min_length = 6
        if len(password or "") < normalized_password_min_length:
            raise ValueError(f"password must be at least {normalized_password_min_length} characters")
        cleaned_name = self._clean(name)
        if name_required and not cleaned_name:
            raise ValueError("name is required")
        normalized_name = cleaned_name or _display_name_from_email(normalized_email)
        normalized_registration_ip = self._clean(registration_ip) or None
        try:
            normalized_ip_limit = max(0, int(registration_ip_limit))
        except (TypeError, ValueError):
            normalized_ip_limit = 0
        try:
            normalized_total_user_limit = max(0, int(total_user_limit))
        except (TypeError, ValueError):
            normalized_total_user_limit = 0
        normalized_preferred_image_mode = str(preferred_image_mode or "free").strip().lower()
        if normalized_preferred_image_mode not in {"free", "paid"}:
            normalized_preferred_image_mode = "free"
        normalized_referrer_user_id = self._clean(referrer_user_id)
        referral_reward = _coerce_decimal(referral_reward_points, 0)
        if referral_reward < 0:
            referral_reward = Decimal("0")

        with self._lock:
            _, existing = self._find_user_by_email(normalized_email)
            if existing is not None:
                raise ValueError("email already registered")
            referrer_index: int | None = None
            referrer_item: dict[str, object] | None = None
            if normalized_referrer_user_id:
                for candidate_index, candidate in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                    if candidate.get("id") == normalized_referrer_user_id and bool(candidate.get("enabled", True)):
                        referrer_index = candidate_index
                        referrer_item = candidate
                        break
                if referrer_item is None:
                    raise ValueError("referral code invalid")
            if normalized_total_user_limit > 0:
                user_count = sum(1 for _index, _item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"))
                if user_count >= normalized_total_user_limit:
                    raise ValueError("user registration limit reached")
            if normalized_registration_ip and normalized_ip_limit > 0:
                registered_count = sum(
                    1
                    for _, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user")
                    if self._clean(item.get("registration_ip")) == normalized_registration_ip
                )
                if registered_count >= normalized_ip_limit:
                    raise ValueError("registration ip limit reached")

            item = {
                "id": uuid.uuid4().hex[:12],
                "kind": _KIND_USER_ACCOUNT,
                "role": "user",
                "email": normalized_email,
                "name": normalized_name,
                "invite_code": self._new_invite_code_locked(),
                "invited_by_user_id": referrer_item.get("id") if referrer_item else None,
                "invited_by_invite_code": referrer_item.get("invite_code") if referrer_item else None,
                "password_hash": _hash_password(password),
                "enabled": True,
                "created_at": _now_iso(),
                "registration_ip": normalized_registration_ip,
                "last_login_at": None,
                "last_used_at": None,
                "session_hash": None,
                "session_created_at": None,
                "points": _coerce_points(initial_points, DEFAULT_USER_POINTS),
                "paid_coins": _coerce_non_negative_int(initial_paid_coins, DEFAULT_PAID_COINS),
                "paid_bonus_uses": _coerce_non_negative_int(initial_paid_bonus_uses, DEFAULT_PAID_BONUS_USES),
                "preferred_image_mode": normalized_preferred_image_mode,
                "checkin_total_count": 0,
                "checkin_normal_count": 0,
                "checkin_gamble_count": 0,
                "checkin_total_change": 0,
                "referral_count": 0,
                "referral_points_earned": 0,
                "last_referral_at": None,
                "last_checkin_date": None,
                "last_checkin_mode": None,
                "last_checkin_at": None,
                "checkin_history": [],
            }
            item, raw_token = self._issue_user_session(item)
            self._items.append(item)
            if referrer_index is not None and referrer_item is not None:
                now = _now_iso()
                next_referrer = dict(referrer_item)
                next_referrer["points"] = _coerce_points(_coerce_decimal(next_referrer.get("points"), 0) + referral_reward, 0)
                next_referrer["referral_count"] = _coerce_non_negative_int(next_referrer.get("referral_count")) + 1
                next_referrer["referral_points_earned"] = _coerce_points(
                    _coerce_decimal(next_referrer.get("referral_points_earned"), 0) + referral_reward,
                    0,
                )
                next_referrer["last_referral_at"] = now
                self._items[referrer_index] = next_referrer
            self._save()
            return self._public_user_item(item), raw_token

    def login_user(self, *, email: str, password: str) -> tuple[dict[str, object], str]:
        normalized_email = self._clean_email(email)
        if not normalized_email or not password:
            raise ValueError("email and password are required")
        with self._lock:
            index, item = self._find_user_by_email(normalized_email)
            if item is None or index is None or not _verify_password(password, self._clean(item.get("password_hash"))):
                raise ValueError("email or password is invalid")
            if not bool(item.get("enabled", True)):
                raise ValueError("user is disabled")
            next_item, raw_token = self._issue_user_session(item)
            self._items[index] = next_item
            self._save()
            return self._public_user_item(next_item), raw_token

    def bind_admin_account(self, *, email: str, password: str, name: str = "") -> dict[str, object]:
        normalized_email = self._clean_email(email)
        if "@" not in normalized_email:
            raise ValueError("email is invalid")
        if len(password or "") < 6:
            raise ValueError("password must be at least 6 characters")
        normalized_name = self._clean(name) or _display_name_from_email(normalized_email)

        with self._lock:
            index, existing = self._find_user_by_email(normalized_email)
            now = _now_iso()
            if existing is None or index is None:
                next_item = {
                    "id": uuid.uuid4().hex[:12],
                    "kind": _KIND_USER_ACCOUNT,
                    "role": "admin",
                    "email": normalized_email,
                    "name": normalized_name,
                    "password_hash": _hash_password(password),
                    "enabled": True,
                    "created_at": now,
                    "registration_ip": None,
                    "last_login_at": None,
                    "last_used_at": None,
                    "session_hash": None,
                    "session_created_at": None,
                    "points": DEFAULT_USER_POINTS,
                    "paid_coins": DEFAULT_PAID_COINS,
                    "paid_bonus_uses": DEFAULT_PAID_BONUS_USES,
                    "preferred_image_mode": "free",
                    "checkin_total_count": 0,
                    "checkin_normal_count": 0,
                    "checkin_gamble_count": 0,
                    "checkin_total_change": 0,
                    "last_checkin_date": None,
                    "last_checkin_mode": None,
                    "last_checkin_at": None,
                    "checkin_history": [],
                }
                self._items.append(next_item)
            else:
                next_item = dict(existing)
                next_item["kind"] = _KIND_USER_ACCOUNT
                next_item["role"] = "admin"
                next_item["email"] = normalized_email
                next_item["name"] = normalized_name
                next_item["password_hash"] = _hash_password(password)
                next_item["enabled"] = True
                next_item["session_hash"] = None
                next_item["session_created_at"] = None
                self._items[index] = next_item
            self._save()
            return self._public_user_item(next_item)

    def authenticate_session(self, raw_token: str) -> dict[str, object] | None:
        candidate = self._clean(raw_token)
        if not candidate:
            return None
        candidate_hash = _hash_key(candidate)
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT):
                if not bool(item.get("enabled", True)):
                    continue
                session_hash = self._clean(item.get("session_hash"))
                if not session_hash or not hmac.compare_digest(session_hash, candidate_hash):
                    continue
                next_item = dict(item)
                now = datetime.now(timezone.utc)
                next_item["last_used_at"] = now.isoformat()
                self._items[index] = next_item
                item_id = self._clean(next_item.get("id"))
                last_flush_at = self._last_used_flush_at.get(item_id)
                if last_flush_at is None or (now - last_flush_at).total_seconds() >= 60:
                    try:
                        self._save()
                        self._last_used_flush_at[item_id] = now
                    except Exception:
                        pass
                return self._public_user_item(next_item)
        return None

    def update_user(self, user_id: str, updates: dict[str, object]) -> dict[str, object] | None:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            return None
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                if "name" in updates and updates.get("name") is not None:
                    next_item["name"] = self._clean(updates.get("name")) or next_item.get("name") or _display_name_from_email(
                        self._clean_email(next_item.get("email"))
                    )
                if "enabled" in updates and updates.get("enabled") is not None:
                    next_item["enabled"] = bool(updates.get("enabled"))
                if "points" in updates and updates.get("points") is not None:
                    next_item["points"] = _coerce_points(updates.get("points"), _coerce_points(next_item.get("points")))
                if "paid_coins" in updates and updates.get("paid_coins") is not None:
                    next_item["paid_coins"] = _coerce_non_negative_int(updates.get("paid_coins"), _coerce_non_negative_int(next_item.get("paid_coins"), DEFAULT_PAID_COINS))
                if "paid_bonus_uses" in updates and updates.get("paid_bonus_uses") is not None:
                    next_item["paid_bonus_uses"] = _coerce_non_negative_int(updates.get("paid_bonus_uses"), _coerce_non_negative_int(next_item.get("paid_bonus_uses"), DEFAULT_PAID_BONUS_USES))
                if "preferred_image_mode" in updates and updates.get("preferred_image_mode") is not None:
                    next_item["preferred_image_mode"] = _normalize_image_mode(updates.get("preferred_image_mode"))
                if "password" in updates and updates.get("password") is not None:
                    password = str(updates.get("password") or "")
                    if len(password) < 6:
                        raise ValueError("password must be at least 6 characters")
                    next_item["password_hash"] = _hash_password(password)
                    next_item["session_hash"] = None
                    next_item["session_created_at"] = None
                self._items[index] = next_item
                self._save()
                return self._public_user_item(next_item)
        return None

    def delete_user(self, user_id: str) -> bool:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            return False
        with self._lock:
            before = len(self._items)
            self._items = [
                item
                for item in self._items
                if not (item.get("kind") == _KIND_USER_ACCOUNT and item.get("role") == "user" and item.get("id") == normalized_id)
            ]
            if len(self._items) == before:
                return False
            self._save()
            return True

    def change_user_points(self, user_id: str, delta: object) -> dict[str, object]:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            raise ValueError("user id is required")
        delta_value = _coerce_decimal(delta, 0)
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                current_points = _coerce_decimal(next_item.get("points"), 0)
                next_points = current_points + delta_value
                if next_points < 0:
                    raise ValueError("insufficient points")
                next_item["points"] = _coerce_points(next_points, 0)
                self._items[index] = next_item
                self._save()
                return self._public_user_item(next_item)
        raise ValueError("user not found")

    def consume_paid_image_credit(
        self,
        user_id: str,
        *,
        cost: int,
        bonus_allowed: bool = True,
    ) -> dict[str, object]:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            raise ValueError("user id is required")
        normalized_cost = _coerce_non_negative_int(cost)
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                bonus_uses = _coerce_non_negative_int(next_item.get("paid_bonus_uses"), DEFAULT_PAID_BONUS_USES)
                if bonus_allowed and bonus_uses > 0:
                    next_item["paid_bonus_uses"] = bonus_uses - 1
                    self._items[index] = next_item
                    self._save()
                    return {"kind": "bonus", "amount": 1, "item": self._public_user_item(next_item)}

                paid_coins = _coerce_non_negative_int(next_item.get("paid_coins"), DEFAULT_PAID_COINS)
                if paid_coins < normalized_cost:
                    raise ValueError("insufficient paid coins")
                next_item["paid_coins"] = paid_coins - normalized_cost
                self._items[index] = next_item
                self._save()
                return {"kind": "coins", "amount": normalized_cost, "item": self._public_user_item(next_item)}
        raise ValueError("user not found")

    def refund_paid_image_credit(self, user_id: str, *, kind: object, amount: object) -> dict[str, object] | None:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            return None
        normalized_kind = str(kind or "").strip().lower()
        normalized_amount = _coerce_non_negative_int(amount)
        if normalized_kind not in {"bonus", "coins"} or normalized_amount <= 0:
            return None
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                if normalized_kind == "bonus":
                    next_item["paid_bonus_uses"] = _coerce_non_negative_int(next_item.get("paid_bonus_uses"), DEFAULT_PAID_BONUS_USES) + normalized_amount
                else:
                    next_item["paid_coins"] = _coerce_non_negative_int(next_item.get("paid_coins"), DEFAULT_PAID_COINS) + normalized_amount
                self._items[index] = next_item
                self._save()
                return self._public_user_item(next_item)
        return None

    def add_paid_coins(self, user_id: str, amount: object) -> dict[str, object]:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            raise ValueError("user id is required")
        normalized_amount = _coerce_non_negative_int(amount)
        if normalized_amount <= 0:
            raise ValueError("coin amount must be greater than 0")
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                next_item["paid_coins"] = _coerce_non_negative_int(next_item.get("paid_coins"), DEFAULT_PAID_COINS) + normalized_amount
                self._items[index] = next_item
                self._save()
                return self._public_user_item(next_item)
        raise ValueError("user not found")

    def perform_normal_checkin(self, user_id: str) -> dict[str, object]:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            raise ValueError("user id is required")
        reward = _coerce_decimal(NORMAL_CHECKIN_REWARD, 0)
        with self._lock:
            for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") != normalized_id:
                    continue
                self._require_checkin_available(item)
                points_before = _coerce_decimal(item.get("points"), 0)
                points_after = points_before + reward
                next_item, latest_result = self._apply_checkin_entry(
                    item,
                    mode="normal",
                    change=reward,
                    points_before=points_before,
                    points_after=points_after,
                )
                self._items[index] = next_item
                self._save()
                return self._public_user_profile(next_item, latest_result=latest_result)
        raise ValueError("user not found")

    def perform_gamble_checkin(self, user_id: str, *, bet: object, max_multiplier: object) -> dict[str, object]:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            raise ValueError("user id is required")
        bet_value = _coerce_decimal(bet, 0)
        max_multiplier_value = _coerce_decimal(max_multiplier, 0)
        if bet_value <= 0:
            raise ValueError("下注积分必须大于 0")
        if max_multiplier_value <= 0:
            raise ValueError("最大倍率必须大于 0")

        with self._lock:
            for index, item in self._iter_items(kind=_KIND_USER_ACCOUNT, role="user"):
                if item.get("id") != normalized_id:
                    continue
                self._require_checkin_available(item)
                points_before = _coerce_decimal(item.get("points"), 0)
                reserved_points = _coerce_decimal(GAMBLE_MIN_RESERVED_POINTS, 0)
                available_risk = points_before - reserved_points
                if available_risk <= 0:
                    raise ValueError("账户至少要保留 10 积分")
                if max_multiplier_value > points_before:
                    raise ValueError("最大倍率不能高于当前账户积分")
                if bet_value * max_multiplier_value > available_risk:
                    raise ValueError("下注积分 × 最大倍率后仍需至少保留 10 积分")

                outcome_factor = Decimal(str(random.choice(GAMBLE_OUTCOME_FACTORS)))
                actual_multiplier = (max_multiplier_value * outcome_factor).quantize(POINTS_PRECISION, rounding=ROUND_HALF_UP)
                change = (bet_value * actual_multiplier).quantize(POINTS_PRECISION, rounding=ROUND_HALF_UP)
                points_after = (points_before + change).quantize(POINTS_PRECISION, rounding=ROUND_HALF_UP)
                if points_after < reserved_points:
                    raise ValueError("结算后账户积分不能低于 10")

                next_item, latest_result = self._apply_checkin_entry(
                    item,
                    mode="gamble",
                    change=change,
                    points_before=points_before,
                    points_after=points_after,
                    bet=bet_value,
                    max_multiplier=max_multiplier_value,
                    actual_multiplier=actual_multiplier,
                )
                self._items[index] = next_item
                self._save()
                return self._public_user_profile(next_item, latest_result=latest_result)
        raise ValueError("user not found")


auth_service = AuthService(config.get_storage_backend())
