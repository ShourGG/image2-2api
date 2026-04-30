from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.account_service import AccountService
from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend
from utils.helper import anonymize_token


class AccountCapabilityTests(unittest.TestCase):
    def test_unknown_quota_accounts_are_available_only_when_not_throttled(self) -> None:
        self.assertFalse(
            AccountService._is_image_account_available(
                {"status": "限流", "image_quota_unknown": True, "quota": 0}
            )
        )
        self.assertTrue(
            AccountService._is_image_account_available(
                {"status": "正常", "image_quota_unknown": True, "quota": 0}
            )
        )

    def test_prolite_variants_are_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            self.assertEqual(service._normalize_account_type("prolite"), "ProLite")
            self.assertEqual(service._normalize_account_type("pro_lite"), "ProLite")

    def test_search_account_type_ignores_unrelated_scalar_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            self.assertIsNone(
                service._search_account_type(
                    {
                        "amr": ["pwd", "otp", "mfa"],
                        "chatgpt_compute_residency": "no_constraint",
                        "chatgpt_data_residency": "no_constraint",
                        "user_id": "user-I52GFfLGFM0dokFk2dBiKEBn",
                    }
                )
            )

    def test_mark_image_result_does_not_consume_unknown_quota(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1"])
            service.update_account(
                "token-1",
                {
                    "status": "正常",
                    "quota": 0,
                    "image_quota_unknown": True,
                },
            )

            updated = service.mark_image_result("token-1", success=True)

            self.assertIsNotNone(updated)
            self.assertEqual(updated["quota"], 0)
            self.assertEqual(updated["status"], "正常")
            self.assertTrue(updated["image_quota_unknown"])

    def test_image_account_selection_uses_shared_pool_for_user_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1", "token-2"])
            service.update_account("token-1", {"quota": 1, "owner_user_id": "user-a"})
            service.update_account("token-2", {"quota": 1, "owner_user_id": "user-b"})

            picked = service._pick_next_candidate_token(identity={"role": "user", "id": "user-b"})
            service.release_access_token(picked)

            self.assertEqual(picked, "token-1")
            self.assertTrue(service.has_available_account({"role": "user", "id": "user-a"}))
            self.assertTrue(service.has_available_account({"role": "user", "id": "user-b"}))
            self.assertTrue(service.has_available_account({"role": "user", "id": "missing"}))

    def test_user_selection_can_use_unowned_image_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1", "token-2"])
            service.update_account("token-1", {"quota": 0, "status": "限流"})
            service.update_account("token-2", {"quota": 2, "status": "正常"})

            picked = service._pick_next_candidate_token(identity={"role": "user", "id": "user-a"})
            service.release_access_token(picked)

            self.assertEqual(picked, "token-2")
            self.assertIsNone(service.get_account("token-2")["owner_user_id"])
            self.assertTrue(service.has_available_account({"role": "user", "id": "user-a"}))
            self.assertTrue(service.has_available_account({"role": "user", "id": "user-b"}))
            self.assertTrue(service.has_available_account({"role": "admin", "id": "admin"}))

    def test_busy_token_blocks_second_selection_until_released(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1"])
            service.update_account("token-1", {"quota": 1, "status": "正常"})

            first = service._pick_next_candidate_token(identity={"role": "user", "id": "user-a"})

            with self.assertRaisesRegex(RuntimeError, "busy"):
                service._pick_next_candidate_token(identity={"role": "user", "id": "user-b"})

            service.release_access_token(first)
            second = service._pick_next_candidate_token(identity={"role": "user", "id": "user-b"})
            service.release_access_token(second)
            self.assertEqual(second, "token-1")


class TokenLogTests(unittest.TestCase):
    def test_anonymize_token_hides_raw_value(self) -> None:
        token = "super-secret-token"
        token_ref = anonymize_token(token)

        self.assertTrue(token_ref.startswith("token:"))
        self.assertNotIn(token, token_ref)


class AuthServiceTests(unittest.TestCase):
    def test_create_authenticate_disable_and_delete_user_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))

            item, raw_key = service.create_key(role="user", name="Alice")

            self.assertEqual(item["role"], "user")
            self.assertEqual(item["name"], "Alice")
            self.assertTrue(item["enabled"])
            self.assertTrue(raw_key.startswith("sk-"))

            authed = service.authenticate(raw_key)
            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])
            self.assertEqual(authed["role"], "user")
            self.assertIsNotNone(authed["last_used_at"])

            updated = service.update_key(item["id"], {"enabled": False}, role="user")
            self.assertIsNotNone(updated)
            self.assertFalse(updated["enabled"])
            self.assertIsNone(service.authenticate(raw_key))

            self.assertTrue(service.delete_key(item["id"], role="user"))
            self.assertFalse(service.delete_key(item["id"], role="user"))
            self.assertEqual(service.list_keys(role="user"), [])

    def test_authenticate_ignores_last_used_save_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            item, raw_key = service.create_key(role="user", name="Alice")

            def fail_save() -> None:
                raise OSError("disk unavailable")

            service._save = fail_save

            authed = service.authenticate(raw_key)

            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])
            self.assertIsNotNone(authed["last_used_at"])

    def test_register_user_limits_successful_accounts_per_ip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))

            first, _ = service.register_user(
                email="a@example.com",
                password="secret1",
                registration_ip="203.0.113.10",
                registration_ip_limit=1,
            )

            self.assertEqual(first["registration_ip"], "203.0.113.10")
            with self.assertRaisesRegex(ValueError, "registration ip limit reached"):
                service.register_user(
                    email="b@example.com",
                    password="secret1",
                    registration_ip="203.0.113.10",
                    registration_ip_limit=1,
                )

            second, _ = service.register_user(
                email="c@example.com",
                password="secret1",
                registration_ip="203.0.113.11",
                registration_ip_limit=1,
            )
            self.assertEqual(second["registration_ip"], "203.0.113.11")


if __name__ == "__main__":
    unittest.main()
