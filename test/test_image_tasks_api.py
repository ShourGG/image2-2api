from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.image_tasks as image_tasks_module


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}


class FakeImageTaskService:
    def __init__(self):
        self.generation_calls = []
        self.edit_calls = []

    def submit_generation(self, identity, **kwargs):
        self.generation_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "success",
            "mode": "generate",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
            "data": [{"url": f"{kwargs['base_url']}/images/fake.png"}],
        }

    def submit_edit(self, identity, **kwargs):
        self.edit_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "queued",
            "mode": "edit",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
        }

    def submit_generation_batch(self, identity, **kwargs):
        items = [
            self.submit_generation(
                identity,
                client_task_id=task_id,
                prompt=kwargs["prompt"],
                model=kwargs["model"],
                size=kwargs.get("size"),
                base_url=kwargs["base_url"],
                quality=kwargs.get("quality"),
                generation_mode=kwargs.get("generation_mode"),
            )
            for task_id in kwargs["client_task_ids"]
        ]
        return {"items": items}

    def submit_edit_batch(self, identity, **kwargs):
        items = [
            self.submit_edit(
                identity,
                client_task_id=task_id,
                prompt=kwargs["prompt"],
                model=kwargs["model"],
                size=kwargs.get("size"),
                base_url=kwargs["base_url"],
                images=kwargs["images"],
                quality=kwargs.get("quality"),
                generation_mode=kwargs.get("generation_mode"),
            )
            for task_id in kwargs["client_task_ids"]
        ]
        return {"items": items}

    def list_tasks(self, _identity, ids):
        return {
            "items": [
                {
                    "id": task_id,
                    "status": "success",
                    "mode": "generate",
                    "created_at": "2026-01-01 00:00:00",
                    "updated_at": "2026-01-01 00:00:00",
                    "data": [{"url": "http://testserver/images/fake.png"}],
                }
                for task_id in ids
                if task_id != "missing"
            ],
            "missing_ids": [task_id for task_id in ids if task_id == "missing"],
        }


class ImageTasksApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_service = FakeImageTaskService()
        self.service_patcher = mock.patch.object(image_tasks_module, "image_task_service", self.fake_service)
        self.service_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        app = FastAPI()
        app.include_router(image_tasks_module.create_router())
        self.client = TestClient(app)

    def test_create_generation_task(self):
        response = self.client.post(
            "/api/image-tasks/generations",
            headers=AUTH_HEADERS,
            json={"client_task_id": "task-1", "prompt": "cat", "model": "gpt-image-2", "quality": "xhigh"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["id"], "task-1")
        self.assertEqual(payload["status"], "success")
        self.assertEqual(len(self.fake_service.generation_calls), 1)
        self.assertEqual(self.fake_service.generation_calls[0][1]["quality"], "xhigh")

    def test_create_edit_task_accepts_multiple_images(self):
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={"client_task_id": "edit-1", "prompt": "edit", "model": "gpt-image-2", "quality": "xhigh"},
            files=[
                ("image", ("one.png", b"one", "image/png")),
                ("image", ("two.png", b"two", "image/png")),
            ],
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "edit-1")
        self.assertEqual(len(self.fake_service.edit_calls), 1)
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(len(images), 2)
        self.assertEqual(self.fake_service.edit_calls[0][1]["quality"], "xhigh")

    def test_create_generation_task_batch(self):
        response = self.client.post(
            "/api/image-tasks/generations/batch",
            headers=AUTH_HEADERS,
            json={
                "client_task_ids": ["task-1", "task-2"],
                "prompt": "cat",
                "model": "gpt-image-2",
                "quality": "high",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["items"]], ["task-1", "task-2"])
        self.assertEqual(len(self.fake_service.generation_calls), 2)
        self.assertEqual(self.fake_service.generation_calls[1][1]["quality"], "high")

    def test_create_edit_task_batch_accepts_json_task_ids(self):
        response = self.client.post(
            "/api/image-tasks/edits/batch",
            headers=AUTH_HEADERS,
            data={
                "client_task_ids": "[\"edit-1\",\"edit-2\"]",
                "prompt": "edit",
                "model": "gpt-image-2",
                "quality": "xhigh",
            },
            files=[
                ("image", ("one.png", b"one", "image/png")),
                ("image", ("two.png", b"two", "image/png")),
            ],
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["items"]], ["edit-1", "edit-2"])
        self.assertEqual(len(self.fake_service.edit_calls), 2)
        self.assertEqual(len(self.fake_service.edit_calls[0][1]["images"]), 2)

    def test_list_tasks_reports_missing_ids(self):
        response = self.client.get("/api/image-tasks?ids=task-1,missing", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["items"]], ["task-1"])
        self.assertEqual(payload["missing_ids"], ["missing"])


if __name__ == "__main__":
    unittest.main()
