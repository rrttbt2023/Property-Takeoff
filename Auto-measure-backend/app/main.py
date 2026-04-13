import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.repositories.measurement_repository import init_db
from app.routes.auth import router as auth_router
from app.routes.measurements import router as measurements_router
from app.routes.projects import router as projects_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Auto Measure Backend", lifespan=lifespan)


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
    ],
)
cors_allow_origin_regex = os.getenv(
    "AUTO_MEASURE_CORS_ALLOW_ORIGIN_REGEX",
    DEFAULT_CORS_ORIGIN_REGEX,
).strip() or None


app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allow_origins,
    allow_origin_regex=cors_allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def home() -> dict[str, str]:
    return {"message": "Auto Measure Backend Running"}


app.include_router(measurements_router)
app.include_router(measurements_router, prefix="/api")
app.include_router(auth_router)
app.include_router(auth_router, prefix="/api")
app.include_router(projects_router)
app.include_router(projects_router, prefix="/api")


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.exists():
    @app.get("/ui")
    @app.get("/ui/{full_path:path}")
    def serve_frontend(full_path: str = "") -> FileResponse:
        file_path = frontend_dist / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(frontend_dist / "index.html")
