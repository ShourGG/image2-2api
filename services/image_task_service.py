from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from services.config import DATA_DIR, config
from services.image_file_utils import (
    MAX_IMAGE_BATCH_TASKS,
    MAX_IMAGE_PROMPT_LENGTH,
    MAX_IMAGE_TASK_ID_LENGTH,
    MAX_PENDING_IMAGE_TASKS_PER_OWNER,
    MAX_PENDING_IMAGE_TASKS_TOTAL,
)
from services.log_service import LOG_TYPE_CALL, log_service
from services.protocol import openai_v1_image_edit, openai_v1_image_generations

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
TERMINAL_STATUSES = {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}
DEFAULT_QUEUE_WAIT_SECONDS = 45
QUEUE_DURATION_SAMPLE_LIMIT = 20


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:26], fmt).timestamp()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _normalize_quality(value: object) -> str:
    quality = _clean(value).lower()
    return quality if quality in {"high", "xhigh"} else ""


def _normalize_generation_mode(value: object) -> str:
    mode = _clean(value).lower()
    return mode if mode in {"free", "paid"} else ""


def _prompt_preview(value: object, limit: int = 300) -> str:
    text = _clean(value)
    return text if len(text) <= limit else f"{text[:limit]}..."


def _collect_urls(value: object) -> list[str]:
    urls: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "url" and isinstance(item, str):
                urls.append(item)
            else:
                urls.extend(_collect_urls(item))
    elif isinstance(value, list):
        for item in value:
            urls.extend(_collect_urls(item))
    return urls


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _task_key(owner_id: str, task_id: str) -> str:
    return f"{owner_id}:{task_id}"


def _base_public_task(task: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": task.get("id"),
        "status": task.get("status"),
        "mode": task.get("mode"),
        "model": task.get("model"),
        "size": task.get("size"),
        "quality": task.get("quality"),
        "generation_mode": task.get("generation_mode"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }
    if task.get("data") is not None:
        item["data"] = task.get("data")
    if task.get("error"):
        item["error"] = task.get("error")
    return item


class ImageTaskService:
    def __init__(
        self,
        path: Path,
        *,
        generation_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_generations.handle,
        edit_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_edit.handle,
        retention_days_getter: Callable[[], int] | None = None,
        log_writer: Callable[[str, dict[str, Any]], None] | None = None,
    ):
        self.path = path
        self.generation_handler = generation_handler
        self.edit_handler = edit_handler
        self.retention_days_getter = retention_days_getter or (lambda: config.image_retention_days)
        self.log_writer = log_writer or (lambda summary, detail: log_service.add(LOG_TYPE_CALL, summary, detail))
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            changed = self._recover_unfinished_locked()
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked()

    def submit_generation(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        quality: str | None = None,
        generation_mode: str | None = None,
    ) -> dict[str, Any]:
        self._validate_prompt(prompt)
        payload = {
            "prompt": prompt,
            "model": model,
            "n": 1,
            "size": size,
            "quality": _normalize_quality(quality),
            "generation_mode": _normalize_generation_mode(generation_mode),
            "response_format": "url",
            "base_url": base_url,
            "identity": dict(identity),
        }
        return self._submit(identity, client_task_id=client_task_id, mode="generate", payload=payload)

    def submit_generation_batch(
        self,
        identity: dict[str, object],
        *,
        client_task_ids: list[str],
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        quality: str | None = None,
        generation_mode: str | None = None,
    ) -> dict[str, Any]:
        self._validate_batch(client_task_ids)
        self._validate_prompt(prompt)
        items = [
            self.submit_generation(
                identity,
                client_task_id=task_id,
                prompt=prompt,
                model=model,
                size=size,
                base_url=base_url,
                quality=quality,
                generation_mode=generation_mode,
            )
            for task_id in client_task_ids
        ]
        return {"items": items}

    def submit_edit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        images: list[tuple[bytes, str, str]],
        quality: str | None = None,
        generation_mode: str | None = None,
    ) -> dict[str, Any]:
        self._validate_prompt(prompt)
        payload = {
            "prompt": prompt,
            "images": images,
            "model": model,
            "n": 1,
            "size": size,
            "quality": _normalize_quality(quality),
            "generation_mode": _normalize_generation_mode(generation_mode),
            "response_format": "url",
            "base_url": base_url,
            "identity": dict(identity),
        }
        return self._submit(identity, client_task_id=client_task_id, mode="edit", payload=payload)

    def submit_edit_batch(
        self,
        identity: dict[str, object],
        *,
        client_task_ids: list[str],
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        images: list[tuple[bytes, str, str]],
        quality: str | None = None,
        generation_mode: str | None = None,
    ) -> dict[str, Any]:
        self._validate_batch(client_task_ids)
        self._validate_prompt(prompt)
        items = [
            self.submit_edit(
                identity,
                client_task_id=task_id,
                prompt=prompt,
                model=model,
                size=size,
                base_url=base_url,
                images=images,
                quality=quality,
                generation_mode=generation_mode,
            )
            for task_id in client_task_ids
        ]
        return {"items": items}

    def list_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        with self._lock:
            if self._cleanup_locked():
                self._save_locked()
            items = []
            missing_ids = []
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                else:
                    items.append(self._public_task_locked(task))
            if not requested_ids:
                items = [
                    self._public_task_locked(task)
                    for task in self._tasks.values()
                    if task.get("owner_id") == owner
                ]
                items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
                missing_ids = []
            return {"items": items, "missing_ids": missing_ids}

    def _submit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        mode: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _clean(client_task_id)
        if not task_id:
            raise ValueError("client_task_id is required")
        if len(task_id) > MAX_IMAGE_TASK_ID_LENGTH:
            raise ValueError(f"client_task_id is too long, max {MAX_IMAGE_TASK_ID_LENGTH}")
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        now = _now_iso()
        should_start = False
        with self._lock:
            cleaned = self._cleanup_locked()
            task = self._tasks.get(key)
            if task is not None:
                if cleaned:
                    self._save_locked()
                return self._public_task_locked(task)
            self._ensure_task_capacity_locked(owner)
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": TASK_STATUS_QUEUED,
                "mode": mode,
                "model": _clean(payload.get("model"), "gpt-image-2"),
                "size": _clean(payload.get("size")),
                "quality": _normalize_quality(payload.get("quality")),
                "generation_mode": _normalize_generation_mode(payload.get("generation_mode")),
                "created_at": now,
                "updated_at": now,
            }
            self._tasks[key] = task
            self._save_locked()
            public_task = self._public_task_locked(task)
            should_start = True

        if should_start:
            thread = threading.Thread(
                target=self._run_task,
                args=(key, mode, payload),
                name=f"image-task-{task_id[:16]}",
                daemon=True,
            )
            thread.start()
        return public_task

    def _validate_prompt(self, prompt: str) -> None:
        if not _clean(prompt):
            raise ValueError("prompt is required")
        if len(str(prompt or "")) > MAX_IMAGE_PROMPT_LENGTH:
            raise ValueError(f"prompt is too long, max {MAX_IMAGE_PROMPT_LENGTH}")

    def _validate_batch(self, client_task_ids: list[str]) -> None:
        task_ids = [_clean(task_id) for task_id in client_task_ids if _clean(task_id)]
        if not task_ids:
            raise ValueError("client_task_ids is required")
        if len(task_ids) > MAX_IMAGE_BATCH_TASKS:
            raise ValueError(f"too many image tasks, max {MAX_IMAGE_BATCH_TASKS}")
        if any(len(task_id) > MAX_IMAGE_TASK_ID_LENGTH for task_id in task_ids):
            raise ValueError(f"client_task_id is too long, max {MAX_IMAGE_TASK_ID_LENGTH}")

    def _ensure_task_capacity_locked(self, owner: str) -> None:
        unfinished = [
            task
            for task in self._tasks.values()
            if task.get("status") in UNFINISHED_STATUSES
        ]
        if len(unfinished) >= MAX_PENDING_IMAGE_TASKS_TOTAL:
            raise ValueError("too many pending image tasks, please retry later")
        owner_unfinished = sum(1 for task in unfinished if task.get("owner_id") == owner)
        if owner_unfinished >= MAX_PENDING_IMAGE_TASKS_PER_OWNER:
            raise ValueError("too many pending image tasks for this account")

    def _run_task(self, key: str, mode: str, payload: dict[str, Any]) -> None:
        started = time.time()
        status = "success"
        error = ""
        data: list[Any] = []
        task_started = False
        task_started_at = 0.0

        def mark_running() -> None:
            nonlocal task_started, task_started_at
            if task_started:
                return
            task_started = True
            task_started_at = time.time()
            self._update_task(key, status=TASK_STATUS_RUNNING, error="", started_at=_now_iso())

        task_payload = dict(payload)
        task_payload["_task_on_start"] = mark_running
        try:
            handler = self.edit_handler if mode == "edit" else self.generation_handler
            result = handler(task_payload)
            if not isinstance(result, dict):
                raise RuntimeError("image task returned streaming result unexpectedly")
            raw_data = result.get("data")
            data = raw_data if isinstance(raw_data, list) else []
            if not isinstance(data, list) or not data:
                message = _clean(result.get("message")) or "image task returned no image data"
                raise RuntimeError(message)
            if not task_started:
                mark_running()
            self._update_task(
                key,
                status=TASK_STATUS_SUCCESS,
                data=data,
                error="",
                duration_ms=self._task_duration_ms(task_started_at),
            )
        except Exception as exc:
            status = "failed"
            error = str(exc) or "image task failed"
            self._update_task(
                key,
                status=TASK_STATUS_ERROR,
                error=error,
                data=[],
                duration_ms=self._task_duration_ms(task_started_at),
            )
        finally:
            self._log_task_result(key, mode, payload, started, status=status, error=error, data=data)

    def _log_task_result(
        self,
        key: str,
        mode: str,
        payload: dict[str, Any],
        started: float,
        *,
        status: str,
        error: str,
        data: list[Any],
    ) -> None:
        identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
        task_id = key.split(":", 1)[1] if ":" in key else key
        summary_prefix = "图生图" if mode == "edit" else "文生图"
        ended = time.time()
        detail: dict[str, Any] = {
            "key_id": identity.get("id"),
            "key_name": identity.get("name") or identity.get("email"),
            "role": identity.get("role"),
            "endpoint": "/api/image-tasks/edits" if mode == "edit" else "/api/image-tasks/generations",
            "task_id": task_id,
            "mode": mode,
            "model": _clean(payload.get("model"), "gpt-image-2"),
            "size": _clean(payload.get("size")) or "-",
            "quality": _normalize_quality(payload.get("quality")) or "-",
            "generation_mode": _normalize_generation_mode(payload.get("generation_mode")) or "-",
            "prompt": _prompt_preview(payload.get("prompt")),
            "started_at": datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": datetime.fromtimestamp(ended).strftime("%Y-%m-%d %H:%M:%S"),
            "duration_ms": int((ended - started) * 1000),
            "status": status,
        }
        if error:
            detail["error"] = error
        urls = _collect_urls(data)
        if urls:
            detail["urls"] = list(dict.fromkeys(urls))
        try:
            self.log_writer(f"{summary_prefix}任务{'完成' if status == 'success' else '失败'}", detail)
        except Exception:
            pass

    def _update_task(self, key: str, **updates: Any) -> None:
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                return
            task.update(updates)
            task["updated_at"] = _now_iso()
            self._save_locked()

    def _task_duration_ms(self, started_at: float) -> int:
        if started_at <= 0:
            return 0
        return max(0, int((time.time() - started_at) * 1000))

    def _public_task_locked(self, task: dict[str, Any]) -> dict[str, Any]:
        item = _base_public_task(task)
        item.update(self._queue_meta_locked(task))
        return item

    def _queue_meta_locked(self, task: dict[str, Any]) -> dict[str, Any]:
        if task.get("status") != TASK_STATUS_QUEUED or task.get("generation_mode") != "paid":
            return {}

        queued_tasks = sorted(
            (
                queued_task
                for queued_task in self._tasks.values()
                if queued_task.get("status") == TASK_STATUS_QUEUED and queued_task.get("generation_mode") == "paid"
            ),
            key=lambda item: _timestamp(item.get("created_at")),
        )
        queue_total = len(queued_tasks)
        queue_position = next(
            (index for index, queued_task in enumerate(queued_tasks, start=1) if queued_task is task),
            0,
        )
        if queue_position <= 0:
            return {}

        queue_ahead = queue_position - 1
        batch_index = queue_ahead // max(1, config.image_generation_api_total_max_concurrency) + 1
        estimated_wait_seconds = max(1, int(round(batch_index * self._average_paid_task_duration_seconds_locked())))
        return {
            "queue_position": queue_position,
            "queue_ahead": queue_ahead,
            "queue_total": queue_total,
            "estimated_wait_seconds": estimated_wait_seconds,
        }

    def _average_paid_task_duration_seconds_locked(self) -> float:
        samples = sorted(
            (
                task
                for task in self._tasks.values()
                if task.get("generation_mode") == "paid"
                and task.get("status") in TERMINAL_STATUSES
                and int(task.get("duration_ms") or 0) > 0
            ),
            key=lambda item: _timestamp(item.get("updated_at")),
            reverse=True,
        )
        durations = [
            int(task.get("duration_ms") or 0) / 1000
            for task in samples[:QUEUE_DURATION_SAMPLE_LIMIT]
            if int(task.get("duration_ms") or 0) > 0
        ]
        if not durations:
            return float(DEFAULT_QUEUE_WAIT_SECONDS)
        return max(1.0, sum(durations) / len(durations))

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        raw_items = raw.get("tasks") if isinstance(raw, dict) else raw
        if not isinstance(raw_items, list):
            return {}
        tasks: dict[str, dict[str, Any]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            task_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not task_id or not owner:
                continue
            status = _clean(item.get("status"))
            if status not in {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING, TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}:
                status = TASK_STATUS_ERROR
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": status,
                "mode": "edit" if item.get("mode") == "edit" else "generate",
                "model": _clean(item.get("model"), "gpt-image-2"),
                "size": _clean(item.get("size")),
                "quality": _normalize_quality(item.get("quality")),
                "generation_mode": _normalize_generation_mode(item.get("generation_mode")),
                "created_at": _clean(item.get("created_at"), _now_iso()),
                "updated_at": _clean(item.get("updated_at"), _clean(item.get("created_at"), _now_iso())),
            }
            started_at = _clean(item.get("started_at"))
            if started_at:
                task["started_at"] = started_at
            try:
                duration_ms = int(item.get("duration_ms") or 0)
            except (TypeError, ValueError):
                duration_ms = 0
            if duration_ms > 0:
                task["duration_ms"] = duration_ms
            data = item.get("data")
            if isinstance(data, list):
                task["data"] = data
            error = _clean(item.get("error"))
            if error:
                task["error"] = error
            tasks[_task_key(owner, task_id)] = task
        return tasks

    def _save_locked(self) -> None:
        items = sorted(self._tasks.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps({"tasks": items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(self.path)

    def _recover_unfinished_locked(self) -> bool:
        changed = False
        for task in self._tasks.values():
            if task.get("status") in UNFINISHED_STATUSES:
                task["status"] = TASK_STATUS_ERROR
                task["error"] = "服务已重启，未完成的图片任务已中断"
                task["updated_at"] = _now_iso()
                changed = True
        return changed

    def _cleanup_locked(self) -> bool:
        try:
            retention_days = max(1, int(self.retention_days_getter()))
        except Exception:
            retention_days = 30
        cutoff = time.time() - retention_days * 86400
        removed_keys = [
            key
            for key, task in self._tasks.items()
            if task.get("status") in TERMINAL_STATUSES and _timestamp(task.get("updated_at")) < cutoff
        ]
        for key in removed_keys:
            self._tasks.pop(key, None)
        return bool(removed_keys)


image_task_service = ImageTaskService(DATA_DIR / "image_tasks.json")
