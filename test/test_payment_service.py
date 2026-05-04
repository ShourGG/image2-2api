from __future__ import annotations

import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest import mock

os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"

import services.payment_service as payment_module
from services.payment_service import PaymentService, linuxdo_epay_sign


class _FakeAuthService:
    def __init__(self):
        self.credited: list[tuple[str, int]] = []

    def add_paid_coins(self, user_id: str, amount: object):
        self.credited.append((user_id, int(amount)))
        return {"id": user_id, "paid_coins": int(amount)}


class LinuxDoPaymentServiceTests(unittest.TestCase):
    def _config(self):
        return SimpleNamespace(
            linuxdo_pay_enabled=True,
            linuxdo_pay_pid="pid_123",
            linuxdo_pay_key="secret_123",
            linuxdo_pay_type="epay",
            linuxdo_pay_sitename="shour生成图",
            linuxdo_pay_submit_url="https://credit.linux.do/epay/pay/submit.php",
            linuxdo_pay_packages=[
                {
                    "id": "coin_1",
                    "name": "体验充值",
                    "amount": "1.00",
                    "coins": 100,
                    "description": "",
                    "enabled": True,
                }
            ],
        )

    def test_create_order_signs_payment_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir, mock.patch.object(payment_module, "config", self._config()):
            service = PaymentService(Path(tmp_dir) / "payments.json", auth=_FakeAuthService())
            item = service.create_linuxdo_order(
                user={"id": "u1", "role": "user", "email": "u@example.com"},
                package_id="coin_1",
                notify_url="https://image.shour.fun/api/payments/linuxdo/notify",
                return_url="https://image.shour.fun/account",
            )

            parsed = urlsplit(str(item["payment_url"]))
            params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
            self.assertEqual(params["pid"], "pid_123")
            self.assertEqual(params["money"], "1.00")
            self.assertEqual(params["sign"], linuxdo_epay_sign(params, "secret_123"))

    def test_notify_is_idempotent_and_credits_once(self) -> None:
        fake_auth = _FakeAuthService()
        with tempfile.TemporaryDirectory() as tmp_dir, mock.patch.object(payment_module, "config", self._config()):
            service = PaymentService(Path(tmp_dir) / "payments.json", auth=fake_auth)
            item = service.create_linuxdo_order(
                user={"id": "u1", "role": "user", "email": "u@example.com"},
                package_id="coin_1",
                notify_url="https://image.shour.fun/api/payments/linuxdo/notify",
                return_url="https://image.shour.fun/account",
            )
            params = {
                "pid": "pid_123",
                "trade_no": "T123",
                "out_trade_no": item["out_trade_no"],
                "type": "epay",
                "name": "体验充值",
                "money": "1.00",
                "trade_status": "TRADE_SUCCESS",
                "sign_type": "MD5",
            }
            params["sign"] = linuxdo_epay_sign(params, "secret_123")

            first = service.handle_linuxdo_notify(params)
            second = service.handle_linuxdo_notify(params)

            self.assertEqual(first["status"], "paid")
            self.assertEqual(second["status"], "paid")
            self.assertEqual(fake_auth.credited, [("u1", 100)])

    def test_notify_rejects_bad_sign(self) -> None:
        fake_auth = _FakeAuthService()
        with tempfile.TemporaryDirectory() as tmp_dir, mock.patch.object(payment_module, "config", self._config()):
            service = PaymentService(Path(tmp_dir) / "payments.json", auth=fake_auth)
            params = {
                "pid": "pid_123",
                "out_trade_no": "missing",
                "money": "1.00",
                "trade_status": "TRADE_SUCCESS",
                "sign": "bad",
            }

            with self.assertRaises(ValueError):
                service.handle_linuxdo_notify(params)
            self.assertEqual(fake_auth.credited, [])


if __name__ == "__main__":
    unittest.main()
