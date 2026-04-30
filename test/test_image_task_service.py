from __future__ import annotations

import json
import threading
import tempfile
import time
import unittest
from pathlib import Path

from services.image_task_service import ImageTaskService


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER_OWNER = {"id": "owner-2", "name": "Other", "role": "user"}


def wait_for_task(service: ImageTaskService, identity: dict[str, object], task_id: str, status: str, timeout: float = 2.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        result = service.list_tasks(identity, [task_id])
        last = (result.get("items") or [None])[0]
        if last and last.get("status") == status:
            return last
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach {status}, last={last}")


class ImageTaskServiceTests(unittest.TestCase):
    def make_service(self, path: Path, handler=None, log_writer=None) -> ImageTaskService:
        return ImageTaskService(
            path,
            generation_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/image.png"}]}),
            edit_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/edit.png"}]}),
            retention_days_getter=lambda: 30,
            log_writer=log_writer or (lambda _summary, _detail: None),
        )

    def test_duplicate_submit_uses_existing_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                time.sleep(0.05)
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            first = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            second = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            self.assertEqual(first["id"], "task-1")
            self.assertEqual(second["id"], "task-1")
            task = wait_for_task(service, OWNER, "task-1", "success")
            self.assertEqual(task["data"][0]["url"], "http://example.test/image.png")
            self.assertEqual(calls, 1)

    def test_different_owner_cannot_query_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            service.submit_generation(
                OWNER,
                client_task_id="private-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            wait_for_task(service, OWNER, "private-task", "success")
            result = service.list_tasks(OTHER_OWNER, ["private-task"])

            self.assertEqual(result["items"], [])
            self.assertEqual(result["missing_ids"], ["private-task"])

    def test_success_task_persists_to_new_service_instance(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path)
            service.submit_generation(
                OWNER,
                client_task_id="persisted-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "persisted-task", "success")

            reloaded = self.make_service(path)
            result = reloaded.list_tasks(OWNER, ["persisted-task"])

            self.assertEqual(result["missing_ids"], [])
            self.assertEqual(result["items"][0]["status"], "success")
            self.assertEqual(result["items"][0]["data"][0]["url"], "http://example.test/image.png")

    def test_completed_task_writes_call_log(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            logs = []
            service = self.make_service(Path(tmp_dir) / "image_tasks.json", log_writer=lambda summary, detail: logs.append((summary, detail)))
            service.submit_generation(
                OWNER,
                client_task_id="logged-task",
                prompt="cat",
                model="gpt-image-2",
                size="1:1",
                quality="xhigh",
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "logged-task", "success")

            self.assertEqual(len(logs), 1)
            summary, detail = logs[0]
            self.assertEqual(summary, "文生图任务完成")
            self.assertEqual(detail["key_id"], OWNER["id"])
            self.assertEqual(detail["task_id"], "logged-task")
            self.assertEqual(detail["status"], "success")
            self.assertEqual(detail["quality"], "xhigh")
            self.assertEqual(detail["urls"], ["http://example.test/image.png"])

    def test_task_stays_queued_until_handler_marks_started(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            started = threading.Event()
            release = threading.Event()

            def handler(payload):
                callback = payload.get("_task_on_start")
                time.sleep(0.05)
                if callable(callback):
                    callback()
                started.set()
                release.wait(1.0)
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            task = service.submit_generation(
                OWNER,
                client_task_id="queued-then-running",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            self.assertEqual(task["status"], "queued")
            self.assertTrue(started.wait(0.5))
            running = wait_for_task(service, OWNER, "queued-then-running", "running")
            self.assertEqual(running["status"], "running")

            release.set()
            success = wait_for_task(service, OWNER, "queued-then-running", "success")
            self.assertEqual(success["status"], "success")

    def test_paid_queued_tasks_include_queue_position_and_eta(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            allow_start = threading.Event()
            allow_finish = threading.Event()

            def handler(payload):
                callback = payload.get("_task_on_start")
                allow_start.wait(1.0)
                if callable(callback):
                    callback()
                allow_finish.wait(1.0)
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            first = service.submit_generation(
                OWNER,
                client_task_id="paid-queue-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
                generation_mode="paid",
            )
            second = service.submit_generation(
                OWNER,
                client_task_id="paid-queue-2",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
                generation_mode="paid",
            )

            self.assertEqual(first["status"], "queued")
            self.assertEqual(second["status"], "queued")

            result = service.list_tasks(OWNER, ["paid-queue-1", "paid-queue-2"])
            items = {item["id"]: item for item in result["items"]}
            self.assertEqual(items["paid-queue-1"]["queue_position"], 1)
            self.assertEqual(items["paid-queue-1"]["queue_ahead"], 0)
            self.assertEqual(items["paid-queue-1"]["queue_total"], 2)
            self.assertGreaterEqual(items["paid-queue-1"]["estimated_wait_seconds"], 1)
            self.assertEqual(items["paid-queue-2"]["queue_position"], 2)
            self.assertEqual(items["paid-queue-2"]["queue_ahead"], 1)
            self.assertEqual(items["paid-queue-2"]["queue_total"], 2)
            self.assertGreaterEqual(items["paid-queue-2"]["estimated_wait_seconds"], 1)

            allow_start.set()
            allow_finish.set()
            wait_for_task(service, OWNER, "paid-queue-1", "success")
            wait_for_task(service, OWNER, "paid-queue-2", "success")

    def test_startup_marks_unfinished_tasks_as_error(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "queued-task",
                                "owner_id": "owner-1",
                                "status": "queued",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            },
                            {
                                "id": "running-task",
                                "owner_id": "owner-1",
                                "status": "running",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )

            service = self.make_service(path)
            result = service.list_tasks(OWNER, ["queued-task", "running-task"])

            self.assertEqual([item["status"] for item in result["items"]], ["error", "error"])
            self.assertTrue(all("已中断" in item.get("error", "") for item in result["items"]))


if __name__ == "__main__":
    unittest.main()
