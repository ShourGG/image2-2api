from __future__ import annotations

import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.app as app_module
import api.system as system_module
from services.rate_limit_service import RateLimitResult
from services.public_error import sanitize_public_error_message


class _DummyThread:
    def join(self, timeout: float | None = None) -> None:
        return None


class _DummyAuthService:
    def __init__(self, *, login_error: str | None = None, register_error: str | None = None):
        self.login_error = login_error
        self.register_error = register_error

    def login_user(self, *, email: str, password: str):
        if self.login_error:
            raise ValueError(self.login_error)
        return ({"id": "u1", "role": "user", "name": "test", "email": email, "points": 50}, "usr-token")

    def get_user_by_invite_code(self, invite_code: str):
        return None

    def register_user(self, **kwargs):
        if self.register_error:
            raise ValueError(self.register_error)
        email = str(kwargs.get("email") or "")
        name = str(kwargs.get("name") or "")
        return ({"id": "u1", "role": "user", "name": name or "test", "email": email, "points": 50}, "usr-token")


class _DummyRateLimiter:
    def __init__(self, result: RateLimitResult):
        self.result = result
        self.calls: list[list[object]] = []

    def hit_many(self, rules):
        self.calls.append(list(rules))
        return self.result


class AppSecurityHardeningTests(unittest.TestCase):
    def test_app_disables_docs_and_blocks_spa_fallback_for_reserved_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = SimpleNamespace(
                app_version="1.0.0",
                enable_api_docs=False,
                cors_allowed_origins=["https://image.shour.fun"],
                images_dir=Path(tmp_dir) / "images",
                cleanup_old_images=lambda: None,
            )
            with mock.patch.object(app_module, "config", fake_config), mock.patch.object(
                app_module, "start_limited_account_watcher", return_value=_DummyThread()
            ), mock.patch.object(app_module, "resolve_web_asset", return_value=None):
                client = TestClient(app_module.create_app())

                self.assertEqual(client.get("/docs").status_code, 404)
                self.assertEqual(client.get("/robots.txt").status_code, 404)
                self.assertEqual(client.get("/api/config").status_code, 404)
                self.assertEqual(client.get("/.env").status_code, 404)
                self.assertEqual(client.head("/.env").status_code, 404)
                self.assertEqual(client.get("/unknown-probe").status_code, 404)

                allowed = client.options(
                    "/auth/login",
                    headers={
                        "Origin": "https://image.shour.fun",
                        "Access-Control-Request-Method": "POST",
                    },
                )
                self.assertEqual(allowed.headers.get("access-control-allow-origin"), "https://image.shour.fun")

                blocked = client.options(
                    "/auth/login",
                    headers={
                        "Origin": "https://evil.example",
                        "Access-Control-Request-Method": "POST",
                    },
                )
                self.assertIsNone(blocked.headers.get("access-control-allow-origin"))

    def test_public_error_sanitizer_removes_internal_details(self) -> None:
        self.assertEqual(
            sanitize_public_error_message("HTTP 429 Concurrency limit exceeded for account"),
            "上游并发繁忙，系统会排队或稍后重试",
        )
        self.assertEqual(
            sanitize_public_error_message("Traceback in /root/chatgpt2api/config.json"),
            "服务处理失败，请稍后重试",
        )


class AuthSecurityHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = FastAPI()
        self.app.include_router(system_module.create_router("1.0.0"))
        self.fake_rate_limit_config = SimpleNamespace(
            auth_rate_limit_login_ip_limit=30,
            auth_rate_limit_login_ip_window_seconds=300,
            auth_rate_limit_login_ip_email_limit=10,
            auth_rate_limit_login_ip_email_window_seconds=300,
            auth_rate_limit_register_ip_limit=10,
            auth_rate_limit_register_ip_window_seconds=1800,
            auth_rate_limit_register_ip_email_limit=3,
            auth_rate_limit_register_ip_email_window_seconds=1800,
            auth_register_ip_account_limit=1,
            user_registration_enabled=True,
            user_registration_invite_code="",
            user_registration_total_user_limit=0,
            user_registration_password_min_length=6,
            user_registration_name_required=False,
            user_registration_allowed_email_domains=[],
            user_registration_blocked_email_domains=[],
            user_registration_default_points=50,
            user_registration_default_paid_coins=0,
            user_registration_default_paid_bonus_uses=1,
            user_registration_default_preferred_image_mode="free",
            user_registration_referral_enabled=False,
            user_registration_referral_required=False,
            user_registration_referral_reward_points=10,
        )

    def test_register_duplicate_error_is_generic(self) -> None:
        with mock.patch.object(
            system_module,
            "auth_service",
            _DummyAuthService(register_error="email already registered"),
        ), mock.patch.object(
            system_module,
            "rate_limit_service",
            _DummyRateLimiter(RateLimitResult(allowed=True)),
        ), mock.patch.object(
            system_module,
            "config",
            self.fake_rate_limit_config,
        ):
            client = TestClient(self.app)
            response = client.post(
                "/auth/register",
                json={"email": "user@example.com", "password": "secret123", "name": "user"},
            )

            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(response.json()["detail"]["error"], "注册失败，请检查输入信息或稍后再试")

    def test_login_error_is_generic(self) -> None:
        with mock.patch.object(
            system_module,
            "auth_service",
            _DummyAuthService(login_error="user is disabled"),
        ), mock.patch.object(
            system_module,
            "rate_limit_service",
            _DummyRateLimiter(RateLimitResult(allowed=True)),
        ), mock.patch.object(
            system_module,
            "config",
            self.fake_rate_limit_config,
        ):
            client = TestClient(self.app)
            response = client.post(
                "/auth/login",
                json={"email": "user@example.com", "password": "secret123"},
            )

            self.assertEqual(response.status_code, 401, response.text)
            self.assertEqual(response.json()["detail"]["error"], "邮箱或密码错误")

    def test_login_rate_limit_returns_retry_after(self) -> None:
        limiter = _DummyRateLimiter(RateLimitResult(allowed=False, retry_after_seconds=12))
        with mock.patch.object(
            system_module,
            "auth_service",
            _DummyAuthService(),
        ), mock.patch.object(system_module, "rate_limit_service", limiter), mock.patch.object(
            system_module,
            "config",
            self.fake_rate_limit_config,
        ):
            client = TestClient(self.app)
            response = client.post(
                "/auth/login",
                json={"email": "user@example.com", "password": "secret123"},
            )

            self.assertEqual(response.status_code, 429, response.text)
            self.assertEqual(response.headers.get("retry-after"), "12")
            self.assertEqual(response.json()["detail"]["retry_after_seconds"], 12)
            self.assertEqual(len(limiter.calls), 1)

    def test_login_rate_limit_uses_configurable_thresholds(self) -> None:
        limiter = _DummyRateLimiter(RateLimitResult(allowed=True, remaining=1))
        custom_config = SimpleNamespace(
            auth_rate_limit_login_ip_limit=7,
            auth_rate_limit_login_ip_window_seconds=91,
            auth_rate_limit_login_ip_email_limit=2,
            auth_rate_limit_login_ip_email_window_seconds=45,
            auth_rate_limit_register_ip_limit=0,
            auth_rate_limit_register_ip_window_seconds=1800,
            auth_rate_limit_register_ip_email_limit=0,
            auth_rate_limit_register_ip_email_window_seconds=1800,
            auth_register_ip_account_limit=1,
        )
        with mock.patch.object(
            system_module,
            "auth_service",
            _DummyAuthService(),
        ), mock.patch.object(system_module, "rate_limit_service", limiter), mock.patch.object(
            system_module,
            "config",
            custom_config,
        ):
            client = TestClient(self.app)
            response = client.post(
                "/auth/login",
                json={"email": "user@example.com", "password": "secret123"},
            )

            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(len(limiter.calls), 1)
            rules = limiter.calls[0]
            self.assertEqual(len(rules), 2)
            self.assertEqual(rules[0].limit, 7)
            self.assertEqual(rules[0].window_seconds, 91)
            self.assertEqual(rules[1].limit, 2)
            self.assertEqual(rules[1].window_seconds, 45)


if __name__ == "__main__":
    unittest.main()
