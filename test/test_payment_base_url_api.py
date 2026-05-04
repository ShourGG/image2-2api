from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.payments as payments_module


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}


class FakePaymentService:
    def __init__(self):
        self.create_calls = []

    def create_linuxdo_order(self, **kwargs):
        self.create_calls.append(kwargs)
        return {"id": "pay123", "payment_url": "https://pay.example/pay123"}

    def linuxdo_public_config(self):
        return {"enabled": True}

    def list_orders(self, identity):
        return []


class PaymentBaseUrlApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_service = FakePaymentService()
        self.service_patcher = mock.patch.object(payments_module, "payment_service", self.fake_service)
        self.service_patcher.start()
        self.addCleanup(self.service_patcher.stop)

        self.config_patcher = mock.patch(
            "api.support.config",
            SimpleNamespace(auth_key="chatgpt2api", base_url="https://image.shour.fun"),
        )
        self.config_patcher.start()
        self.addCleanup(self.config_patcher.stop)

        app = FastAPI()
        app.include_router(payments_module.create_router())
        self.client = TestClient(app)

    def test_create_order_ignores_spoofed_host_when_base_url_configured(self):
        response = self.client.post(
            "/api/payments/linuxdo/orders",
            headers={**AUTH_HEADERS, "Host": "evil.example", "X-Forwarded-Host": "evil.example"},
            json={"package_id": "pkg_1"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.fake_service.create_calls), 1)
        call = self.fake_service.create_calls[0]
        self.assertEqual(call["notify_url"], "https://image.shour.fun/api/payments/linuxdo/notify")
        self.assertEqual(call["return_url"], "https://image.shour.fun/account")

    def test_create_order_rejects_unconfigured_external_host(self):
        with mock.patch(
            "api.support.config",
            SimpleNamespace(auth_key="chatgpt2api", base_url=""),
        ):
            response = self.client.post(
                "/api/payments/linuxdo/orders",
                headers={**AUTH_HEADERS, "Host": "evil.example"},
                json={"package_id": "pkg_1"},
            )

        self.assertEqual(response.status_code, 500, response.text)
        self.assertEqual(self.fake_service.create_calls, [])
        self.assertIn("base_url 未配置", response.json()["detail"]["error"])


if __name__ == "__main__":
    unittest.main()
