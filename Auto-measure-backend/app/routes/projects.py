import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.repositories.audit_repository import write_event
from app.repositories.project_repository import (
    ProjectRevisionConflictError,
    delete_record,
    get_record,
    get_version,
    list_records,
    list_versions,
    save_record,
)
from app.schemas import (
    SharedProjectDeleteResponse,
    SharedProjectRecord,
    SharedProjectSummary,
    SharedProjectUpsertRequest,
    SharedProjectVersionRecord,
    SharedProjectVersionSummary,
)
from app.services.shared_auth import require_shared_access

router = APIRouter(
    prefix="/projects",
    tags=["projects"],
)

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


def _parse_iso_strict(value: str | None) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")


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


def _to_summary(record: dict, project_id: str) -> SharedProjectSummary:
    payload = record.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}
    project_name = str(record.get("project_name") or payload_dict.get("projectName") or "").strip()
    if not project_name:
        project_name = "Untitled Project"
    saved_at_raw = _parse_saved_at(
        str(record.get("saved_at") or payload_dict.get("savedAt") or "").strip(),
        _now_iso(),
    )
    last_edited_at = _parse_saved_at(
        str(record.get("last_edited_at") or "").strip(),
        saved_at_raw,
    )
    saved_by = str(record.get("saved_by") or "").strip() or "unknown"
    polygon_count = record.get("polygon_count")
    if not isinstance(polygon_count, int):
        polygon_count = _count_payload_polygons(payload_dict)
    has_boundary = record.get("has_boundary")
    if not isinstance(has_boundary, bool):
        has_boundary = _payload_has_boundary(payload_dict)
    folder_name = str(payload_dict.get("folderName") or "").strip() or "Unfiled"
    workflow_mode = (
        "pdf"
        if str(payload_dict.get("workflowMode") or "").strip().lower() == "pdf"
        else "location"
    )
    return SharedProjectSummary(
        id=_normalize_project_id(project_id),
        project_name=project_name,
        saved_at=saved_at_raw,
        saved_by=saved_by,
        last_edited_at=last_edited_at,
        polygon_count=max(0, int(polygon_count)),
        has_boundary=bool(has_boundary),
        revision=max(1, int(record.get("revision") or 1)),
        folder_name=folder_name[:240],
        workflow_mode=workflow_mode,
    )


def _request_meta(request: Request) -> tuple[str, str]:
    forwarded = str(request.headers.get("x-forwarded-for", "")).split(",")[0].strip()
    client_ip = forwarded or str(request.client.host if request.client else "")
    user_agent = str(request.headers.get("user-agent", ""))
    return client_ip[:120], user_agent[:500]


def _write_audit_safe(**kwargs) -> None:
    try:
        write_event(**kwargs)
    except Exception:
        # Access audit must never block primary project flow.
        pass


@router.get("", response_model=list[SharedProjectSummary])
def list_shared_projects(
    limit: int = Query(100, ge=1, le=MAX_PROJECTS_LIMIT),
    _: dict[str, str] = Depends(require_shared_access),
) -> list[SharedProjectSummary]:
    summaries: list[SharedProjectSummary] = []
    for record in list_records(limit):
        try:
            summaries.append(_to_summary(record, str(record.get("id") or "")))
        except Exception:
            # Keep listing robust even if one migrated record is malformed.
            continue
    return summaries


@router.get("/{project_id}/versions", response_model=list[SharedProjectVersionSummary])
def list_shared_project_versions(
    project_id: str,
    limit: int = Query(100, ge=1, le=1000),
    _: dict[str, str] = Depends(require_shared_access),
) -> list[SharedProjectVersionSummary]:
    normalized_id = _normalize_project_id(project_id)
    return [
        SharedProjectVersionSummary(
            project_id=normalized_id,
            revision=max(1, int(item.get("revision") or 1)),
            created_at=str(item.get("created_at") or ""),
            saved_by=str(item.get("saved_by") or "unknown"),
            polygon_count=max(0, int(item.get("polygon_count") or 0)),
            has_boundary=bool(item.get("has_boundary")),
            project_name=str(item.get("project_name") or "Untitled Project"),
        )
        for item in list_versions(normalized_id, limit)
    ]


@router.get(
    "/{project_id}/versions/{revision}",
    response_model=SharedProjectVersionRecord,
)
def get_shared_project_version(
    project_id: str,
    revision: int,
    _: dict[str, str] = Depends(require_shared_access),
) -> SharedProjectVersionRecord:
    normalized_id = _normalize_project_id(project_id)
    record = get_version(normalized_id, revision)
    if not record:
        raise HTTPException(status_code=404, detail="Project revision not found.")
    return SharedProjectVersionRecord(
        project_id=normalized_id,
        revision=max(1, int(record.get("revision") or 1)),
        created_at=str(record.get("created_at") or ""),
        saved_by=str(record.get("saved_by") or "unknown"),
        polygon_count=max(0, int(record.get("polygon_count") or 0)),
        has_boundary=bool(record.get("has_boundary")),
        project_name=str(record.get("project_name") or "Untitled Project"),
        payload=record["payload"],
    )


@router.get("/{project_id}", response_model=SharedProjectRecord)
def get_shared_project(
    request: Request,
    project_id: str,
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedProjectRecord:
    username = str(session.get("username") or "unknown")
    ip_address, user_agent = _request_meta(request)
    normalized_id = _normalize_project_id(project_id)
    record = get_record(normalized_id)
    if not record:
        _write_audit_safe(
            username=username,
            action="project.open",
            outcome="not_found",
            resource=str(_normalize_project_id(project_id)),
            ip_address=ip_address,
            user_agent=user_agent,
        )
        raise HTTPException(status_code=404, detail=f"Shared project '{project_id}' not found.")
    summary = _to_summary(record, normalized_id)
    payload = record.get("payload")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="Shared project payload is invalid.")
    _write_audit_safe(
        username=username,
        action="project.open",
        outcome="success",
        resource=summary.id,
        ip_address=ip_address,
        user_agent=user_agent,
    )
    return SharedProjectRecord(
        id=summary.id,
        project_name=summary.project_name,
        saved_at=summary.saved_at,
        saved_by=summary.saved_by,
        last_edited_at=summary.last_edited_at,
        polygon_count=summary.polygon_count,
        has_boundary=summary.has_boundary,
        revision=summary.revision,
        payload=payload,
    )


@router.put("/{project_id}", response_model=SharedProjectSummary)
def upsert_shared_project(
    request: Request,
    project_id: str,
    body: SharedProjectUpsertRequest,
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedProjectSummary:
    normalized_id = _normalize_project_id(project_id or body.id)
    now_iso = _now_iso()
    saved_at = _parse_saved_at(body.saved_at, now_iso)
    saved_by = str(session.get("username") or "").strip() or "unknown"
    existing = get_record(normalized_id) or {}
    existing_summary = _to_summary(existing, normalized_id) if existing else None
    base_last_edited_at: str | None = None
    try:
        base_last_edited_at = _parse_iso_strict(body.base_last_edited_at)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="base_last_edited_at must be a valid ISO timestamp.",
        )

    if (
        existing_summary
        and (body.base_revision or base_last_edited_at)
        and not body.force_overwrite
        and (
            (body.base_revision and body.base_revision != existing_summary.revision)
            or (
                not body.base_revision
                and base_last_edited_at != str(existing_summary.last_edited_at or "")
            )
        )
    ):
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Shared project changed since you opened it.",
                "conflict": existing_summary.model_dump(),
            },
        )

    polygon_count = _count_payload_polygons(body.payload)
    if body.polygon_count is not None and int(body.polygon_count) != polygon_count:
        raise HTTPException(
            status_code=400,
            detail=(
                "polygon_count does not match the project payload. "
                "Refresh the project before saving again."
            ),
        )
    has_boundary = _payload_has_boundary(body.payload)
    if body.has_boundary is not None and bool(body.has_boundary) != has_boundary:
        raise HTTPException(
            status_code=400,
            detail="has_boundary does not match the project payload.",
        )
    if (
        existing_summary
        and existing_summary.polygon_count >= 20
        and polygon_count < max(2, int(existing_summary.polygon_count * 0.2))
        and not body.force_overwrite
    ):
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "Save blocked because the polygon count dropped unexpectedly. "
                    "Review the local project before forcing an overwrite."
                ),
                "code": "polygon_count_drop",
                "conflict": existing_summary.model_dump(),
            },
        )
    project_name = str(body.project_name or body.payload.get("projectName") or "").strip()
    if not project_name:
        project_name = "Untitled Project"

    record = {
        "id": normalized_id,
        "project_name": project_name,
        "saved_at": saved_at,
        "saved_by": saved_by,
        "last_edited_at": now_iso,
        "created_at": str(existing.get("created_at") or now_iso),
        "created_by": str(existing.get("created_by") or saved_by),
        "polygon_count": max(0, polygon_count),
        "has_boundary": has_boundary,
        "payload": body.payload,
    }

    try:
        saved_record = save_record(
            record,
            expected_revision=body.base_revision,
            force=body.force_overwrite,
        )
    except ProjectRevisionConflictError:
        current = get_record(normalized_id) or existing
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Shared project changed while this save was being written.",
                "conflict": _to_summary(current, normalized_id).model_dump(),
            },
        )

    ip_address, user_agent = _request_meta(request)
    _write_audit_safe(
        username=saved_by,
        action="project.save",
        outcome="success",
        resource=normalized_id,
        ip_address=ip_address,
        user_agent=user_agent,
        details={
            "polygon_count": int(record["polygon_count"]),
            "has_boundary": bool(record["has_boundary"]),
            "revision": int(saved_record.get("revision") or 1),
        },
    )

    return _to_summary(saved_record, normalized_id)


@router.delete("/{project_id}", response_model=SharedProjectDeleteResponse)
def delete_shared_project(
    request: Request,
    project_id: str,
    session: dict[str, str] = Depends(require_shared_access),
) -> SharedProjectDeleteResponse:
    normalized_id = _normalize_project_id(project_id)
    username = str(session.get("username") or "unknown")
    ip_address, user_agent = _request_meta(request)
    if not get_record(normalized_id):
        _write_audit_safe(
            username=username,
            action="project.delete",
            outcome="not_found",
            resource=normalized_id,
            ip_address=ip_address,
            user_agent=user_agent,
        )
        return SharedProjectDeleteResponse(deleted=False)
    deleted = delete_record(normalized_id)
    _write_audit_safe(
        username=username,
        action="project.delete",
        outcome="success",
        resource=normalized_id,
        ip_address=ip_address,
        user_agent=user_agent,
    )
    return SharedProjectDeleteResponse(deleted=deleted)
