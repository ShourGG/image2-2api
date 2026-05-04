from __future__ import annotations

from urllib.parse import urlsplit

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict
from curl_cffi.requests import Session

from api.support import extract_bearer_token, require_admin, require_identity, resolve_image_base_url
from services.auth_service import (
    COIN_EXCHANGE_RATE,
    GAMBLE_DEFAULT_BET,
    IMAGE_POINT_COST,
    IMAGE_POINT_COSTS,
    IMAGE_POINT_COST_TABLE,
    PAID_IMAGE_COIN_COST_TABLE,
    auth_service,
)
from services.config import config
from services.image_service import list_images
from services.log_service import log_service
from services.proxy_service import proxy_settings
from services.proxy_service import test_proxy
from services.protocol.conversation import (
    ConversationRequest,
    ImageGenerationError,
    list_openai_compatible_upstream_runtime_states,
    openai_compatible_image_outputs,
    openai_compatible_upstream_runtime_state,
)
from services.rate_limit_service import RateLimitRule, rate_limit_service

DEFAULT_IMAGE_UPSTREAM_TEST_PROMPT = "一张简洁的测试图片：白色背景上有一个蓝色圆形和清晰的 TEST 字样。"


class SettingsUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")


class ProxyTestRequest(BaseModel):
    url: str = ""


class ImageUpstreamGenerationTestRequest(BaseModel):
    prompt: str = DEFAULT_IMAGE_UPSTREAM_TEST_PROMPT
    size: str = "1024x1024"
    quality: str = ""


class LoginRequest(BaseModel):
    email: str = ""
    password: str = ""


class RegisterRequest(BaseModel):
    email: str = ""
    password: str = ""
    name: str = ""
    invite_code: str = ""


class AdminBindRequest(BaseModel):
    email: str = ""
    password: str = ""
    name: str = ""


class AdminSetupRequest(BaseModel):
    email: str = ""
    password: str = ""
    name: str = ""
    setup_key: str = ""


class UserUpdateRequest(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    password: str | None = None
    points: float | None = None
    paid_coins: int | None = None
    paid_bonus_uses: int | None = None
    preferred_image_mode: str | None = None


class GambleCheckinRequest(BaseModel):
    bet: float = GAMBLE_DEFAULT_BET
    max_multiplier: float = 1


def _client_ip(request: Request) -> str:
    for header in ("cf-connecting-ip", "x-real-ip", "x-forwarded-for"):
        raw = str(request.headers.get(header) or "").strip()
        if raw:
            return raw.split(",", 1)[0].strip()
    if request.client and request.client.host:
        return str(request.client.host).strip()
    return "unknown"


def _email_domain(email: str) -> str:
    _local, _sep, domain = str(email or "").strip().lower().rpartition("@")
    return domain


def _domain_matches(domain: str, rule: str) -> bool:
    normalized_rule = str(rule or "").strip().lower().lstrip("@")
    if not domain or not normalized_rule:
        return False
    if normalized_rule.startswith("*."):
        suffix = normalized_rule[2:]
        return domain == suffix or domain.endswith(f".{suffix}")
    return domain == normalized_rule


def _validate_registration_policy(body: RegisterRequest) -> str:
    input_invite_code = str(body.invite_code or "").strip()
    site_invite_code = config.user_registration_invite_code
    referrer = auth_service.get_user_by_invite_code(input_invite_code) if config.user_registration_referral_enabled else None
    referrer_user_id = str(referrer.get("id") or "").strip() if referrer else ""

    if site_invite_code and input_invite_code != site_invite_code and not referrer_user_id:
        raise ValueError("invite code invalid")
    if config.user_registration_referral_enabled:
        if config.user_registration_referral_required and not referrer_user_id:
            raise ValueError("invite code invalid")
        if input_invite_code and input_invite_code != site_invite_code and not referrer_user_id:
            raise ValueError("invite code invalid")

    domain = _email_domain(body.email)
    allowed_domains = config.user_registration_allowed_email_domains
    blocked_domains = config.user_registration_blocked_email_domains
    if allowed_domains and not any(_domain_matches(domain, item) for item in allowed_domains):
        raise ValueError("email domain not allowed")
    if blocked_domains and any(_domain_matches(domain, item) for item in blocked_domains):
        raise ValueError("email domain blocked")
    return referrer_user_id


def _enforce_auth_rate_limit(action: str, request: Request, email: str) -> None:
    normalized_email = str(email or "").strip().lower()
    client_ip = _client_ip(request)
    rules: list[RateLimitRule] = []
    if action == "register":
        if config.auth_rate_limit_register_ip_limit > 0:
            rules.append(
                RateLimitRule(
                    key=f"auth:register:ip:{client_ip}",
                    limit=config.auth_rate_limit_register_ip_limit,
                    window_seconds=config.auth_rate_limit_register_ip_window_seconds,
                )
            )
        if config.auth_rate_limit_register_ip_email_limit > 0:
            rules.append(
                RateLimitRule(
                    key=f"auth:register:ip-email:{client_ip}:{normalized_email or '-'}",
                    limit=config.auth_rate_limit_register_ip_email_limit,
                    window_seconds=config.auth_rate_limit_register_ip_email_window_seconds,
                )
            )
    else:
        if config.auth_rate_limit_login_ip_limit > 0:
            rules.append(
                RateLimitRule(
                    key=f"auth:login:ip:{client_ip}",
                    limit=config.auth_rate_limit_login_ip_limit,
                    window_seconds=config.auth_rate_limit_login_ip_window_seconds,
                )
            )
        if config.auth_rate_limit_login_ip_email_limit > 0:
            rules.append(
                RateLimitRule(
                    key=f"auth:login:ip-email:{client_ip}:{normalized_email or '-'}",
                    limit=config.auth_rate_limit_login_ip_email_limit,
                    window_seconds=config.auth_rate_limit_login_ip_email_window_seconds,
                )
            )

    result = rate_limit_service.hit_many(rules)
    if result.allowed:
        return
    retry_after_seconds = max(1, int(result.retry_after_seconds or 1))
    raise HTTPException(
        status_code=429,
        detail={
            "error": "请求过于频繁，请稍后再试",
            "retry_after_seconds": retry_after_seconds,
        },
        headers={"Retry-After": str(retry_after_seconds)},
    )


def _register_error_message(exc: ValueError) -> str:
    message = str(exc)
    if message == "registration disabled":
        return "用户注册已关闭"
    if message == "email is invalid":
        return "邮箱格式不正确"
    if message.startswith("password must be at least "):
        min_length = message.removeprefix("password must be at least ").removesuffix(" characters")
        return f"密码至少 {min_length} 位"
    if message == "name is required":
        return "请输入昵称"
    if message == "invite code invalid":
        return "邀请码不正确"
    if message == "email domain not allowed":
        return "当前邮箱域名不允许注册"
    if message == "email domain blocked":
        return "当前邮箱域名禁止注册"
    if message == "user registration limit reached":
        return "注册用户数已达上限"
    if message == "registration ip limit reached":
        return "当前 IP 已注册过账号"
    return "注册失败，请检查输入信息或稍后再试"


def _login_error_message(exc: ValueError) -> str:
    if str(exc) == "email and password are required":
        return "请输入邮箱和密码"
    return "邮箱或密码错误"


def _login_response(app_version: str, identity: dict[str, object], token: str | None = None) -> dict[str, object]:
    response: dict[str, object] = {
        "ok": True,
        "version": app_version,
        "role": identity.get("role"),
        "subject_id": identity.get("id"),
        "name": identity.get("name"),
    }
    if token:
        response["token"] = token
    email = identity.get("email")
    if email:
        response["email"] = email
    if identity.get("points") is not None:
        response["points"] = identity.get("points")
    return response


def _permissions_for_role(role: str) -> list[str]:
    if role == "admin":
        return ["image", "logs", "accounts", "register", "settings", "image_manager"]
    return ["image", "logs"]


def _billing_for_role(role: str) -> dict[str, object]:
    return {
        "mode": "points" if role == "user" else "account_pool",
        "image_point_cost": IMAGE_POINT_COST,
        "image_point_costs": IMAGE_POINT_COSTS,
        "image_point_cost_table": IMAGE_POINT_COST_TABLE,
        "paid_coin_cost_table": PAID_IMAGE_COIN_COST_TABLE,
        "coin_exchange_rate": COIN_EXCHANGE_RATE,
        "default_paid_bonus_uses": config.user_registration_default_paid_bonus_uses,
        "default_paid_coins": config.user_registration_default_paid_coins,
        "default_user_points": config.user_registration_default_points,
        "referral_enabled": config.user_registration_referral_enabled,
        "referral_required": config.user_registration_referral_required,
        "referral_reward_points": config.user_registration_referral_reward_points,
    }


def _me_response_from_item(
    item: dict[str, object],
    *,
    checkins: dict[str, object] | None = None,
) -> dict[str, object]:
    role = str(item.get("role") or "")
    response = {
        "item": item,
        "permissions": _permissions_for_role(role),
        "billing": _billing_for_role(role),
    }
    if checkins is not None:
        response["checkins"] = checkins
    return response


def _current_user_me_response(identity: dict[str, object]) -> dict[str, object]:
    role = str(identity.get("role") or "")
    if role != "user":
        return _me_response_from_item(identity)
    user_id = str(identity.get("id") or "").strip()
    profile = auth_service.get_user_profile(user_id)
    if not profile:
        return _me_response_from_item(identity)
    return _me_response_from_item(
        dict(profile.get("item") or identity),
        checkins=profile.get("checkins") if isinstance(profile.get("checkins"), dict) else None,
    )


def _query_openai_compatible_usage(upstream: dict[str, object]) -> dict[str, object]:
    base_url = str(upstream.get("base_url") or "").strip().rstrip("/")
    api_key = str(upstream.get("api_key") or "").strip()
    if not base_url:
        raise ValueError("base_url is required")
    if not api_key:
        raise ValueError("api_key is required")
    session = Session(**proxy_settings.build_session_kwargs(impersonate="edge101", verify=False))
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        }
        response = session.get(f"{base_url}/v1/usage", headers=headers, timeout=20)
        payload = _read_usage_response_payload(response)
        if response.status_code >= 400:
            if _is_new_api_missing_v1_usage(response, payload):
                fallback = _query_new_api_token_usage(session, base_url, headers)
                if fallback is not None:
                    return fallback
            return {"ok": False, "status": response.status_code, "error": payload}
        return {
            "ok": True,
            "status": response.status_code,
            "usage": payload,
        }
    finally:
        session.close()


def _read_usage_response_payload(response) -> object:
    try:
        return response.json()
    except Exception:
        return response.text[:1000]


def _is_new_api_missing_v1_usage(response, payload: object) -> bool:
    if not str(response.headers.get("X-New-Api-Version") or "").strip():
        return False
    if response.status_code not in {400, 404, 405}:
        return False
    message = ""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "")
        else:
            message = str(payload.get("message") or "")
    else:
        message = str(payload or "")
    return "/v1/usage" in message and "invalid url" in message.lower()


def _query_new_api_token_usage(session: Session, base_url: str, headers: dict[str, str]) -> dict[str, object] | None:
    response = session.get(f"{base_url.rstrip('/')}/api/usage/token/", headers=headers, timeout=20)
    payload = _read_usage_response_payload(response)
    if response.status_code >= 400:
        return {"ok": False, "status": response.status_code, "error": payload}
    if not isinstance(payload, dict):
        return {"ok": False, "status": response.status_code, "error": payload}

    if payload.get("success") is False or payload.get("code") is False:
        return {"ok": False, "status": response.status_code, "error": payload}

    data = payload.get("data")
    if not isinstance(data, dict):
        return {"ok": False, "status": response.status_code, "error": payload}

    quota = _new_api_numeric(data.get("total_granted") if data.get("total_granted") is not None else data.get("quota"))
    used_quota = _new_api_numeric(data.get("total_used") if data.get("total_used") is not None else (data.get("used_quota") or data.get("used")))
    available_quota = _new_api_numeric(
        data.get("total_available")
        if data.get("total_available") is not None
        else (data.get("remain_quota") if data.get("remain_quota") is not None else data.get("remaining_quota"))
    )
    unlimited_quota = bool(data.get("unlimited_quota"))
    quota_per_unit = _new_api_quota_per_unit(base_url)
    remaining_quota = available_quota
    if remaining_quota is None and quota is not None:
        remaining_quota = max(0.0, quota - (used_quota or 0.0))
    if unlimited_quota:
        remaining_quota = None
    remaining = None if remaining_quota is None else remaining_quota / quota_per_unit
    used = None if used_quota is None else used_quota / quota_per_unit
    limit_quota = quota if quota is not None else (
        (remaining_quota or 0.0) + used_quota
        if remaining_quota is not None and used_quota is not None
        else None
    )
    limit = None if limit_quota is None else limit_quota / quota_per_unit

    usage = {
        "mode": "new_api_token",
        "unit": "USD",
        "balance": remaining,
        "remaining": remaining,
        "quota": {
            "remaining": remaining,
            "used": used,
            "limit": limit,
            "unit": "USD",
            "unlimited": unlimited_quota,
        },
        "raw": {
            "quota": quota,
            "used_quota": used_quota,
            "remaining_quota": remaining_quota,
            "unlimited_quota": unlimited_quota,
            "quota_per_unit": quota_per_unit,
        },
    }
    if unlimited_quota:
        usage["balance"] = None
        usage["remaining"] = None
    return {"ok": True, "status": response.status_code, "usage": usage}


def _new_api_numeric(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _new_api_quota_per_unit(base_url: str) -> float:
    host = urlsplit(base_url).netloc.lower()
    if "gettoken.dev" in host:
        return 1.0
    return 500000.0


def _test_openai_compatible_image_upstream(
    upstream: dict[str, object],
    *,
    prompt: str,
    size: str,
    quality: str,
    base_url: str,
) -> dict[str, object]:
    final_prompt = str(prompt or "").strip() or DEFAULT_IMAGE_UPSTREAM_TEST_PROMPT
    request = ConversationRequest(
        model=str(upstream.get("model") or config.image_generation_api_model or "gpt-image-2").strip() or "gpt-image-2",
        prompt=final_prompt,
        size=str(size or "").strip() or "1024x1024",
        quality=str(quality or "").strip(),
        response_format="url",
        base_url=base_url,
    )
    for output in openai_compatible_image_outputs(request, 1, 1, upstream):
        if output.kind == "result":
            return {
                "ok": True,
                "prompt": final_prompt,
                "data": output.data,
            }
    raise ImageGenerationError("上游没有返回测试图片")


def create_router(app_version: str) -> APIRouter:
    router = APIRouter()

    @router.post("/auth/login")
    async def login(request: Request, body: LoginRequest | None = None, authorization: str | None = Header(default=None)):
        token = extract_bearer_token(authorization)
        if token:
            identity = require_identity(authorization)
            return _login_response(app_version, identity, token=token)
        payload = body or LoginRequest()
        _enforce_auth_rate_limit("login", request, payload.email)
        try:
            identity, session_token = auth_service.login_user(
                email=payload.email,
                password=payload.password,
            )
        except ValueError as exc:
            raise HTTPException(status_code=401, detail={"error": _login_error_message(exc)}) from exc
        return _login_response(app_version, identity, token=session_token)

    @router.post("/auth/register")
    async def register(request: Request, body: RegisterRequest):
        if not config.user_registration_enabled:
            raise HTTPException(status_code=403, detail={"error": _register_error_message(ValueError("registration disabled"))})
        client_ip = _client_ip(request)
        _enforce_auth_rate_limit("register", request, body.email)
        try:
            referrer_user_id = _validate_registration_policy(body)
            identity, session_token = auth_service.register_user(
                email=body.email,
                password=body.password,
                name=body.name,
                registration_ip=client_ip,
                registration_ip_limit=config.auth_register_ip_account_limit,
                password_min_length=config.user_registration_password_min_length,
                name_required=config.user_registration_name_required,
                total_user_limit=config.user_registration_total_user_limit,
                initial_points=config.user_registration_default_points,
                initial_paid_coins=config.user_registration_default_paid_coins,
                initial_paid_bonus_uses=config.user_registration_default_paid_bonus_uses,
                preferred_image_mode=config.user_registration_default_preferred_image_mode,
                referrer_user_id=referrer_user_id,
                referral_reward_points=config.user_registration_referral_reward_points,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": _register_error_message(exc)}) from exc
        return _login_response(app_version, identity, token=session_token)

    @router.get("/version")
    async def get_version():
        return {"version": app_version}

    @router.get("/api/me")
    async def get_me(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return _current_user_me_response(identity)

    @router.post("/api/checkins/normal")
    async def normal_checkin(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        if identity.get("role") != "user":
            raise HTTPException(status_code=403, detail={"error": "user permission required"})
        try:
            payload = auth_service.perform_normal_checkin(str(identity.get("id") or ""))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        item = payload.get("item") if isinstance(payload.get("item"), dict) else identity
        checkins = payload.get("checkins") if isinstance(payload.get("checkins"), dict) else None
        return _me_response_from_item(dict(item), checkins=checkins)

    @router.post("/api/checkins/gamble")
    async def gamble_checkin(body: GambleCheckinRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        if identity.get("role") != "user":
            raise HTTPException(status_code=403, detail={"error": "user permission required"})
        try:
            payload = auth_service.perform_gamble_checkin(
                str(identity.get("id") or ""),
                bet=body.bet,
                max_multiplier=body.max_multiplier,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        item = payload.get("item") if isinstance(payload.get("item"), dict) else identity
        checkins = payload.get("checkins") if isinstance(payload.get("checkins"), dict) else None
        return _me_response_from_item(dict(item), checkins=checkins)

    @router.get("/api/settings")
    async def get_settings(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.get()}

    @router.post("/api/settings")
    async def save_settings(body: SettingsUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.update(body.model_dump(mode="python"))}

    @router.get("/api/admin/setup")
    async def get_admin_setup_state():
        return {"required": not auth_service.has_admin_account()}

    @router.post("/api/admin/setup")
    async def setup_admin_account(body: AdminSetupRequest):
        if auth_service.has_admin_account():
            raise HTTPException(status_code=409, detail={"error": "管理员账号已初始化"})
        if auth_service.authenticate_admin_key(body.setup_key) is None:
            raise HTTPException(status_code=400, detail={"error": "后台密钥不正确"})
        try:
            auth_service.bind_admin_account(
                email=body.email,
                password=body.password,
                name=body.name,
            )
            identity, session_token = auth_service.login_user(
                email=body.email,
                password=body.password,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": _register_error_message(exc)}) from exc
        return _login_response(app_version, identity, token=session_token)

    @router.post("/api/admin/bind")
    async def bind_admin_account(body: AdminBindRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            item = auth_service.bind_admin_account(
                email=body.email,
                password=body.password,
                name=body.name,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": _register_error_message(exc)}) from exc
        return {"item": item}

    @router.get("/api/settings/image-upstreams/{upstream_id}/usage")
    async def image_upstream_usage(upstream_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        upstream = config.get_image_generation_api_upstream(upstream_id)
        if upstream is None:
            raise HTTPException(status_code=404, detail={"error": "upstream not found"})
        try:
            result = await run_in_threadpool(_query_openai_compatible_usage, upstream)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        except Exception as exc:
            result = {"ok": False, "status": 0, "error": str(exc) or exc.__class__.__name__}
        return {"result": result, "runtime": openai_compatible_upstream_runtime_state(upstream)}

    @router.post("/api/settings/image-upstreams/{upstream_id}/test-image")
    async def image_upstream_test_image(
        upstream_id: str,
        request: Request,
        body: ImageUpstreamGenerationTestRequest | None = None,
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        upstream = config.get_image_generation_api_upstream(upstream_id)
        if upstream is None:
            raise HTTPException(status_code=404, detail={"error": "upstream not found"})
        payload = body or ImageUpstreamGenerationTestRequest()
        try:
            result = await run_in_threadpool(
                _test_openai_compatible_image_upstream,
                upstream,
                prompt=payload.prompt,
                size=payload.size,
                quality=payload.quality,
                base_url=resolve_image_base_url(request),
            )
        except ImageGenerationError as exc:
            result = {
                "ok": False,
                "status": exc.status_code,
                "error": str(exc) or exc.__class__.__name__,
                "code": exc.code,
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        except Exception as exc:
            result = {"ok": False, "status": 0, "error": str(exc) or exc.__class__.__name__}
        return {"result": result, "runtime": openai_compatible_upstream_runtime_state(upstream)}

    @router.get("/api/settings/image-upstreams/status")
    async def image_upstream_statuses(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": list_openai_compatible_upstream_runtime_states()}

    @router.get("/api/images")
    async def get_images(request: Request, start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return list_images(resolve_image_base_url(request), start_date=start_date.strip(), end_date=end_date.strip())

    @router.get("/api/logs")
    async def get_logs(type: str = "", start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {
            "items": log_service.list(
                type=type.strip(),
                start_date=start_date.strip(),
                end_date=end_date.strip(),
                identity=identity,
            )
        }

    @router.get("/api/users")
    async def get_users(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": auth_service.list_users()}

    @router.post("/api/users/{user_id}")
    async def update_user(user_id: str, body: UserUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        updates = {
            key: value
            for key, value in {
                "name": body.name,
                "enabled": body.enabled,
                "password": body.password,
                "points": body.points,
                "paid_coins": body.paid_coins,
                "paid_bonus_uses": body.paid_bonus_uses,
                "preferred_image_mode": body.preferred_image_mode,
            }.items()
            if value is not None
        }
        if not updates:
            raise HTTPException(status_code=400, detail={"error": "no updates provided"})
        try:
            item = auth_service.update_user(user_id, updates)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "user not found"})
        return {"item": item, "items": auth_service.list_users()}

    @router.delete("/api/users/{user_id}")
    async def delete_user(user_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        if not auth_service.delete_user(user_id):
            raise HTTPException(status_code=404, detail={"error": "user not found"})
        from services.account_service import account_service

        account_service.clear_owner(user_id)
        return {"items": auth_service.list_users()}

    @router.post("/api/proxy/test")
    async def test_proxy_endpoint(body: ProxyTestRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        candidate = (body.url or "").strip() or config.get_proxy_settings()
        if not candidate:
            raise HTTPException(status_code=400, detail={"error": "proxy url is required"})
        return {"result": await run_in_threadpool(test_proxy, candidate)}

    @router.get("/api/storage/info")
    async def get_storage_info(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        storage = config.get_storage_backend()
        return {
            "backend": storage.get_backend_info(),
            "health": storage.health_check(),
        }

    return router
