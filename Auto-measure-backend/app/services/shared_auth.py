import hashlib
import hmac
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any

from fastapi import Depends, Header, HTTPException, Request

from app.repositories.account_repository import (
    create_customer_account,
    create_account_token,
    create_session,
    consume_account_token,
    delete_customer_account,
    delete_session,
    delete_user_sessions,
    get_session,
    get_user_by_identifier,
    mark_email_verified,
    record_login_failure,
    record_login_success,
    set_user_mfa,
    upsert_internal_user,
    update_user_password,
    verify_password,
)
from app.services.email_service import send_action_email
from app.services.totp import generate_secret, provisioning_url, verify_totp


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
        "csrf_token": csrf_token_for_session(token),
        "authenticated": True,
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
        "email_verified": bool(account.get("email_verified_at")) or bool(account.get("is_internal")),
        "mfa_enabled": bool(account.get("mfa_enabled")),
        "expires_at": str(expires_at),
    }


def csrf_token_for_session(token: str) -> str:
    secret = str(
        os.getenv("AUTO_MEASURE_CSRF_SECRET")
        or os.getenv("AUTO_MEASURE_PASSWORD_PEPPER")
        or "local-development-csrf-secret"
    ).encode("utf-8")
    return hmac.new(secret, str(token).encode("utf-8"), hashlib.sha256).hexdigest()


def validate_csrf_token(token: str, candidate: str) -> bool:
    return bool(token and candidate) and hmac.compare_digest(
        csrf_token_for_session(token), str(candidate)
    )


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


def login_shared_user(username: str, password: str, mfa_code: str | None = None) -> dict[str, Any]:
    user = str(username or "").strip()
    pwd = str(password or "")
    account = get_user_by_identifier(user)
    if account and account.get("locked_until"):
        try:
            locked_until = datetime.fromisoformat(str(account["locked_until"]).replace("Z", "+00:00"))
            if locked_until > _now_utc():
                raise HTTPException(status_code=423, detail="Account temporarily locked. Try again later.")
        except HTTPException:
            raise
        except Exception:
            pass
    if account and account.get("is_active") and verify_password(pwd, str(account.get("password_hash"))):
        requires_verification = _parse_bool_env("AUTO_MEASURE_REQUIRE_EMAIL_VERIFICATION", False)
        if requires_verification and not account.get("is_internal") and not account.get("email_verified_at"):
            raise HTTPException(status_code=403, detail="Verify your email before signing in.")
        requires_mfa = bool(account.get("mfa_enabled")) or (
            bool(account.get("is_internal"))
            and _parse_bool_env("AUTO_MEASURE_REQUIRE_STAFF_MFA", False)
        )
        if requires_mfa:
            secret = str(account.get("mfa_secret") or "")
            if not secret:
                raise HTTPException(status_code=428, detail="Staff MFA enrollment is required.")
            if not verify_totp(secret, str(mfa_code or "")):
                raise HTTPException(status_code=428, detail="Enter the 6-digit authenticator code.")
        record_login_success(str(account["user_id"]))
        return _issue_session(account)

    configured_credentials = _configured_credentials()
    expected_password = configured_credentials.get(user)
    if expected_password and secrets.compare_digest(pwd, expected_password):
        internal_account = upsert_internal_user(user, pwd)
        if _parse_bool_env("AUTO_MEASURE_REQUIRE_STAFF_MFA", False):
            secret = str(internal_account.get("mfa_secret") or "")
            if not secret:
                raise HTTPException(status_code=428, detail="Staff MFA enrollment is required.")
            if not verify_totp(secret, str(mfa_code or "")):
                raise HTTPException(status_code=428, detail="Enter the 6-digit authenticator code.")
        return _issue_session(internal_account)

    if not account and not configured_credentials:
        config_error = _shared_auth_config_error()
        if config_error:
            raise HTTPException(status_code=503, detail=config_error)
    secrets.compare_digest(pwd, "shared-auth-placeholder")
    record_login_failure(user)
    raise HTTPException(status_code=401, detail="Invalid username or password.")


def register_shared_user(
    *,
    email: str,
    password: str,
    display_name: str,
    organization_name: str,
    terms_version: str,
) -> dict[str, Any]:
    if not _parse_bool_env("AUTO_MEASURE_ALLOW_PUBLIC_SIGNUP", True):
        raise HTTPException(status_code=403, detail="New account registration is currently closed.")
    try:
        account = create_customer_account(
            email=email,
            password=password,
            display_name=display_name,
            organization_name=organization_name,
            terms_version=terms_version,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    verification_expiry = (_now_utc() + timedelta(hours=24)).isoformat().replace("+00:00", "Z")
    verification_token = create_account_token(
        str(account["user_id"]), "verify_email", verification_expiry
    )
    try:
        send_action_email(
            recipient=str(account.get("email") or email),
            display_name=str(account.get("display_name") or display_name),
            action="verify",
            token=verification_token,
        )
    except Exception:
        if _parse_bool_env("AUTO_MEASURE_REQUIRE_EMAIL_VERIFICATION", False):
            raise HTTPException(
                status_code=503,
                detail="The account was created, but the verification email could not be sent.",
            )
    return _issue_session(account)


def request_password_reset(email: str) -> None:
    account = get_user_by_identifier(email)
    if not account or account.get("is_internal"):
        return
    expiry = (_now_utc() + timedelta(minutes=45)).isoformat().replace("+00:00", "Z")
    token = create_account_token(str(account["user_id"]), "password_reset", expiry)
    send_action_email(
        recipient=str(account.get("email") or email),
        display_name=str(account.get("display_name") or ""),
        action="reset",
        token=token,
    )


def confirm_password_reset(token: str, password: str) -> bool:
    account = consume_account_token(token, "password_reset")
    if not account:
        return False
    update_user_password(str(account["user_id"]), password)
    return True


def confirm_email_verification(token: str) -> bool:
    account = consume_account_token(token, "verify_email")
    if not account:
        return False
    mark_email_verified(str(account["user_id"]))
    return True


def resend_email_verification(email: str) -> None:
    account = get_user_by_identifier(email)
    if not account or account.get("email_verified_at") or account.get("is_internal"):
        return
    expiry = (_now_utc() + timedelta(hours=24)).isoformat().replace("+00:00", "Z")
    token = create_account_token(str(account["user_id"]), "verify_email", expiry)
    send_action_email(
        recipient=str(account.get("email") or email),
        display_name=str(account.get("display_name") or ""),
        action="verify",
        token=token,
    )


def begin_mfa_setup(session: dict[str, Any]) -> dict[str, str]:
    secret = generate_secret()
    set_user_mfa(str(session["user_id"]), secret, False)
    return {
        "secret": secret,
        "otpauth_url": provisioning_url(secret, str(session.get("email") or session.get("username") or "user")),
    }


def confirm_mfa_setup(session: dict[str, Any], code: str) -> bool:
    account = get_user_by_identifier(str(session.get("username") or ""))
    secret = str((account or {}).get("mfa_secret") or "")
    if not secret or not verify_totp(secret, code):
        return False
    set_user_mfa(str(session["user_id"]), secret, True)
    delete_user_sessions(str(session["user_id"]))
    return True


def remove_mfa(session: dict[str, Any], code: str) -> bool:
    account = get_user_by_identifier(str(session.get("username") or ""))
    secret = str((account or {}).get("mfa_secret") or "")
    if not secret or not verify_totp(secret, code):
        return False
    set_user_mfa(str(session["user_id"]), None, False)
    return True


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


def require_shared_access(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    bearer = _parse_bearer_token(authorization)
    token = bearer or str(request.cookies.get("pt_session") or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Login required.")
    session = _read_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    session["auth_via"] = "bearer" if bearer else "cookie"
    return session


def require_workspace_access(
    session: dict[str, Any] = Depends(require_shared_access),
) -> dict[str, Any]:
    if (
        _parse_bool_env("AUTO_MEASURE_REQUIRE_EMAIL_VERIFICATION", False)
        and not session.get("is_staff")
        and not session.get("email_verified")
    ):
        raise HTTPException(status_code=403, detail="Verify your email before using the workspace.")
    if not session.get("workspace_access"):
        raise HTTPException(
            status_code=402,
            detail="An active Property Takeoff subscription is required.",
        )
    return session


def require_verified_access(
    session: dict[str, Any] = Depends(require_shared_access),
) -> dict[str, Any]:
    if (
        _parse_bool_env("AUTO_MEASURE_REQUIRE_EMAIL_VERIFICATION", False)
        and not session.get("is_staff")
        and not session.get("email_verified")
    ):
        raise HTTPException(status_code=403, detail="Verify your email before continuing.")
    return session


def require_staff_access(
    session: dict[str, Any] = Depends(require_shared_access),
) -> dict[str, Any]:
    if not session.get("is_staff"):
        raise HTTPException(status_code=403, detail="Staff access is required.")
    return session


def require_ai_access(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    production = str(os.getenv("AUTO_MEASURE_ENV", "")).strip().lower() in {
        "prod",
        "production",
    } or _parse_bool_env("RENDER", False)
    enforce = _parse_bool_env("AUTO_MEASURE_REQUIRE_AI_AUTH", production)
    bearer = _parse_bearer_token(authorization)
    if not bearer and not enforce:
        return {"username": "local-development", "ai_access": True, "is_staff": True}
    token = bearer or str(request.cookies.get("pt_session") or "").strip()
    session = _read_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Login required for AI/CV tools.")
    if not session.get("ai_access"):
        raise HTTPException(status_code=403, detail="AI/CV tools are not included in this plan.")
    return session
