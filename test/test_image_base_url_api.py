import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import api.support as api_support


class ImageBaseUrlApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fake_config = SimpleNamespace(base_url="https://public.example.com")
        patcher = mock.patch.object(api_support, "config", self.fake_config)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_prefers_configured_base_url(self) -> None:
        request = SimpleNamespace(
            url=SimpleNamespace(scheme="http", netloc="127.0.0.1:8000"),
            headers={"host": "127.0.0.1:8000"},
        )

        self.assertEqual(api_support.resolve_image_base_url(request), "https://public.example.com")

    def test_allows_local_request_host_for_development(self) -> None:
        self.fake_config.base_url = ""
        request = SimpleNamespace(
            url=SimpleNamespace(scheme="http", netloc="127.0.0.1:8000"),
            headers={"host": "127.0.0.1:8000"},
        )

        self.assertEqual(api_support.resolve_image_base_url(request), "http://127.0.0.1:8000")

    def test_rejects_unconfigured_external_request_host(self) -> None:
        self.fake_config.base_url = ""
        request = SimpleNamespace(
            url=SimpleNamespace(scheme="https", netloc="public.example.com"),
            headers={"host": "evil.example"},
        )

        with self.assertRaises(HTTPException) as context:
            api_support.resolve_image_base_url(request)

        self.assertEqual(context.exception.status_code, 500)
        self.assertIn("base_url 未配置", context.exception.detail["error"])

    def test_rejects_invalid_configured_base_url(self) -> None:
        self.fake_config.base_url = "javascript:alert(1)"
        request = SimpleNamespace(
            url=SimpleNamespace(scheme="http", netloc="127.0.0.1:8000"),
            headers={"host": "127.0.0.1:8000"},
        )

        with self.assertRaises(HTTPException) as context:
            api_support.resolve_image_base_url(request)

        self.assertEqual(context.exception.status_code, 500)
        self.assertIn("base_url 配置不正确", context.exception.detail["error"])


if __name__ == "__main__":
    unittest.main()
