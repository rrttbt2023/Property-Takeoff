from fastapi import APIRouter, Depends, HTTPException, Request

from app.repositories.audit_repository import write_event
from app.schemas import (
    SharedAuthLoginRequest,
    SharedAuthLoginResponse,
    SharedAuthLogoutResponse,
    SharedAuthRegisterRequest,
    SharedAuthSessionResponse,
)
from app.services.shared_auth import (
    login_shared_user,
    logout_shared_user,
    register_shared_user,
    require_shared_access,
)

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
    }
    if include_token:
        response["token"] = str(session.get("token") or "")
    return response


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
def shared_login(payload: SharedAuthLoginRequest, request: Request) -> SharedAuthLoginResponse:
    username = str(payload.username or "").strip() or "unknown"
    ip_address, user_agent = _request_meta(request)
    try:
        session = login_shared_user(payload.username, payload.password)
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
    return SharedAuthLoginResponse(**_auth_response(session, include_token=True))


@router.post("/register", response_model=SharedAuthLoginResponse, status_code=201)
def shared_register(
    payload: SharedAuthRegisterRequest,
    request: Request,
) -> SharedAuthLoginResponse:
    ip_address, user_agent = _request_meta(request)
    try:
        session = register_shared_user(
            email=payload.email,
            password=payload.password,
            display_name=payload.display_name.strip(),
            organization_name=payload.organization_name.strip(),
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
    return SharedAuthLoginResponse(**_auth_response(session, include_token=True))


@router.get("/session", response_model=SharedAuthSessionResponse)
def shared_session(
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedAuthSessionResponse:
    return SharedAuthSessionResponse(
        authenticated=True,
        **_auth_response(session, include_token=False),
    )


@router.post("/logout", response_model=SharedAuthLogoutResponse)
def shared_logout(
    request: Request,
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedAuthLogoutResponse:
    ip_address, user_agent = _request_meta(request)
    logout_shared_user(session["token"])
    _write_audit_safe(
        username=str(session.get("username") or "unknown"),
        action="auth.logout",
        outcome="success",
        ip_address=ip_address,
        user_agent=user_agent,
    )
    return SharedAuthLogoutResponse(ok=True)
