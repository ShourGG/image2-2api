from __future__ import annotations

import json
import unittest

import requests

from services.protocol import openai_v1_models
from test.http_test_utils import AUTH_KEY, BASE_URL, requires_http_server


class ModelListTests(unittest.TestCase):
    def test_list_models_function(self):
        """测试直接调用服务层获取模型列表。"""
        try:
            result = openai_v1_models.list_models()
        except RuntimeError as exc:
            if "status=401" in str(exc):
                self.skipTest("anon model listing is temporarily unauthorized upstream")
            raise
        print("function result:")
        print(json.dumps(result, ensure_ascii=False, indent=2))

    @requires_http_server
    def test_list_models_http(self):
        """测试通过 HTTP 接口获取模型列表。"""
        response = requests.get(
            f"{BASE_URL}/v1/models",
            headers={"Authorization": f"Bearer {AUTH_KEY}"},
            timeout=30,
        )
        print("http status:")
        print(response.status_code)
        print("http result:")
        print(json.dumps(response.json(), ensure_ascii=False, indent=2))
