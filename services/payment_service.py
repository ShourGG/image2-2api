from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlencode

from services.auth_service import auth_service
from services.config import DATA_DIR, config

PAYMENTS_FILE = DATA_DIR / "payments.json"
MONEY_PRECISION = Decimal("0.01")
LINUXDO_SUCCESS_STATUSES = {"TRADE_SUCCESS", "TRADE_FINISHED", "SUCCESS", "PAID", "1"}


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _clean(value: object) -> str:
    return str(value or "").strip()


def _coerce_money(value: object) -> Decimal:
    try:
        amount = Decimal(str(value if value is not None else "0")).quantize(MONEY_PRECISION, rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        amount = Decimal("0.00")
    return amount if amount >= 0 else Decimal("0.00")


def _money_text(value: object) -> str:
    return format(_coerce_money(value), "f")


def _coerce_positive_int(value: object) -> int:
    try:
        amount = int(value)
    except (TypeError, ValueError):
        return 0
    return amount if amount > 0 else 0


def linuxdo_epay_sign(params: dict[str, object], key: str) -> str:
    filtered = {
        str(name): str(value)
        for name, value in params.items()
        if str(name) not in {"sign", "sign_type"} and value is not None and str(value) != ""
    }
    source = "&".join(f"{name}={filtered[name]}" for name in sorted(filtered)) + key
    return hashlib.md5(source.encode("utf-8")).hexdigest()


def _public_order(item: dict[str, object], *, include_payment_url: bool = False) -> dict[str, object]:
    payload = {
        "id": item.get("id"),
        "out_trade_no": item.get("out_trade_no"),
        "status": item.get("status"),
        "provider": item.get("provider"),
        "package_id": item.get("package_id"),
        "package_name": item.get("package_name"),
        "amount": item.get("amount"),
        "coins": item.get("coins"),
        "created_at": item.get("created_at"),
        "updated_at": item.get("updated_at"),
        "paid_at": item.get("paid_at"),
        "provider_trade_no": item.get("provider_trade_no"),
    }
    if include_payment_url:
        payload["payment_url"] = item.get("payment_url")
    return payload


class PaymentService:
    def __init__(self, path: Path = PAYMENTS_FILE, auth=auth_service):
        self.path = path
        self.auth = auth
        self._lock = Lock()
        self._items = self._load()

    def _load(self) -> list[dict[str, object]]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return []
        if isinstance(raw, dict):
            raw = raw.get("items")
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, dict)]

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"items": self._items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def linuxdo_packages() -> list[dict[str, object]]:
        return [dict(item) for item in config.linuxdo_pay_packages if bool(item.get("enabled", True))]

    @staticmethod
    def linuxdo_public_config() -> dict[str, object]:
        configured = bool(config.linuxdo_pay_pid and config.linuxdo_pay_key)
        return {
            "enabled": bool(config.linuxdo_pay_enabled and configured),
            "configured": configured,
            "packages": PaymentService.linuxdo_packages(),
        }

    @staticmethod
    def _find_package(package_id: str) -> dict[str, object] | None:
        normalized_id = _clean(package_id)
        if not normalized_id:
            return None
        for item in PaymentService.linuxdo_packages():
            if _clean(item.get("id")) == normalized_id:
                return item
        return None

    def list_orders(self, *, identity: dict[str, object], limit: int = 50) -> list[dict[str, object]]:
        role = _clean(identity.get("role"))
        user_id = _clean(identity.get("id"))
        normalized_limit = max(1, min(200, int(limit or 50)))
        with self._lock:
            items = list(reversed(self._items))
            if role != "admin":
                items = [item for item in items if _clean(item.get("user_id")) == user_id]
            return [_public_order(item) for item in items[:normalized_limit]]

    def create_linuxdo_order(
        self,
        *,
        user: dict[str, object],
        package_id: str,
        notify_url: str,
        return_url: str,
        client_ip: str = "",
    ) -> dict[str, object]:
        if _clean(user.get("role")) != "user":
            raise ValueError("user permission required")
        if not config.linuxdo_pay_enabled:
            raise ValueError("linuxdo pay disabled")
        pid = config.linuxdo_pay_pid
        key = config.linuxdo_pay_key
        if not pid or not key:
            raise ValueError("linuxdo pay not configured")
        package = self._find_package(package_id)
        if package is None:
            raise ValueError("payment package not found")

        out_trade_no = f"LD{int(time.time())}{secrets.token_hex(6)}"
        amount = _money_text(package.get("amount"))
        coins = _coerce_positive_int(package.get("coins"))
        package_name = _clean(package.get("name")) or f"{coins} 图币"
        params = {
            "pid": pid,
            "type": config.linuxdo_pay_type,
            "out_trade_no": out_trade_no,
            "notify_url": notify_url,
            "return_url": return_url,
            "name": f"{package_name} - {coins} 图币",
            "money": amount,
            "sign_type": "MD5",
        }
        params["sign"] = linuxdo_epay_sign(params, key)
        payment_url = f"{config.linuxdo_pay_submit_url}?{urlencode(params)}"
        now = _now_iso()
        item = {
            "id": secrets.token_hex(12),
            "provider": "linuxdo",
            "out_trade_no": out_trade_no,
            "status": "pending",
            "user_id": _clean(user.get("id")),
            "user_email": _clean(user.get("email")),
            "package_id": _clean(package.get("id")),
            "package_name": package_name,
            "amount": amount,
            "coins": coins,
            "payment_url": payment_url,
            "created_at": now,
            "updated_at": now,
            "paid_at": None,
            "client_ip": _clean(client_ip) or None,
            "provider_trade_no": None,
            "notify_count": 0,
            "last_notify": None,
        }
        with self._lock:
            self._items.append(item)
            self._save()
        return _public_order(item, include_payment_url=True)

    def handle_linuxdo_notify(self, params: dict[str, object]) -> dict[str, object]:
        key = config.linuxdo_pay_key
        if not key:
            raise ValueError("linuxdo pay not configured")
        provided_sign = _clean(params.get("sign")).lower()
        expected_sign = linuxdo_epay_sign(params, key)
        if not provided_sign or not hmac.compare_digest(provided_sign, expected_sign):
            raise ValueError("invalid sign")

        out_trade_no = _clean(params.get("out_trade_no"))
        if not out_trade_no:
            raise ValueError("out_trade_no is required")
        notify_money = _money_text(params.get("money"))
        status_value = _clean(params.get("trade_status") or params.get("status")).upper()
        is_success = status_value in LINUXDO_SUCCESS_STATUSES
        now = _now_iso()

        with self._lock:
            for index, item in enumerate(self._items):
                if _clean(item.get("out_trade_no")) != out_trade_no:
                    continue
                next_item = dict(item)
                next_item["notify_count"] = int(next_item.get("notify_count") or 0) + 1
                next_item["last_notify"] = {
                    key_name: str(value)[:500]
                    for key_name, value in params.items()
                    if key_name != "sign"
                }
                next_item["updated_at"] = now

                if _money_text(next_item.get("amount")) != notify_money:
                    self._items[index] = next_item
                    self._save()
                    raise ValueError("money mismatch")

                if next_item.get("status") == "paid":
                    self._items[index] = next_item
                    self._save()
                    return _public_order(next_item)

                if not is_success:
                    next_item["status"] = "failed"
                    self._items[index] = next_item
                    self._save()
                    return _public_order(next_item)

                coins = _coerce_positive_int(next_item.get("coins"))
                self.auth.add_paid_coins(_clean(next_item.get("user_id")), coins)
                next_item["status"] = "paid"
                next_item["paid_at"] = now
                next_item["provider_trade_no"] = _clean(params.get("trade_no")) or _clean(params.get("transaction_id")) or None
                self._items[index] = next_item
                self._save()
                return _public_order(next_item)

        raise ValueError("order not found")


payment_service = PaymentService()
