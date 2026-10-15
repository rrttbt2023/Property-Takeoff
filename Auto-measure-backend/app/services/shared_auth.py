import hashlib
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any

from fastapi import Depends, Header, HTTPException

from app.repositories.account_repository import (
    create_customer_account,
    create_session,
    delete_session,
    get_session,
    get_user_by_identifier,
    upsert_internal_user,
    verify_password,
)


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _parse_bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _session_ttl_hours() -> float:
    raw = str(os.getenv("AUTO_MEASURE_SHARED_AUTH_TTL_HOURS", "168")).strip()
    try:
        value = float(raw)
    except Exception:
        value = 168.0
    return min(720.0, max(0.25, value))


def _session_expiry() -> datetime:
    return _now_utc() + timedelta(hours=_session_ttl_hours())


def _configured_username() -> str:
    return str(os.getenv("AUTO_MEASURE_SHARED_AUTH_USER", "")).strip()


def _configured_password() -> str:
    return str(os.getenv("AUTO_MEASURE_SHARED_AUTH_PASS", ""))


def _allow_insecure_default_credentials() -> bool:
    return _parse_bool_env("AUTO_MEASURE_SHARED_AUTH_ALLOW_INSECURE_DEFAULTS", False)


def _append_credential(credentials: dict[str, str], username: str, password: str) -> None:
    user = str(username or "").strip()
    pwd = str(password or "")
    if user and pwd and len(user) <= 120:
        credentials[user] = pwd


def _parse_credentials_json(raw: str) -> dict[str, str]:
    try:
        parsed = json.loads(str(raw or "").strip())
    except Exception:
        return {}
    credentials: dict[str, str] = {}
    if isinstance(parsed, dict):
        for username, password in parsed.items():
            _append_credential(credentials, str(username), str(password))
    elif isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict):
                _append_credential(credentials, item.get("username"), item.get("password"))
    return credentials


def _parse_credentials_csv(raw: str) -> dict[str, str]:
    credentials: dict[str, str] = {}
    for chunk in str(raw or "").split(","):
        if ":" not in chunk:
            continue
        username, password = chunk.strip().split(":", 1)
        _append_credential(credentials, username, password)
    return credentials


def _configured_credentials() -> dict[str, str]:
    credentials: dict[str, str] = {}
    for raw in (
        os.getenv("AUTO_MEASURE_SHARED_AUTH_USERS_JSON", ""),
        os.getenv("AUTO_MEASURE_SHARED_AUTH_USERS", ""),
    ):
        if not str(raw or "").strip():
            continue
        parsed = _parse_credentials_json(raw)
        credentials.update(parsed or _parse_credentials_csv(raw))
    username = _configured_username()
    password = _configured_password()
    if username and password:
        credentials[username] = password
    if not credentials and _allow_insecure_default_credentials():
        credentials["admin"] = "changeme"
    return credentials


def _shared_auth_config_error() -> str | None:
    username = _configured_username()
    password = _configured_password()
    if bool(username) ^ bool(password):
        return (
            "Shared access is misconfigured. Set both AUTO_MEASURE_SHARED_AUTH_USER and "
            "AUTO_MEASURE_SHARED_AUTH_PASS together, or use AUTO_MEASURE_SHARED_AUTH_USERS."
        )
    if _configured_credentials():
        return None
    return (
        "Shared access login is not configured on this server. Set "
        "AUTO_MEASURE_SHARED_AUTH_USERS, AUTO_MEASURE_SHARED_AUTH_USERS_JSON, or both "
        "AUTO_MEASURE_SHARED_AUTH_USER and AUTO_MEASURE_SHARED_AUTH_PASS."
    )


def _parse_bearer_token(raw: str | None) -> str:
    text = str(raw or "").strip()
    return text[7:].strip() if text.lower().startswith("bearer ") else ""


def _token_hash(token: str) -> str:
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _public_session(token: str, account: dict[str, Any], expires_at: str) -> dict[str, Any]:
    return {
        "token": token,
        "username": str(account.get("username") or ""),
        "email": str(account.get("email") or ""),
        "display_name": str(account.get("display_name") or account.get("username") or ""),
        "user_id": str(account.get("user_id") or ""),
        "organization_id": str(account.get("organization_id") or ""),
        "organization_name": str(account.get("organization_name") or "Workspace"),
        "role": str(account.get("role") or "member"),
        "subscription_status": str(account.get("subscription_status") or "inactive"),
        "workspace_access": bool(account.get("workspace_access")),
        "ai_access": bool(account.get("ai_access")),
        "is_staff": bool(account.get("is_internal")),
        "expires_at": str(expires_at),
    }


_TOKEN_STORE: dict[str, dict[str, Any]] = {}
_TOKEN_LOCK = Lock()


def _issue_session(account: dict[str, Any]) -> dict[str, Any]:
    token = secrets.token_urlsafe(36)
    expires_at = _session_expiry().isoformat().replace("+00:00", "Z")
    session = _public_session(token, account, expires_at)
    create_session(str(account["user_id"]), _token_hash(token), expires_at)
    with _TOKEN_LOCK:
        _TOKEN_STORE[token] = session
    return session


def login_shared_user(username: str, password: str) -> dict[str, Any]:
    user = str(username or "").strip()
    pwd = str(password or "")
    account = get_user_by_identifier(user)
    if account and account.get("is_active") and verify_password(pwd, str(account.get("password_hash"))):
        return _issue_session(account)

    configured_credentials = _configured_credentials()
    expected_password = configured_credentials.get(user)
    if expected_password and secrets.compare_digest(pwd, expected_password):
        return _issue_session(upsert_internal_user(user, pwd))

    if not account and not configured_credentials:
        config_error = _shared_auth_config_error()
        if config_error:
            raise HTTPException(status_code=503, detail=config_error)
    secrets.compare_digest(pwd, "shared-auth-placeholder")
    raise HTTPException(status_code=401, detail="Invalid username or password.")


def register_shared_user(
    *,
    email: str,
    password: str,
    display_name: str,
    organization_name: str,
) -> dict[str, Any]:
    if not _parse_bool_env("AUTO_MEASURE_ALLOW_PUBLIC_SIGNUP", True):
        raise HTTPException(status_code=403, detail="New account registration is currently closed.")
    try:
        account = create_customer_account(
            email=email,
            password=password,
            display_name=display_name,
            organization_name=organization_name,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return _issue_session(account)


def logout_shared_user(token: str) -> None:
    normalized = str(token or "").strip()
    with _TOKEN_LOCK:
        _TOKEN_STORE.pop(normalized, None)
    if normalized:
        delete_session(_token_hash(normalized))


def _read_session(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    account = get_session(_token_hash(token))
    if not account:
        with _TOKEN_LOCK:
            _TOKEN_STORE.pop(token, None)
        return None
    session = _public_session(token, account, str(account.get("expires_at") or ""))
    with _TOKEN_LOCK:
        _TOKEN_STORE[token] = session
    return session


def require_shared_access(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token = _parse_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Login required.")
    session = _read_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    return session


def require_workspace_access(
    session: dict[str, Any] = Depends(require_shared_access),
) -> dict[str, Any]:
    if not session.get("workspace_access"):
        raise HTTPException(
            status_code=402,
            detail="An active Property Takeoff subscription is required.",
        )
    return session


def require_staff_access(
    session: dict[str, Any] = Depends(require_shared_access),
) -> dict[str, Any]:
    if not session.get("is_staff"):
        raise HTTPException(status_code=403, detail="Staff access is required.")
    return session


def require_ai_access(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    production = str(os.getenv("AUTO_MEASURE_ENV", "")).strip().lower() in {
        "prod",
        "production",
    } or _parse_bool_env("RENDER", False)
    enforce = _parse_bool_env("AUTO_MEASURE_REQUIRE_AI_AUTH", production)
    token = _parse_bearer_token(authorization)
    if not token and not enforce:
        return {"username": "local-development", "ai_access": True, "is_staff": True}
    session = _read_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Login required for AI/CV tools.")
    if not session.get("ai_access"):
        raise HTTPException(status_code=403, detail="AI/CV tools are not included in this plan.")
    return session
