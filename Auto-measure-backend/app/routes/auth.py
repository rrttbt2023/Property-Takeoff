from fastapi import APIRouter, Depends

from app.schemas import (
    SharedAuthLoginRequest,
    SharedAuthLoginResponse,
    SharedAuthLogoutResponse,
    SharedAuthSessionResponse,
)
from app.services.shared_auth import (
    login_shared_user,
    logout_shared_user,
    require_shared_access,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=SharedAuthLoginResponse)
def shared_login(payload: SharedAuthLoginRequest) -> SharedAuthLoginResponse:
    session = login_shared_user(payload.username, payload.password)
    return SharedAuthLoginResponse(
        token=session["token"],
        username=session["username"],
        expires_at=session["expires_at"],
    )


@router.get("/session", response_model=SharedAuthSessionResponse)
def shared_session(
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedAuthSessionResponse:
    return SharedAuthSessionResponse(
        authenticated=True,
        username=session["username"],
        expires_at=session["expires_at"],
    )


@router.post("/logout", response_model=SharedAuthLogoutResponse)
def shared_logout(
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedAuthLogoutResponse:
    logout_shared_user(session["token"])
    return SharedAuthLogoutResponse(ok=True)
