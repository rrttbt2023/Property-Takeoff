import os
import secrets
import json
from datetime import UTC, datetime, timedelta
from threading import Lock

from fastapi import Header, HTTPException


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now_utc().isoformat().replace("+00:00", "Z")


def _session_ttl_hours() -> float:
    raw = str(os.getenv("AUTO_MEASURE_SHARED_AUTH_TTL_HOURS", "12")).strip()
    try:
        value = float(raw)
    except Exception:
        value = 12.0
    return min(168.0, max(0.25, value))


def _session_expiry() -> datetime:
    return _now_utc() + timedelta(hours=_session_ttl_hours())


def _configured_username() -> str:
    return str(os.getenv("AUTO_MEASURE_SHARED_AUTH_USER", "admin")).strip() or "admin"


def _configured_password() -> str:
    return str(os.getenv("AUTO_MEASURE_SHARED_AUTH_PASS", "changeme")).strip() or "changeme"


def _append_credential(credentials: dict[str, str], username: str, password: str) -> None:
    user = str(username or "").strip()
    pwd = str(password or "")
    if not user or not pwd:
        return
    if len(user) > 120:
        return
    credentials[user] = pwd


def _parse_credentials_json(raw: str) -> dict[str, str]:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception:
        return {}
    credentials: dict[str, str] = {}
    if isinstance(parsed, dict):
        for username, password in parsed.items():
            _append_credential(credentials, str(username), str(password))
        return credentials
    if isinstance(parsed, list):
        for item in parsed:
            if not isinstance(item, dict):
                continue
            _append_credential(credentials, item.get("username"), item.get("password"))
        return credentials
    return {}


def _parse_credentials_csv(raw: str) -> dict[str, str]:
    text = str(raw or "").strip()
    if not text:
        return {}
    credentials: dict[str, str] = {}
    for chunk in text.split(","):
        pair = str(chunk or "").strip()
        if not pair or ":" not in pair:
            continue
        username, password = pair.split(":", 1)
        _append_credential(credentials, username, password)
    return credentials


def _configured_credentials() -> dict[str, str]:
    credentials: dict[str, str] = {}
    raw_users_json = str(os.getenv("AUTO_MEASURE_SHARED_AUTH_USERS_JSON", "")).strip()
    raw_users = str(os.getenv("AUTO_MEASURE_SHARED_AUTH_USERS", "")).strip()
    raw_values = [raw_users_json, raw_users]
    for raw in raw_values:
        if not raw:
            continue
        json_creds = _parse_credentials_json(raw)
        if json_creds:
            credentials.update(json_creds)
            continue
        csv_creds = _parse_credentials_csv(raw)
        if csv_creds:
            credentials.update(csv_creds)
    if credentials:
        return credentials
    return {_configured_username(): _configured_password()}


def _parse_bearer_token(raw: str | None) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    if text.lower().startswith("bearer "):
        return text[7:].strip()
    return ""


_TOKEN_STORE: dict[str, dict[str, str]] = {}
_TOKEN_LOCK = Lock()


def _gc_expired_tokens() -> None:
    now = _now_utc()
    expired: list[str] = []
    for token, session in _TOKEN_STORE.items():
        expires_at = str(session.get("expires_at") or "")
        try:
            parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except Exception:
            expired.append(token)
            continue
        if parsed <= now:
            expired.append(token)
    for token in expired:
        _TOKEN_STORE.pop(token, None)


def login_shared_user(username: str, password: str) -> dict[str, str]:
    user = str(username or "").strip()
    pwd = str(password or "")
    configured_credentials = _configured_credentials()
    expected_password = configured_credentials.get(user)
    if not expected_password:
        # Keep timing behavior closer to a valid compare.
        secrets.compare_digest(pwd, _configured_password())
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    if not secrets.compare_digest(pwd, expected_password):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = secrets.token_urlsafe(36)
    expires_at = _session_expiry().isoformat().replace("+00:00", "Z")
    session = {"token": token, "username": user, "expires_at": expires_at}
    with _TOKEN_LOCK:
        _gc_expired_tokens()
        _TOKEN_STORE[token] = session
    return session


def logout_shared_user(token: str) -> None:
    with _TOKEN_LOCK:
        _TOKEN_STORE.pop(str(token or "").strip(), None)


def _read_session(token: str) -> dict[str, str] | None:
    if not token:
        return None
    with _TOKEN_LOCK:
        _gc_expired_tokens()
        session = _TOKEN_STORE.get(token)
        if not session:
            return None
        return {
            "token": str(session.get("token") or ""),
            "username": str(session.get("username") or ""),
            "expires_at": str(session.get("expires_at") or _now_iso()),
        }


def require_shared_access(authorization: str | None = Header(default=None)) -> dict[str, str]:
    token = _parse_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Login required for shared files.")
    session = _read_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    return session
