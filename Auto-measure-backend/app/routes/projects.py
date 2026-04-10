import json
import re
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from app.schemas import (
    SharedProjectDeleteResponse,
    SharedProjectRecord,
    SharedProjectSummary,
    SharedProjectUpsertRequest,
)

router = APIRouter(prefix="/projects", tags=["projects"])

PROJECTS_DIR = Path(__file__).resolve().parents[2] / "data" / "shared_projects"
MAX_PROJECTS_LIMIT = 500
PROJECT_ID_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _normalize_project_id(value: str) -> str:
    text = str(value or "").strip()
    text = PROJECT_ID_RE.sub("-", text).strip("-_.")
    if not text:
        text = f"project-{int(datetime.now(UTC).timestamp())}"
    return text[:180]


def _parse_saved_at(value: str | None, fallback: str) -> str:
    text = str(value or "").strip()
    if not text:
        return fallback
    try:
        normalized = text.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
    except Exception:
        return fallback


def _project_path(project_id: str) -> Path:
    safe_id = _normalize_project_id(project_id)
    return PROJECTS_DIR / f"{safe_id}.json"


def _count_payload_polygons(payload: dict) -> int:
    layer_features = payload.get("layerFeatures")
    if not isinstance(layer_features, dict):
        return 0
    total = 0
    for layer in ("plowable", "sidewalks", "turf", "mulch"):
        value = layer_features.get(layer)
        if isinstance(value, list):
            total += len(value)
    return max(0, total)


def _payload_has_boundary(payload: dict) -> bool:
    boundary = payload.get("boundary")
    if not isinstance(boundary, dict):
        return False
    geometry = boundary.get("geometry")
    if not isinstance(geometry, dict):
        return False
    return geometry.get("type") in {"Polygon", "MultiPolygon"}


def _read_record(path: Path) -> dict | None:
    try:
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw)
        if isinstance(value, dict):
            return value
    except Exception:
        return None
    return None


def _to_summary(record: dict, project_id: str) -> SharedProjectSummary:
    payload = record.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}
    project_name = str(record.get("project_name") or payload_dict.get("projectName") or "").strip()
    if not project_name:
        project_name = "Untitled Project"
    saved_at = _parse_saved_at(
        str(record.get("saved_at") or payload_dict.get("savedAt") or "").strip(),
        _now_iso(),
    )
    polygon_count = record.get("polygon_count")
    if not isinstance(polygon_count, int):
        polygon_count = _count_payload_polygons(payload_dict)
    has_boundary = record.get("has_boundary")
    if not isinstance(has_boundary, bool):
        has_boundary = _payload_has_boundary(payload_dict)
    return SharedProjectSummary(
        id=_normalize_project_id(project_id),
        project_name=project_name,
        saved_at=saved_at,
        polygon_count=max(0, int(polygon_count)),
        has_boundary=bool(has_boundary),
    )


@router.get("", response_model=list[SharedProjectSummary])
def list_shared_projects(
    limit: int = Query(100, ge=1, le=MAX_PROJECTS_LIMIT),
) -> list[SharedProjectSummary]:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    summaries: list[SharedProjectSummary] = []
    for path in PROJECTS_DIR.glob("*.json"):
        record = _read_record(path)
        if not record:
            continue
        project_id = path.stem
        try:
            summaries.append(_to_summary(record, project_id))
        except Exception:
            # Keep listing robust even if one saved file is malformed.
            continue
    summaries.sort(key=lambda item: item.saved_at, reverse=True)
    return summaries[:limit]


@router.get("/{project_id}", response_model=SharedProjectRecord)
def get_shared_project(project_id: str) -> SharedProjectRecord:
    path = _project_path(project_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Shared project '{project_id}' not found.")
    record = _read_record(path)
    if not record:
        raise HTTPException(status_code=500, detail="Shared project file is unreadable.")
    summary = _to_summary(record, path.stem)
    payload = record.get("payload")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="Shared project payload is invalid.")
    return SharedProjectRecord(
        id=summary.id,
        project_name=summary.project_name,
        saved_at=summary.saved_at,
        polygon_count=summary.polygon_count,
        has_boundary=summary.has_boundary,
        payload=payload,
    )


@router.put("/{project_id}", response_model=SharedProjectSummary)
def upsert_shared_project(project_id: str, body: SharedProjectUpsertRequest) -> SharedProjectSummary:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    normalized_id = _normalize_project_id(project_id or body.id)
    now_iso = _now_iso()
    saved_at = _parse_saved_at(body.saved_at, now_iso)
    polygon_count = (
        int(body.polygon_count)
        if isinstance(body.polygon_count, int)
        else _count_payload_polygons(body.payload)
    )
    has_boundary = (
        bool(body.has_boundary)
        if isinstance(body.has_boundary, bool)
        else _payload_has_boundary(body.payload)
    )
    project_name = str(body.project_name or body.payload.get("projectName") or "").strip()
    if not project_name:
        project_name = "Untitled Project"

    record = {
        "id": normalized_id,
        "project_name": project_name,
        "saved_at": saved_at,
        "polygon_count": max(0, polygon_count),
        "has_boundary": has_boundary,
        "payload": body.payload,
    }

    path = _project_path(normalized_id)
    temp_path = path.with_suffix(".json.tmp")
    temp_path.write_text(json.dumps(record, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    temp_path.replace(path)

    return _to_summary(record, normalized_id)


@router.delete("/{project_id}", response_model=SharedProjectDeleteResponse)
def delete_shared_project(project_id: str) -> SharedProjectDeleteResponse:
    path = _project_path(project_id)
    if not path.exists():
        return SharedProjectDeleteResponse(deleted=False)
    path.unlink(missing_ok=True)
    return SharedProjectDeleteResponse(deleted=True)
