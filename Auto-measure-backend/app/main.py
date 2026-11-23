import os
import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from app.repositories.account_repository import init_db as init_account_db
from app.repositories.audit_repository import init_db as init_audit_db
from app.repositories.measurement_repository import init_db
from app.repositories.project_repository import init_db as init_project_db
from app.repositories.takeoff_repository import init_db as init_takeoff_db
from app.repositories.database import connect_database, database_backend
from app.routes.audit import router as audit_router
from app.routes.auth import router as auth_router
from app.routes.billing import router as billing_router
from app.routes.measurements import router as measurements_router
from app.routes.projects import router as projects_router
from app.routes.takeoffs import router as takeoffs_router
from app.services.email_service import email_configured
from app.services.private_storage import malware_scanner_available, storage_backend, storage_ready
from app.services.shared_auth import validate_csrf_token


logger = logging.getLogger("property_takeoff")


def _configure_monitoring() -> None:
    dsn = str(os.getenv("SENTRY_DSN", "")).strip()
    if not dsn:
        return
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            environment=str(os.getenv("AUTO_MEASURE_ENV", "development")),
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
            send_default_pii=False,
        )
    except Exception:
        logger.exception("Monitoring initialization failed")


_configure_monitoring()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    init_account_db()
    init_audit_db()
    init_project_db()
    init_takeoff_db()
    yield


def _parse_bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


_env_name = os.getenv("AUTO_MEASURE_ENV", "").strip().lower()
_is_production = _env_name in {"prod", "production"} or _parse_bool_env("RENDER", False)
_enable_docs = _parse_bool_env("AUTO_MEASURE_ENABLE_DOCS", default=not _is_production)

app = FastAPI(
    title="Auto Measure Backend",
    lifespan=lifespan,
    docs_url="/docs" if _enable_docs else None,
    redoc_url="/redoc" if _enable_docs else None,
    openapi_url="/openapi.json" if _enable_docs else None,
)


def _parse_csv_env(name: str, default: list[str]) -> list[str]:
    raw = os.getenv(name, "")
    if not raw.strip():
        return default
    values: list[str] = []
    for item in raw.split(","):
        candidate = item.strip()
        if candidate and candidate not in values:
            values.append(candidate)
    return values or default


DEFAULT_CORS_ORIGIN_REGEX = (
    r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$"
    r"|^https://[a-z0-9-]+\.vercel\.app$"
    r"|^https://[a-z0-9-]+\.onrender\.com$"
)
cors_allow_origins = _parse_csv_env(
    "AUTO_MEASURE_CORS_ALLOW_ORIGINS",
    [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://mckennasitemanagement.vercel.app",
    ],
)
cors_allow_origin_regex = os.getenv(
    "AUTO_MEASURE_CORS_ALLOW_ORIGIN_REGEX",
    "" if _is_production else DEFAULT_CORS_ORIGIN_REGEX,
).strip() or None


app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allow_origins,
    allow_origin_regex=cors_allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


CSRF_EXEMPT_PATHS = {
    "/auth/login",
    "/api/auth/login",
    "/auth/register",
    "/api/auth/register",
    "/auth/password/forgot",
    "/api/auth/password/forgot",
    "/auth/password/reset",
    "/api/auth/password/reset",
    "/auth/email/verify",
    "/api/auth/email/verify",
    "/auth/email/resend",
    "/api/auth/email/resend",
    "/billing/webhook",
    "/api/billing/webhook",
}


@app.middleware("http")
async def protect_cookie_sessions(request: Request, call_next):
    local_ai_route = (
        not _is_production
        and request.url.path.startswith(("/measurements", "/api/measurements"))
        and not _parse_bool_env("AUTO_MEASURE_REQUIRE_AI_AUTH", False)
    )
    if (
        request.method.upper() not in {"GET", "HEAD", "OPTIONS"}
        and request.url.path not in CSRF_EXEMPT_PATHS
        and request.cookies.get("pt_session")
        and not str(request.headers.get("authorization", "")).lower().startswith("bearer ")
        and not local_ai_route
    ):
        session_token = str(request.cookies.get("pt_session") or "")
        candidate = str(request.headers.get("x-csrf-token") or "")
        if not validate_csrf_token(session_token, candidate):
            return JSONResponse(status_code=403, content={"detail": "Invalid CSRF token."})
    return await call_next(request)


@app.middleware("http")
async def request_observability(request: Request, call_next):
    request_id = str(request.headers.get("x-request-id") or uuid.uuid4().hex)[:80]
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("request_failed method=%s path=%s request_id=%s", request.method, request.url.path, request_id)
        raise
    duration_ms = (time.perf_counter() - started) * 1000
    response.headers.setdefault("X-Request-ID", request_id)
    logger.info(
        "request_complete method=%s path=%s status=%s duration_ms=%.1f request_id=%s",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
        request_id,
    )
    return response


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy",
        "geolocation=(), microphone=(), camera=()",
    )
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    response.headers.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
    if request.headers.get("x-forwarded-proto", "").lower() == "https":
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains",
        )
    return response


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _readiness_checks() -> dict[str, bool]:
    production = _is_production
    database_healthy = True
    if production:
        try:
            with connect_database() as connection:
                database_healthy = connection.execute("SELECT 1 AS ready").fetchone() is not None
        except Exception:
            database_healthy = False
    backup_bucket = str(os.getenv("AUTO_MEASURE_BACKUP_S3_BUCKET", "")).strip()
    backup_access_key = str(os.getenv("AUTO_MEASURE_BACKUP_S3_ACCESS_KEY_ID", "")).strip()
    backup_secret_key = str(os.getenv("AUTO_MEASURE_BACKUP_S3_SECRET_ACCESS_KEY", "")).strip()
    backup_object_storage = bool(backup_bucket) and bool(backup_access_key) == bool(backup_secret_key) and (
        bool(backup_access_key and backup_secret_key)
        or _parse_bool_env("AUTO_MEASURE_BACKUP_S3_USE_IAM_ROLE", False)
    )
    backups_configured = _parse_bool_env("AUTO_MEASURE_BACKUPS_CONFIGURED", False) and (
        backup_object_storage or _parse_bool_env("AUTO_MEASURE_MANAGED_DATABASE_BACKUPS", False)
    )
    return {
        "database_managed": not production
        or (database_backend() == "postgresql" and database_healthy),
        "private_object_storage": not production
        or (storage_backend() == "s3" and storage_ready(probe=True)),
        "malware_scan_required": not production
        or (
            str(os.getenv("AUTO_MEASURE_UPLOAD_SCAN_MODE", "")).lower() == "required"
            and malware_scanner_available()
        ),
        "transactional_email": not production or email_configured(),
        "stripe_configured": not production
        or all(
            str(os.getenv(name, "")).strip()
            for name in ("STRIPE_BASIC_PRICE_ID", "STRIPE_WEBHOOK_SECRET")
        )
        and bool(str(os.getenv("STRIPE_RESTRICTED_KEY") or os.getenv("STRIPE_SECRET_KEY") or "").strip()),
        "password_pepper": not production
        or len(str(os.getenv("AUTO_MEASURE_PASSWORD_PEPPER", ""))) >= 48,
        "csrf_secret": not production or len(str(os.getenv("AUTO_MEASURE_CSRF_SECRET", ""))) >= 48,
        "email_verification_required": not production
        or _parse_bool_env("AUTO_MEASURE_REQUIRE_EMAIL_VERIFICATION", False),
        "staff_mfa_required": not production
        or _parse_bool_env("AUTO_MEASURE_REQUIRE_STAFF_MFA", False),
        "monitoring": not production or bool(str(os.getenv("SENTRY_DSN", "")).strip()),
        "backups_configured": not production or backups_configured,
    }


@app.get("/api/ready")
def readiness():
    checks = _readiness_checks()
    ready = all(checks.values())
    return JSONResponse(
        status_code=200 if ready else 503,
        content={"status": "ready" if ready else "not_ready", "checks": checks},
    )


@app.get("/")
def home() -> dict[str, str]:
    return {"message": "Auto Measure Backend Running"}


app.include_router(measurements_router)
app.include_router(measurements_router, prefix="/api")
app.include_router(auth_router)
app.include_router(auth_router, prefix="/api")
app.include_router(projects_router)
app.include_router(projects_router, prefix="/api")
app.include_router(audit_router)
app.include_router(audit_router, prefix="/api")
app.include_router(billing_router)
app.include_router(billing_router, prefix="/api")
app.include_router(takeoffs_router)
app.include_router(takeoffs_router, prefix="/api")


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.exists():
    @app.get("/ui")
    @app.get("/ui/{full_path:path}")
    def serve_frontend(full_path: str = "") -> FileResponse:
        file_path = frontend_dist / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(frontend_dist / "index.html")
