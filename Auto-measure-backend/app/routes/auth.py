import os
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.repositories.audit_repository import write_event
from app.repositories.account_repository import (
    delete_customer_account,
    get_user_by_id,
    verify_password,
)
from app.repositories.project_repository import (
    delete_organization_records,
    list_records as list_project_records,
)
from app.repositories.takeoff_repository import (
    delete_organization_requests,
    list_organization_storage_keys,
    list_requests as list_takeoff_requests,
)
from app.schemas import (
    AccountDeleteRequest,
    AuthEmailRequest,
    AuthTokenRequest,
    MfaCodeRequest,
    MfaSetupResponse,
    PasswordResetConfirmRequest,
    SharedAuthLoginRequest,
    SharedAuthLoginResponse,
    SharedAuthLogoutResponse,
    SharedAuthRegisterRequest,
    SharedAuthSessionResponse,
)
from app.services.shared_auth import (
    begin_mfa_setup,
    confirm_email_verification,
    confirm_mfa_setup,
    confirm_password_reset,
    login_shared_user,
    logout_shared_user,
    register_shared_user,
    remove_mfa,
    request_password_reset,
    resend_email_verification,
    require_shared_access,
)
from app.services.rate_limit import client_ip, enforce_rate_limit
from app.services.private_storage import delete_private_file

router = APIRouter(prefix="/auth", tags=["auth"])


def _auth_response(session: dict, *, include_token: bool) -> dict:
    response = {
        "username": str(session.get("username") or ""),
        "email": str(session.get("email") or ""),
        "display_name": str(session.get("display_name") or session.get("username") or ""),
        "role": str(session.get("role") or "member"),
        "organization_id": str(session.get("organization_id") or ""),
        "organization_name": str(session.get("organization_name") or "Workspace"),
        "subscription_status": str(session.get("subscription_status") or "inactive"),
        "workspace_access": bool(session.get("workspace_access")),
        "ai_access": bool(session.get("ai_access")),
        "is_staff": bool(session.get("is_staff")),
        "expires_at": str(session.get("expires_at") or ""),
        "csrf_token": str(session.get("csrf_token") or ""),
        "authenticated": True,
        "email_verified": bool(session.get("email_verified")),
        "mfa_enabled": bool(session.get("mfa_enabled")),
    }
    if include_token:
        response["token"] = str(session.get("token") or "")
    return response


def _set_session_cookie(response: Response, token: str) -> None:
    production = str(os.getenv("AUTO_MEASURE_ENV", "")).strip().lower() in {"prod", "production"}
    response.set_cookie(
        key="pt_session",
        value=str(token),
        max_age=int(float(os.getenv("AUTO_MEASURE_SHARED_AUTH_TTL_HOURS", "168")) * 3600),
        httponly=True,
        secure=production,
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key="pt_session",
        path="/",
        secure=str(os.getenv("AUTO_MEASURE_ENV", "")).strip().lower() in {"prod", "production"},
        samesite="lax",
    )


def _verify_bot_token(token: str | None, request: Request) -> None:
    secret = str(os.getenv("AUTO_MEASURE_TURNSTILE_SECRET_KEY", "")).strip()
    if not secret:
        return
    if not str(token or "").strip():
        raise HTTPException(status_code=400, detail="Complete the anti-bot check.")
    try:
        result = httpx.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data={"secret": secret, "response": str(token), "remoteip": client_ip(request)},
            timeout=8,
        ).json()
    except Exception as error:
        raise HTTPException(status_code=503, detail="The anti-bot check is temporarily unavailable.") from error
    if not result.get("success"):
        raise HTTPException(status_code=400, detail="The anti-bot check was not accepted.")


def _request_meta(request: Request) -> tuple[str, str]:
    forwarded = str(request.headers.get("x-forwarded-for", "")).split(",")[0].strip()
    client_ip = forwarded or str(request.client.host if request.client else "")
    user_agent = str(request.headers.get("user-agent", ""))
    return client_ip[:120], user_agent[:500]


def _write_audit_safe(**kwargs) -> None:
    try:
        write_event(**kwargs)
    except Exception:
        # Access audit must never block primary auth flow.
        pass


@router.post("/login", response_model=SharedAuthLoginResponse)
def shared_login(
    payload: SharedAuthLoginRequest,
    request: Request,
    response: Response,
) -> SharedAuthLoginResponse:
    username = str(payload.username or "").strip() or "unknown"
    ip_address, user_agent = _request_meta(request)
    enforce_rate_limit(f"login-ip:{ip_address}", limit=20, window_seconds=900)
    enforce_rate_limit(f"login-user:{username.lower()}", limit=10, window_seconds=900)
    try:
        session = login_shared_user(payload.username, payload.password, payload.mfa_code)
    except HTTPException:
        _write_audit_safe(
            username=username,
            action="auth.login",
            outcome="failure",
            ip_address=ip_address,
            user_agent=user_agent,
        )
        raise
    _write_audit_safe(
        username=username,
        action="auth.login",
        outcome="success",
        ip_address=ip_address,
        user_agent=user_agent,
    )
    _set_session_cookie(response, str(session.get("token") or ""))
    return SharedAuthLoginResponse(**_auth_response(session, include_token=True))


@router.post("/register", response_model=SharedAuthLoginResponse, status_code=201)
def shared_register(
    payload: SharedAuthRegisterRequest,
    request: Request,
    response: Response,
) -> SharedAuthLoginResponse:
    ip_address, user_agent = _request_meta(request)
    enforce_rate_limit(f"register-ip:{ip_address}", limit=5, window_seconds=3600)
    _verify_bot_token(payload.bot_token, request)
    try:
        session = register_shared_user(
            email=payload.email,
            password=payload.password,
            display_name=payload.display_name.strip(),
            organization_name=payload.organization_name.strip(),
            terms_version=str(os.getenv("AUTO_MEASURE_LEGAL_VERSION", "2026-11-19")).strip(),
        )
    except HTTPException:
        _write_audit_safe(
            username=payload.email,
            action="auth.register",
            outcome="failure",
            ip_address=ip_address,
            user_agent=user_agent,
        )
        raise
    _write_audit_safe(
        username=payload.email,
        action="auth.register",
        outcome="success",
        resource=str(session.get("organization_id") or ""),
        ip_address=ip_address,
        user_agent=user_agent,
    )
    _set_session_cookie(response, str(session.get("token") or ""))
    return SharedAuthLoginResponse(**_auth_response(session, include_token=True))


@router.get("/session", response_model=SharedAuthSessionResponse)
def shared_session(
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedAuthSessionResponse:
    return SharedAuthSessionResponse(**_auth_response(session, include_token=False))


@router.post("/logout", response_model=SharedAuthLogoutResponse)
def shared_logout(
    request: Request,
    response: Response,
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedAuthLogoutResponse:
    ip_address, user_agent = _request_meta(request)
    logout_shared_user(session["token"])
    _clear_session_cookie(response)
    _write_audit_safe(
        username=str(session.get("username") or "unknown"),
        action="auth.logout",
        outcome="success",
        ip_address=ip_address,
        user_agent=user_agent,
    )
    return SharedAuthLogoutResponse(ok=True)


@router.post("/password/forgot")
def forgot_password(payload: AuthEmailRequest, request: Request) -> dict[str, bool]:
    enforce_rate_limit(f"password-forgot:{client_ip(request)}", limit=5, window_seconds=3600)
    try:
        request_password_reset(payload.email.strip().lower())
    except Exception:
        # Keep the response generic so account existence and email-provider state are private.
        pass
    return {"ok": True}


@router.post("/password/reset")
def reset_password(payload: PasswordResetConfirmRequest, request: Request) -> dict[str, bool]:
    enforce_rate_limit(f"password-reset:{client_ip(request)}", limit=10, window_seconds=3600)
    if not confirm_password_reset(payload.token, payload.password):
        raise HTTPException(status_code=400, detail="This password reset link is invalid or expired.")
    return {"ok": True}


@router.post("/email/verify")
def verify_email(payload: AuthTokenRequest, request: Request) -> dict[str, bool]:
    enforce_rate_limit(f"email-verify:{client_ip(request)}", limit=20, window_seconds=3600)
    if not confirm_email_verification(payload.token):
        raise HTTPException(status_code=400, detail="This verification link is invalid or expired.")
    return {"ok": True}


@router.post("/email/resend")
def resend_verification(payload: AuthEmailRequest, request: Request) -> dict[str, bool]:
    enforce_rate_limit(f"email-resend:{client_ip(request)}", limit=4, window_seconds=3600)
    try:
        resend_email_verification(payload.email.strip().lower())
    except Exception:
        pass
    return {"ok": True}


@router.post("/mfa/setup", response_model=MfaSetupResponse)
def setup_mfa(session: dict = Depends(require_shared_access)) -> MfaSetupResponse:
    return MfaSetupResponse(**begin_mfa_setup(session))


@router.post("/mfa/confirm")
def confirm_mfa(payload: MfaCodeRequest, session: dict = Depends(require_shared_access)) -> dict[str, bool]:
    if not confirm_mfa_setup(session, payload.code):
        raise HTTPException(status_code=400, detail="The authenticator code was not accepted.")
    return {"ok": True}


@router.post("/mfa/remove")
def disable_mfa(payload: MfaCodeRequest, session: dict = Depends(require_shared_access)) -> dict[str, bool]:
    if not remove_mfa(session, payload.code):
        raise HTTPException(status_code=400, detail="The authenticator code was not accepted.")
    return {"ok": True}


@router.get("/account/export")
def export_account(session: dict = Depends(require_shared_access)) -> dict:
    organization_id = str(session.get("organization_id") or "")
    projects = list_project_records(limit=10_000, organization_id=organization_id)
    takeoffs = list_takeoff_requests(
        organization_id=organization_id,
        include_all=False,
        limit=10_000,
    )
    return {
        "exported_at": datetime.now(UTC).isoformat(),
        "account": {
            "email": session.get("email"),
            "display_name": session.get("display_name"),
            "organization_id": organization_id,
            "organization_name": session.get("organization_name"),
            "subscription_status": session.get("subscription_status"),
        },
        "projects": projects,
        "takeoff_requests": takeoffs,
    }


@router.delete("/account")
def delete_account(
    payload: AccountDeleteRequest,
    request: Request,
    response: Response,
    session: dict = Depends(require_shared_access),
) -> dict[str, bool]:
    if session.get("is_staff"):
        raise HTTPException(status_code=403, detail="Internal staff accounts cannot be deleted here.")
    account = get_user_by_id(str(session.get("user_id") or ""))
    if not account or not verify_password(payload.password, str(account.get("password_hash") or "")):
        raise HTTPException(status_code=403, detail="Password confirmation failed.")
    organization_id = str(session.get("organization_id") or "")
    storage_keys = list_organization_storage_keys(organization_id)
    storage_delete_failures = []
    for storage_key in storage_keys:
        try:
            delete_private_file(storage_key)
        except Exception:
            storage_delete_failures.append(storage_key)
    if storage_delete_failures:
        raise HTTPException(
            status_code=503,
            detail="Private uploads could not be removed. No account data was deleted; please retry.",
        )
    delete_organization_requests(organization_id)
    delete_organization_records(organization_id)
    deleted = delete_customer_account(str(session.get("user_id") or ""))
    if not deleted:
        raise HTTPException(status_code=409, detail="Account deletion could not be completed.")
    _clear_session_cookie(response)
    _write_audit_safe(
        username=str(session.get("username") or "unknown"),
        action="account.delete",
        outcome="success",
        resource=organization_id,
        ip_address=client_ip(request),
        user_agent=str(request.headers.get("user-agent", ""))[:500],
    )
    return {"ok": True}
    AuthEmailRequest,
    AuthTokenRequest,
    MfaCodeRequest,
    MfaSetupResponse,
    PasswordResetConfirmRequest,
