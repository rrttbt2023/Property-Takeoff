import os
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, RedirectResponse

from app.repositories.takeoff_repository import (
    accept_quote,
    add_file,
    create_request,
    get_file,
    get_pricing_config,
    get_request,
    list_pricing_versions,
    list_requests,
    record_takeoff_checkout,
    update_request,
    update_pricing_config,
)
from app.repositories.project_repository import get_record as get_project_record
from app.repositories.project_repository import save_record as save_project_record
from app.schemas import (
    SharedProjectRecord,
    BillingSessionResponse,
    TakeoffFileRecord,
    TakeoffQuoteEstimateRequest,
    TakeoffQuoteEstimateResponse,
    TakeoffPricingConfig,
    TakeoffPricingConfigUpdate,
    TakeoffRequestCreate,
    TakeoffRequestRecord,
    TakeoffRequestUpdate,
)
from app.services.shared_auth import require_shared_access, require_staff_access, require_verified_access
from app.services.private_storage import (
    local_private_file,
    private_download_url,
    scan_file,
    store_private_file,
    temporary_upload_file,
    validate_file_content,
)
from app.services.takeoff_pricing import boundary_square_feet, estimate_takeoff_quote
from app.services.notifications import notify_organization
from app.routes.billing import _app_url, _object_value, _stripe_module


router = APIRouter(prefix="/takeoff-requests", tags=["takeoff requests"])
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
ALLOWED_UPLOAD_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".kml", ".kmz", ".json"}
UPLOAD_CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".kml": "application/vnd.google-earth.kml+xml",
    ".kmz": "application/vnd.google-earth.kmz",
    ".json": "application/json",
}
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


@router.post("/estimate", response_model=TakeoffQuoteEstimateResponse)
def estimate_takeoff_request(
    payload: TakeoffQuoteEstimateRequest,
    _: dict = Depends(require_shared_access),
) -> TakeoffQuoteEstimateResponse:
    try:
        estimated_square_feet = boundary_square_feet(payload.boundary)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return TakeoffQuoteEstimateResponse(
        **estimate_takeoff_quote(
            property_type=payload.property_type,
            estimated_square_feet=estimated_square_feet,
            service_types=payload.service_types,
            measurement_scope=payload.measurement_scope,
            pricing_config=get_pricing_config(),
        )
    )


@router.get("/pricing", response_model=TakeoffPricingConfig)
def read_takeoff_pricing(
    _: dict = Depends(require_staff_access),
) -> TakeoffPricingConfig:
    return TakeoffPricingConfig(**get_pricing_config())


@router.get("/pricing/versions", response_model=list[TakeoffPricingConfig])
def read_takeoff_pricing_versions(
    limit: int = Query(25, ge=1, le=100),
    _: dict = Depends(require_staff_access),
) -> list[TakeoffPricingConfig]:
    return [TakeoffPricingConfig(**item) for item in list_pricing_versions(limit)]


@router.patch("/pricing", response_model=TakeoffPricingConfig)
def save_takeoff_pricing(
    payload: TakeoffPricingConfigUpdate,
    session: dict = Depends(require_staff_access),
) -> TakeoffPricingConfig:
    return TakeoffPricingConfig(
        **update_pricing_config(
            payload.model_dump(),
            str(session.get("user_id") or session.get("username") or "staff"),
        )
    )


@router.post("", response_model=TakeoffRequestRecord, status_code=201)
def create_takeoff_request(
    payload: TakeoffRequestCreate,
    session: dict = Depends(require_verified_access),
) -> TakeoffRequestRecord:
    try:
        estimated_square_feet = boundary_square_feet(payload.boundary)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    service_types = [
        str(value).strip()[:80] for value in payload.service_types if str(value).strip()
    ]
    estimate = estimate_takeoff_quote(
        property_type=payload.property_type,
        estimated_square_feet=estimated_square_feet,
        service_types=service_types,
        measurement_scope=payload.measurement_scope,
        pricing_config=get_pricing_config(),
    )
    item = create_request(
        organization_id=str(session.get("organization_id") or ""),
        user_id=str(session.get("user_id") or ""),
        title=payload.title.strip(),
        address=payload.address.strip(),
        service_types=service_types,
        property_type=payload.property_type,
        measurement_scope=payload.measurement_scope,
        estimated_square_feet=estimated_square_feet,
        estimate_low_cents=int(estimate["low_cents"]),
        estimate_high_cents=int(estimate["high_cents"]),
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
    session: dict = Depends(require_verified_access),
) -> TakeoffRequestRecord:
    existing = _request_for_session(request_id, session)
    if (
        existing
        and int(existing.get("quote_cents") or 0) > 0
        and str(existing.get("payment_status") or "pending") != "paid"
        and bool(str(os.getenv("STRIPE_RESTRICTED_KEY") or os.getenv("STRIPE_SECRET_KEY") or "").strip())
    ):
        raise HTTPException(
            status_code=402,
            detail="Complete the quoted payment before work begins.",
        )
    item = accept_quote(
        request_id,
        str(session.get("organization_id") or ""),
        str(session.get("user_id") or ""),
    )
    if not item:
        raise HTTPException(status_code=409, detail="This quote is not ready to accept.")
    return TakeoffRequestRecord(**item)


@router.post("/{request_id}/checkout", response_model=BillingSessionResponse)
def create_takeoff_payment_checkout(
    request_id: str,
    session: dict = Depends(require_verified_access),
) -> BillingSessionResponse:
    item = _request_for_session(request_id, session)
    if not item or str(item.get("status")) != "quoted":
        raise HTTPException(status_code=409, detail="This takeoff is not ready for payment.")
    quote_cents = int(item.get("quote_cents") or 0)
    if quote_cents <= 0:
        raise HTTPException(status_code=409, detail="This quote does not require online payment.")
    if str(item.get("payment_status") or "") == "paid":
        raise HTTPException(status_code=409, detail="This quote has already been paid.")
    stripe = _stripe_module()
    organization_id = str(session.get("organization_id") or "")
    checkout = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "unit_amount": quote_cents,
                "product_data": {"name": f"Managed Takeoff - {str(item.get('title') or 'Property')}"},
            },
            "quantity": 1,
        }],
        customer_email=str(session.get("email") or "") or None,
        client_reference_id=organization_id,
        metadata={
            "organization_id": organization_id,
            "takeoff_request_id": str(request_id),
        },
        payment_intent_data={
            "metadata": {
                "organization_id": organization_id,
                "takeoff_request_id": str(request_id),
            }
        },
        automatic_tax={"enabled": str(os.getenv("STRIPE_AUTOMATIC_TAX", "false")).lower() in {"1", "true", "yes"}},
        billing_address_collection="auto",
        consent_collection={"terms_of_service": "required"},
        success_url=f"{_app_url()}/?takeoff_payment=success",
        cancel_url=f"{_app_url()}/?takeoff_payment=canceled",
    )
    checkout_id = str(_object_value(checkout, "id") or "")
    url = str(_object_value(checkout, "url") or "")
    if not checkout_id or not url:
        raise HTTPException(status_code=502, detail="Stripe did not return a checkout session.")
    record_takeoff_checkout(request_id, checkout_id)
    return BillingSessionResponse(url=url)


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
        assigned_to=payload.assigned_to,
        priority=payload.priority,
    )
    if not item:
        raise HTTPException(status_code=404, detail="Takeoff request not found.")
    if payload.status == "quoted":
        notify_organization(
            str(item.get("organization_id") or ""),
            subject="Your managed takeoff quote is ready",
            heading="Your quote is ready",
            message=f"McKenna reviewed {item.get('title') or 'your property'} and posted a final quote in your workspace.",
        )
    elif payload.status == "delivered":
        notify_organization(
            str(item.get("organization_id") or ""),
            subject="Your Property Takeoff measurements are ready",
            heading="Measurements delivered",
            message=f"The completed measurements for {item.get('title') or 'your property'} are ready to download.",
        )
    return TakeoffRequestRecord(**item)


@router.post("/{request_id}/files", response_model=TakeoffFileRecord, status_code=201)
async def upload_takeoff_file(
    request_id: str,
    upload: UploadFile = File(...),
    session: dict = Depends(require_verified_access),
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
    handle, temporary_path = temporary_upload_file()
    size = 0
    try:
        with handle as output:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Files must be 25 MB or smaller.")
                output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")
        validate_file_content(temporary_path, suffix)
        scan_file(temporary_path)
        verified_content_type = UPLOAD_CONTENT_TYPES[suffix]
        store_private_file(
            temporary_path,
            storage_key,
            verified_content_type,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception:
        raise
    finally:
        temporary_path.unlink(missing_ok=True)
    record = add_file(
        request_id=request_id,
        organization_id=str(item.get("organization_id") or ""),
        user_id=str(session.get("user_id") or ""),
        storage_key=storage_key,
        original_name=original_name,
        content_type=UPLOAD_CONTENT_TYPES[suffix],
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
    download_url = private_download_url(
        str(file_record["storage_key"]),
        str(file_record.get("original_name") or "download"),
    )
    if download_url:
        return RedirectResponse(download_url, status_code=307)
    path = local_private_file(str(file_record["storage_key"]))
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="File is unavailable.")
    return FileResponse(
        path,
        media_type=str(file_record.get("content_type") or "application/octet-stream"),
        filename=str(file_record.get("original_name") or "download"),
    )
