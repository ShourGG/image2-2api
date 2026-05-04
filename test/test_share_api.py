from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest import mock

os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.shares as shares_module


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}


class FakeShareService:
    def __init__(self):
        self.create_calls = []
        self.items = {
            "shr123": {
                "id": "shr123",
                "image_url": "http://testserver/images/fake.png",
                "prompt": "cat",
                "revised_prompt": "cat revised",
                "model": "gpt-image-2",
                "size": "1024x1024",
                "quality": "high",
                "result": 1,
                "created_at": "2026-01-01T00:00:00Z",
                "shared_at": "2026-01-01T00:00:10Z",
            }
        }

    def create_share(self, identity, **kwargs):
        self.create_calls.append((identity, kwargs))
        return dict(self.items["shr123"])

    def get_share(self, share_id: str):
        return dict(self.items[share_id]) if share_id in self.items else None


class ShareApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_service = FakeShareService()
        self.service_patcher = mock.patch.object(shares_module, "share_service", self.fake_service)
        self.service_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        self.config_patcher = mock.patch(
            "api.support.config",
            SimpleNamespace(auth_key="chatgpt2api", base_url="https://image.shour.fun"),
        )
        self.config_patcher.start()
        self.addCleanup(self.config_patcher.stop)
        app = FastAPI()
        app.include_router(shares_module.create_router())
        self.client = TestClient(app)

    def test_create_share_returns_short_url(self):
        response = self.client.post(
            "/api/shares",
            headers=AUTH_HEADERS,
            json={
                "image_url": "http://testserver/images/fake.png",
                "prompt": "cat",
                "revised_prompt": "cat revised",
                "model": "gpt-image-2",
                "size": "1024x1024",
                "quality": "high",
                "result": 1,
                "created_at": "2026-01-01T00:00:00Z",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["item"]["id"], "shr123")
        self.assertTrue(str(payload["share_url"]).endswith("/share/?id=shr123"))
        self.assertEqual(len(self.fake_service.create_calls), 1)
        self.assertEqual(self.fake_service.create_calls[0][1]["base_url"], "https://image.shour.fun")

    def test_create_share_ignores_spoofed_host_when_base_url_configured(self):
        response = self.client.post(
            "/api/shares",
            headers={**AUTH_HEADERS, "Host": "evil.example"},
            json={
                "image_url": "https://image.shour.fun/images/fake.png",
                "prompt": "cat",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["share_url"], "https://image.shour.fun/share/?id=shr123")
        self.assertEqual(self.fake_service.create_calls[-1][1]["base_url"], "https://image.shour.fun")

    def test_get_share_is_public(self):
        response = self.client.get("/api/shares/shr123")

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["item"]["id"], "shr123")
        self.assertEqual(payload["item"]["image_url"], "http://testserver/images/fake.png")

    def test_get_share_returns_404_when_missing(self):
        response = self.client.get("/api/shares/missing")

        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["detail"]["error"], "share not found")


if __name__ == "__main__":
    unittest.main()
