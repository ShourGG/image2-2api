import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.system as system_module
from services.protocol.conversation import ImageOutput


class _FakeResponse:
    def __init__(self, status_code, payload, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.text = str(payload)

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.urls = []

    def get(self, url, **_kwargs):
        self.urls.append(url)
        if not self.responses:
            raise AssertionError(f"unexpected GET {url}")
        return self.responses.pop(0)

    def close(self):
        return None


class OpenAICompatibleUsageTests(unittest.TestCase):
    def test_falls_back_to_new_api_token_usage_when_v1_usage_is_missing(self):
        fake_session = _FakeSession(
            [
                _FakeResponse(
                    404,
                    {"error": {"message": "Invalid URL (GET /v1/usage)"}},
                    {"X-New-Api-Version": "v1.0.0-rc.1"},
                ),
                _FakeResponse(
                    200,
                    {
                        "success": True,
                        "data": {
                            "total_available": 250000,
                            "total_used": 125000,
                            "total_granted": 375000,
                        },
                    },
                    {"X-New-Api-Version": "v1.0.0-rc.1"},
                ),
            ]
        )

        with mock.patch.object(system_module, "Session", return_value=fake_session):
            result = system_module._query_openai_compatible_usage(
                {"base_url": "http://newapi.example:3000", "api_key": "sk-test"}
            )

        self.assertEqual(
            fake_session.urls,
            [
                "http://newapi.example:3000/v1/usage",
                "http://newapi.example:3000/api/usage/token/",
            ],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["usage"]["remaining"], 0.5)
        self.assertEqual(result["usage"]["quota"]["used"], 0.25)
        self.assertEqual(result["usage"]["quota"]["limit"], 0.75)


class ImageUpstreamGenerationTestApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = FastAPI()
        self.app.include_router(system_module.create_router("1.0.0"))
        self.client = TestClient(self.app)

    def test_generates_test_image_with_selected_upstream(self):
        upstream = {
            "id": "u1",
            "name": "测试上游",
            "base_url": "http://upstream.example",
            "api_key": "sk-test",
            "model": "gpt-image-2",
            "enabled": True,
            "max_concurrency": 3,
        }
        calls = []

        def fake_outputs(request, index, total, selected_upstream):
            calls.append((request, index, total, selected_upstream))
            yield ImageOutput(kind="progress", model=request.model, index=index, total=total)
            yield ImageOutput(
                kind="result",
                model=request.model,
                index=index,
                total=total,
                data=[{"url": "http://testserver/images/test.png", "revised_prompt": request.prompt}],
            )

        fake_config = SimpleNamespace(
            image_generation_api_model="gpt-image-2",
            image_generation_api_max_concurrency=8,
            base_url="",
            get_image_generation_api_upstream=lambda upstream_id: upstream if upstream_id == "u1" else None,
        )

        with mock.patch.object(system_module, "require_admin", return_value={"role": "admin"}), mock.patch.object(
            system_module, "config", fake_config
        ), mock.patch.object(system_module, "openai_compatible_image_outputs", side_effect=fake_outputs):
            response = self.client.post(
                "/api/settings/image-upstreams/u1/test-image",
                json={"prompt": "画一个蓝色圆形"},
                headers={"Authorization": "Bearer test"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["result"]["ok"])
        self.assertEqual(payload["result"]["data"][0]["url"], "http://testserver/images/test.png")
        self.assertEqual(calls[0][3], upstream)
        self.assertEqual(calls[0][0].prompt, "画一个蓝色圆形")
        self.assertEqual(calls[0][0].response_format, "url")

    def test_uses_default_prompt_when_prompt_is_blank(self):
        upstream = {
            "id": "u1",
            "name": "测试上游",
            "base_url": "http://upstream.example",
            "api_key": "sk-test",
            "model": "gpt-image-2",
            "enabled": True,
            "max_concurrency": 3,
        }
        calls = []

        def fake_outputs(request, index, total, selected_upstream):
            calls.append(request)
            yield ImageOutput(
                kind="result",
                model=request.model,
                index=index,
                total=total,
                data=[{"url": "http://testserver/images/default.png"}],
            )

        fake_config = SimpleNamespace(
            image_generation_api_model="gpt-image-2",
            image_generation_api_max_concurrency=8,
            base_url="",
            get_image_generation_api_upstream=lambda upstream_id: upstream if upstream_id == "u1" else None,
        )

        with mock.patch.object(system_module, "require_admin", return_value={"role": "admin"}), mock.patch.object(
            system_module, "config", fake_config
        ), mock.patch.object(system_module, "openai_compatible_image_outputs", side_effect=fake_outputs):
            response = self.client.post(
                "/api/settings/image-upstreams/u1/test-image",
                json={"prompt": "   "},
                headers={"Authorization": "Bearer test"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["result"]["ok"])
        self.assertEqual(response.json()["result"]["prompt"], system_module.DEFAULT_IMAGE_UPSTREAM_TEST_PROMPT)
        self.assertEqual(calls[0].prompt, system_module.DEFAULT_IMAGE_UPSTREAM_TEST_PROMPT)


if __name__ == "__main__":
    unittest.main()
