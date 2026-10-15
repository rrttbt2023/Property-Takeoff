import os
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from app.repositories.takeoff_repository import (
    accept_quote,
    add_file,
    create_request,
    get_file,
    get_request,
    list_requests,
    update_request,
)
from app.repositories.project_repository import get_record as get_project_record
from app.repositories.project_repository import save_record as save_project_record
from app.schemas import (
    SharedProjectRecord,
    TakeoffFileRecord,
    TakeoffRequestCreate,
    TakeoffRequestRecord,
    TakeoffRequestUpdate,
)
from app.services.shared_auth import require_shared_access, require_staff_access


router = APIRouter(prefix="/takeoff-requests", tags=["takeoff requests"])
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
ALLOWED_UPLOAD_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".kml", ".kmz", ".json"}
SAFE_FILENAME_RE = re.compile(r"[^a-zA-Z0-9._-]+")
STAFF_STATUS_TRANSITIONS = {
    "submitted": {"reviewing", "quoted", "canceled"},
    "reviewing": {"quoted", "canceled"},
    "quoted": {"reviewing", "quoted", "canceled"},
    "accepted": {"in_progress", "canceled"},
    "in_progress": {"delivered", "canceled"},
    "delivered": set(),
    "canceled": {"reviewing"},
}


def _upload_root() -> Path:
    configured = os.getenv("AUTO_MEASURE_PRIVATE_UPLOAD_DIR", "./data/private_uploads")
    path = Path(configured).expanduser()
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def _request_for_session(request_id: str, session: dict) -> dict:
    return get_request(
        request_id,
        organization_id=str(session.get("organization_id") or ""),
        include_all=bool(session.get("is_staff")),
    )


@router.get("", response_model=list[TakeoffRequestRecord])
def list_takeoff_requests(
    limit: int = Query(100, ge=1, le=500),
    session: dict = Depends(require_shared_access),
) -> list[TakeoffRequestRecord]:
    return [
        TakeoffRequestRecord(**item)
        for item in list_requests(
            organization_id=str(session.get("organization_id") or ""),
            include_all=bool(session.get("is_staff")),
            limit=limit,
        )
    ]


@router.post("", response_model=TakeoffRequestRecord, status_code=201)
def create_takeoff_request(
    payload: TakeoffRequestCreate,
    session: dict = Depends(require_shared_access),
) -> TakeoffRequestRecord:
    if payload.boundary:
        geometry_type = str(payload.boundary.get("type") or "")
        if geometry_type not in {"Feature", "Polygon", "MultiPolygon"}:
            raise HTTPException(status_code=400, detail="Boundary must be valid GeoJSON.")
    item = create_request(
        organization_id=str(session.get("organization_id") or ""),
        user_id=str(session.get("user_id") or ""),
        title=payload.title.strip(),
        address=payload.address.strip(),
        service_types=[str(value).strip()[:80] for value in payload.service_types if str(value).strip()],
        boundary=payload.boundary,
        notes=payload.notes.strip(),
    )
    return TakeoffRequestRecord(**item)


@router.get("/{request_id}", response_model=TakeoffRequestRecord)
def get_takeoff_request(
    request_id: str,
    session: dict = Depends(require_shared_access),
) -> TakeoffRequestRecord:
    item = _request_for_session(request_id, session)
    if not item:
        raise HTTPException(status_code=404, detail="Takeoff request not found.")
    return TakeoffRequestRecord(**item)


@router.get("/{request_id}/delivery", response_model=SharedProjectRecord)
def get_takeoff_delivery(
    request_id: str,
    session: dict = Depends(require_shared_access),
) -> SharedProjectRecord:
    item = _request_for_session(request_id, session)
    if not item or item.get("status") != "delivered" or not item.get("delivered_project_id"):
        raise HTTPException(status_code=404, detail="Delivered measurements are not available yet.")
    project = get_project_record(
        str(item["delivered_project_id"]),
        str(item["organization_id"]),
    )
    if not project:
        raise HTTPException(status_code=404, detail="Delivered project file is unavailable.")
    payload = project.get("payload") if isinstance(project.get("payload"), dict) else {}
    return SharedProjectRecord(
        id=str(project.get("id") or ""),
        project_name=str(project.get("project_name") or "Completed Takeoff"),
        saved_at=str(project.get("saved_at") or ""),
        saved_by=str(project.get("saved_by") or "McKenna Site Management"),
        last_edited_at=str(project.get("last_edited_at") or ""),
        polygon_count=max(0, int(project.get("polygon_count") or 0)),
        has_boundary=bool(project.get("has_boundary")),
        revision=max(1, int(project.get("revision") or 1)),
        folder_name=str(payload.get("folderName") or "Delivered Takeoffs")[:240],
        workflow_mode="pdf" if str(payload.get("workflowMode") or "").lower() == "pdf" else "location",
        payload=payload,
    )


@router.post("/{request_id}/accept", response_model=TakeoffRequestRecord)
def accept_takeoff_quote(
    request_id: str,
    session: dict = Depends(require_shared_access),
) -> TakeoffRequestRecord:
    item = accept_quote(
        request_id,
        str(session.get("organization_id") or ""),
        str(session.get("user_id") or ""),
    )
    if not item:
        raise HTTPException(status_code=409, detail="This quote is not ready to accept.")
    return TakeoffRequestRecord(**item)


@router.patch("/{request_id}", response_model=TakeoffRequestRecord)
def update_takeoff_request(
    request_id: str,
    payload: TakeoffRequestUpdate,
    session: dict = Depends(require_staff_access),
) -> TakeoffRequestRecord:
    existing_request = get_request(request_id, include_all=True)
    if not existing_request:
        raise HTTPException(status_code=404, detail="Takeoff request not found.")
    delivered_project_id = payload.delivered_project_id
    if payload.status is not None:
        current_status = str(existing_request.get("status") or "submitted")
        if payload.status == "accepted":
            raise HTTPException(
                status_code=400,
                detail="Only the customer can accept a quote.",
            )
        allowed = STAFF_STATUS_TRANSITIONS.get(current_status, set())
        if payload.status not in allowed:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot change a takeoff from {current_status} to {payload.status}.",
            )
        if (
            payload.status == "quoted"
            and payload.quote_cents is None
            and existing_request.get("quote_cents") is None
        ):
            raise HTTPException(status_code=400, detail="Enter a quote amount before sending it.")
    if payload.status == "delivered":
        source_project_id = str(payload.delivered_project_id or "").strip()
        if not source_project_id:
            raise HTTPException(status_code=400, detail="Choose the completed project to deliver.")
        staff_organization_id = str(session.get("organization_id") or "")
        source_project = get_project_record(source_project_id, staff_organization_id)
        if not source_project:
            raise HTTPException(
                status_code=404,
                detail="The completed staff project could not be found.",
            )
        delivered_project_id = f"delivery-{request_id}"
        save_project_record(
            {**source_project, "id": delivered_project_id},
            organization_id=str(existing_request.get("organization_id") or ""),
            force=True,
        )
    item = update_request(
        request_id,
        actor_user_id=str(session.get("user_id") or ""),
        status=payload.status,
        quote_cents=payload.quote_cents,
        quote_notes=payload.quote_notes,
        delivery_notes=payload.delivery_notes,
        delivered_project_id=delivered_project_id,
    )
    if not item:
        raise HTTPException(status_code=404, detail="Takeoff request not found.")
    return TakeoffRequestRecord(**item)


@router.post("/{request_id}/files", response_model=TakeoffFileRecord, status_code=201)
async def upload_takeoff_file(
    request_id: str,
    upload: UploadFile = File(...),
    session: dict = Depends(require_shared_access),
) -> TakeoffFileRecord:
    item = _request_for_session(request_id, session)
    if not item:
        raise HTTPException(status_code=404, detail="Takeoff request not found.")
    original_name = Path(str(upload.filename or "upload")).name[:240]
    suffix = Path(original_name).suffix.lower()
    if suffix not in ALLOWED_UPLOAD_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail="Upload a PDF, image, KML, KMZ, or JSON boundary file.",
        )
    safe_stem = SAFE_FILENAME_RE.sub("-", Path(original_name).stem).strip("-_.")[:80] or "upload"
    storage_key = f"{request_id}/{secrets.token_hex(12)}-{safe_stem}{suffix}"
    destination = (_upload_root() / storage_key).resolve()
    root = _upload_root().resolve()
    if root not in destination.parents:
        raise HTTPException(status_code=400, detail="Invalid upload name.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with destination.open("wb") as output:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Files must be 25 MB or smaller.")
                output.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    if size == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    record = add_file(
        request_id=request_id,
        organization_id=str(item.get("organization_id") or ""),
        user_id=str(session.get("user_id") or ""),
        storage_key=storage_key,
        original_name=original_name,
        content_type=str(upload.content_type or "application/octet-stream")[:160],
        size_bytes=size,
    )
    return TakeoffFileRecord(**record)


@router.get("/{request_id}/files/{file_id}")
def download_takeoff_file(
    request_id: str,
    file_id: str,
    session: dict = Depends(require_shared_access),
) -> FileResponse:
    item = _request_for_session(request_id, session)
    file_record = get_file(file_id)
    if (
        not item
        or not file_record
        or str(file_record.get("request_id")) != str(request_id)
        or (
            not session.get("is_staff")
            and str(file_record.get("organization_id"))
            != str(session.get("organization_id") or "")
        )
    ):
        raise HTTPException(status_code=404, detail="File not found.")
    path = (_upload_root() / str(file_record["storage_key"])).resolve()
    if not path.is_file() or _upload_root().resolve() not in path.parents:
        raise HTTPException(status_code=404, detail="File is unavailable.")
    return FileResponse(
        path,
        media_type=str(file_record.get("content_type") or "application/octet-stream"),
        filename=str(file_record.get("original_name") or "download"),
    )
