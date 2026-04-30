from __future__ import annotations

import os
import base64
import json
import threading
import time
import unittest

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.config import config
from services.openai_backend_api import ChatRequirements, OpenAIBackendAPI
from services.protocol import conversation as conversation_module
from services.protocol.conversation import (
    ConversationRequest,
    ImageOutput,
    build_image_prompt,
    collect_image_outputs,
    stream_image_outputs_with_pool,
    uses_codex_image_backend,
)


class ImageGenerationStrategyTests(unittest.TestCase):
    def test_gpt2api_strategy_uses_auto_for_free_accounts(self) -> None:
        old_data = dict(config.data)
        try:
            config.data = {**old_data, "image_generation_strategy": "gpt2api", "image_generation_upstream_model": ""}
            backend = OpenAIBackendAPI(access_token="token")

            slug = backend._image_model_slug(
                "gpt-image-2",
                ChatRequirements(token="chat-token", persona="chatgpt-freeaccount"),
            )

            self.assertEqual(slug, "auto")
        finally:
            config.data = old_data

    def test_default_strategy_keeps_existing_gpt_image_mapping(self) -> None:
        old_data = dict(config.data)
        try:
            config.data = {**old_data, "image_generation_strategy": "chatgpt2api", "image_generation_upstream_model": ""}
            backend = OpenAIBackendAPI(access_token="token")

            slug = backend._image_model_slug(
                "gpt-image-2",
                ChatRequirements(token="chat-token", persona="chatgpt-freeaccount"),
            )

            self.assertEqual(slug, "gpt-5-3")
        finally:
            config.data = old_data

    def test_upstream_model_override_wins_for_all_accounts(self) -> None:
        old_data = dict(config.data)
        try:
            config.data = {
                **old_data,
                "image_generation_strategy": "gpt2api",
                "image_generation_upstream_model": "gpt-5-5",
            }
            backend = OpenAIBackendAPI(access_token="token")

            slug = backend._image_model_slug(
                "gpt-image-2",
                ChatRequirements(token="chat-token", persona="chatgpt-freeaccount"),
            )

            self.assertEqual(slug, "gpt-5-5")
        finally:
            config.data = old_data

    def test_image_reason_hint_can_be_enabled(self) -> None:
        old_data = dict(config.data)
        try:
            config.data = {**old_data, "image_generation_enable_reasoning": True}
            backend = OpenAIBackendAPI(access_token="token")

            self.assertEqual(backend._image_system_hints(), ["picture_v2", "reason"])
        finally:
            config.data = old_data

    def test_high_quality_prompt_adds_finish_quality_hint(self) -> None:
        prompt = build_image_prompt("一只猫", "1:1", "high")

        self.assertIn("1:1", prompt)
        self.assertIn("高清终稿", prompt)
        self.assertIn("避免低清", prompt)

    def test_xhigh_quality_prompt_adds_stronger_finish_quality_hint(self) -> None:
        prompt = build_image_prompt("一只猫", "1:1", "xhigh")

        self.assertIn("1:1", prompt)
        self.assertIn("超高清终稿", prompt)
        self.assertIn("最高完成度", prompt)
        self.assertIn("不要草稿感", prompt)

    def test_standard_quality_does_not_add_high_hint(self) -> None:
        prompt = build_image_prompt("一只猫", None, "standard")

        self.assertEqual(prompt, "一只猫")

    def test_codex_model_alias_uses_codex_backend(self) -> None:
        old_data = dict(config.data)
        try:
            config.data = {**old_data, "image_generation_strategy": "chatgpt2api"}

            self.assertTrue(uses_codex_image_backend("codex-gpt-image-2"))
            self.assertFalse(uses_codex_image_backend("gpt-image-2"))
        finally:
            config.data = old_data

    def test_codex_strategy_routes_gpt_image_2_to_codex_backend(self) -> None:
        old_data = dict(config.data)
        try:
            config.data = {**old_data, "image_generation_strategy": "codex_responses"}

            self.assertTrue(uses_codex_image_backend("gpt-image-2"))
        finally:
            config.data = old_data

    def test_codex_account_id_can_be_decoded_from_access_token(self) -> None:
        payload = {
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct-123",
            }
        }
        encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii").rstrip("=")
        backend = OpenAIBackendAPI(access_token=f"header.{encoded}.signature")

        self.assertEqual(backend._codex_account_id(), "acct-123")

    def test_codex_xhigh_uses_high_tool_quality_and_xhigh_reasoning(self) -> None:
        old_data = dict(config.data)
        try:
            config.data = {**old_data, "image_generation_codex_reasoning_effort": "none"}
            backend = OpenAIBackendAPI(access_token="token")

            self.assertEqual(backend._codex_image_quality("xhigh"), "high")
            self.assertEqual(backend._codex_reasoning_effort("xhigh"), "xhigh")
        finally:
            config.data = old_data

    def test_openai_compatible_queue_respects_single_upstream_concurrency(self) -> None:
        old_data = dict(config.data)
        old_handler = conversation_module.openai_compatible_image_outputs
        old_active_counts = dict(conversation_module._openai_image_active_counts)
        lock = threading.Lock()
        active = 0
        max_seen = 0

        def fake_outputs(_request: ConversationRequest, index: int, total: int, _upstream):
            nonlocal active, max_seen
            with lock:
                active += 1
                max_seen = max(max_seen, active)
            time.sleep(0.15)
            with lock:
                active -= 1
            yield ImageOutput(
                kind="result",
                model="gpt-image-2",
                index=index,
                total=total,
                data=[{"b64_json": "ZmFrZQ==", "revised_prompt": "queued"}],
            )

        try:
            config.data = {
                **old_data,
                "image_generation_strategy": "openai_compatible",
                "image_generation_api_max_concurrency": 8,
                "image_generation_api_upstreams": [
                    {
                        "id": "upstream-1",
                        "name": "上游 1",
                        "base_url": "https://example.com",
                        "api_key": "sk-test",
                        "model": "gpt-image-2",
                        "max_concurrency": 1,
                        "enabled": True,
                    }
                ],
            }
            conversation_module.openai_compatible_image_outputs = fake_outputs
            conversation_module._openai_image_active_counts = {}

            def worker() -> None:
                result = collect_image_outputs(stream_image_outputs_with_pool(ConversationRequest(prompt="cat", model="gpt-image-2")))
                self.assertEqual(len(result["data"]), 1)

            started = time.time()
            threads = [threading.Thread(target=worker) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            elapsed = time.time() - started

            self.assertEqual(max_seen, 1)
            self.assertGreater(elapsed, 0.25)
        finally:
            config.data = old_data
            conversation_module.openai_compatible_image_outputs = old_handler
            conversation_module._openai_image_active_counts = old_active_counts

    def test_openai_compatible_edits_use_multipart_upload(self) -> None:
        old_session = conversation_module.requests.Session
        old_mime = conversation_module.CurlMime
        old_data = dict(config.data)

        captured: dict[str, object] = {}

        class FakeResponse:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "data": [
                        {
                            "b64_json": base64.b64encode(b"fake-image").decode("ascii"),
                            "revised_prompt": "edited",
                        }
                    ]
                }

        class FakeSession:
            def __init__(self, **_kwargs):
                pass

            def post(self, _url, **kwargs):
                captured.update(kwargs)
                return FakeResponse()

            def close(self):
                return None

        class FakeMime:
            def __init__(self):
                self.parts: list[dict[str, object]] = []

            def addpart(self, name, filename=None, content_type=None, data=None):
                self.parts.append(
                    {
                        "name": name,
                        "filename": filename,
                        "content_type": content_type,
                        "data": data,
                    }
                )

            def close(self):
                return None

        try:
            config.data = {
                **old_data,
                "image_generation_strategy": "openai_compatible",
                "image_generation_api_upstreams": [
                    {
                        "id": "upstream-1",
                        "name": "上游 1",
                        "base_url": "https://example.com",
                        "api_key": "sk-test",
                        "model": "gpt-image-2",
                        "max_concurrency": 1,
                        "enabled": True,
                    }
                ],
            }
            conversation_module.requests.Session = FakeSession
            conversation_module.CurlMime = FakeMime

            request = ConversationRequest(
                prompt="edit image",
                model="gpt-image-2",
                images=[base64.b64encode(b"source-image").decode("ascii")],
                response_format="b64_json",
                base_url="https://image.shour.fun",
            )
            result = collect_image_outputs(
                conversation_module.openai_compatible_image_outputs(request, 1, 1, config.image_generation_api_upstreams[0])
            )

            self.assertEqual(len(result["data"]), 1)
            self.assertIn("multipart", captured)
            self.assertIsNotNone(captured.get("multipart"))
            self.assertNotIn("files", captured)
            multipart = captured.get("multipart")
            self.assertIsInstance(multipart, FakeMime)
            self.assertEqual(len(multipart.parts), 1)
            self.assertEqual(multipart.parts[0]["name"], "image")
            self.assertEqual(multipart.parts[0]["content_type"], "image/png")
        finally:
            config.data = old_data
            conversation_module.requests.Session = old_session
            conversation_module.CurlMime = old_mime

    def test_openai_compatible_multi_edits_use_image_array_field_and_preserve_mime(self) -> None:
        old_session = conversation_module.requests.Session
        old_mime = conversation_module.CurlMime
        old_data = dict(config.data)

        captured: dict[str, object] = {}

        class FakeResponse:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "data": [
                        {
                            "b64_json": base64.b64encode(b"fake-image").decode("ascii"),
                            "revised_prompt": "edited",
                        }
                    ]
                }

        class FakeSession:
            def __init__(self, **_kwargs):
                pass

            def post(self, _url, **kwargs):
                captured.update(kwargs)
                return FakeResponse()

            def close(self):
                return None

        class FakeMime:
            def __init__(self):
                self.parts: list[dict[str, object]] = []

            def addpart(self, name, filename=None, content_type=None, data=None):
                self.parts.append(
                    {
                        "name": name,
                        "filename": filename,
                        "content_type": content_type,
                        "data": data,
                    }
                )

            def close(self):
                return None

        try:
            config.data = {
                **old_data,
                "image_generation_strategy": "openai_compatible",
                "image_generation_api_upstreams": [
                    {
                        "id": "upstream-1",
                        "name": "上游 1",
                        "base_url": "https://example.com",
                        "api_key": "sk-test",
                        "model": "gpt-image-2",
                        "max_concurrency": 1,
                        "enabled": True,
                    }
                ],
            }
            conversation_module.requests.Session = FakeSession
            conversation_module.CurlMime = FakeMime

            request = ConversationRequest(
                prompt="edit image",
                model="gpt-image-2",
                images=[
                    "data:image/jpeg;base64," + base64.b64encode(b"jpeg-image").decode("ascii"),
                    "data:image/webp;base64," + base64.b64encode(b"webp-image").decode("ascii"),
                ],
                response_format="b64_json",
                base_url="https://image.shour.fun",
            )
            result = collect_image_outputs(
                conversation_module.openai_compatible_image_outputs(request, 1, 1, config.image_generation_api_upstreams[0])
            )

            self.assertEqual(len(result["data"]), 1)
            multipart = captured.get("multipart")
            self.assertIsInstance(multipart, FakeMime)
            self.assertEqual([part["name"] for part in multipart.parts], ["image[]", "image[]"])
            self.assertEqual([part["content_type"] for part in multipart.parts], ["image/jpeg", "image/webp"])
            self.assertEqual([part["filename"] for part in multipart.parts], ["image_1.jpg", "image_2.webp"])
            self.assertEqual([part["data"] for part in multipart.parts], [b"jpeg-image", b"webp-image"])
        finally:
            config.data = old_data
            conversation_module.requests.Session = old_session
            conversation_module.CurlMime = old_mime


if __name__ == "__main__":
    unittest.main()
