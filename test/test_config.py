import json
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
ROOT_CONFIG_FILE = ROOT_DIR / "config.json"


class ConfigLoadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._created_root_config = False
        if not ROOT_CONFIG_FILE.exists():
            ROOT_CONFIG_FILE.write_text(json.dumps({"auth-key": "test-auth"}), encoding="utf-8")
            cls._created_root_config = True

        from services import config as config_module

        cls.config_module = config_module

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._created_root_config and ROOT_CONFIG_FILE.exists():
            ROOT_CONFIG_FILE.unlink()

    def test_load_settings_ignores_directory_config_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            data_dir = base_dir / "data"
            config_dir = base_dir / "config.json"
            os_auth_key = "env-auth"

            config_dir.mkdir()

            module = self.config_module
            old_base_dir = module.BASE_DIR
            old_data_dir = module.DATA_DIR
            old_config_file = module.CONFIG_FILE
            old_env_auth_key = module.os.environ.get("CHATGPT2API_AUTH_KEY")
            try:
                module.BASE_DIR = base_dir
                module.DATA_DIR = data_dir
                module.CONFIG_FILE = config_dir
                module.os.environ["CHATGPT2API_AUTH_KEY"] = os_auth_key

                settings = module._load_settings()

                self.assertEqual(settings.auth_key, os_auth_key)
                self.assertEqual(settings.refresh_account_interval_minute, 5)
            finally:
                module.BASE_DIR = old_base_dir
                module.DATA_DIR = old_data_dir
                module.CONFIG_FILE = old_config_file
                if old_env_auth_key is None:
                    module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)
                else:
                    module.os.environ["CHATGPT2API_AUTH_KEY"] = old_env_auth_key

    def test_image_generation_api_max_concurrency_is_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "auth-key": "test-auth",
                        "image_generation_api_max_concurrency": "0",
                    }
                ),
                encoding="utf-8",
            )

            store = self.config_module.ConfigStore(path)

            self.assertEqual(store.image_generation_api_max_concurrency, 1)
            updated = store.update({"image_generation_api_max_concurrency": "12"})
            self.assertEqual(store.image_generation_api_max_concurrency, 12)
            self.assertEqual(updated["image_generation_api_max_concurrency"], 12)
            self.assertEqual(updated["image_generation_api_upstreams"], [])

    def test_image_generation_api_upstream_max_concurrency_uses_global_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "auth-key": "test-auth",
                        "image_generation_api_max_concurrency": 6,
                        "image_generation_api_upstreams": [
                            {
                                "id": "u1",
                                "name": "上游 1",
                                "base_url": "https://example.com",
                                "model": "gpt-image-2",
                                "enabled": True,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            store = self.config_module.ConfigStore(path)

            upstreams = store.image_generation_api_upstreams
            self.assertEqual(len(upstreams), 1)
            self.assertEqual(upstreams[0]["max_concurrency"], 6)
            self.assertEqual(store.image_generation_api_total_max_concurrency, 6)

    def test_auth_rate_limit_fields_are_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "auth-key": "test-auth",
                        "auth_rate_limit_login_ip_limit": "-1",
                        "auth_rate_limit_login_ip_window_seconds": "0",
                        "auth_rate_limit_register_ip_email_limit": "5",
                        "auth_rate_limit_register_ip_email_window_seconds": "bad",
                        "auth_register_ip_account_limit": "1",
                    }
                ),
                encoding="utf-8",
            )

            store = self.config_module.ConfigStore(path)

            self.assertEqual(store.auth_rate_limit_login_ip_limit, 0)
            self.assertEqual(store.auth_rate_limit_login_ip_window_seconds, 1)
            self.assertEqual(store.auth_rate_limit_register_ip_email_limit, 5)
            self.assertEqual(store.auth_rate_limit_register_ip_email_window_seconds, 1800)
            self.assertEqual(store.auth_register_ip_account_limit, 1)

            updated = store.get()
            self.assertEqual(updated["auth_rate_limit_login_ip_limit"], 0)
            self.assertEqual(updated["auth_rate_limit_login_ip_window_seconds"], 1)
            self.assertEqual(updated["auth_register_ip_account_limit"], 1)


if __name__ == "__main__":
    unittest.main()
