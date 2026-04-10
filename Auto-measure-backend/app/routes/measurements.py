import json
import math

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile

from app.repositories import measurement_repository
from app.schemas import (
    AutoClassifyRequest,
    AutoClassifyResponse,
    GeoJsonMeasurementRequest,
    MeasurementRecord,
    MeasurementRequest,
    MeasurementResponse,
    MeasurementType,
    PixelDistanceRequest,
    PixelDistanceResponse,
    SegmentationResponse,
)
from app.services.measurement_service import MeasurementService
from app.services.segmentation_service import SegmentationService

router = APIRouter(prefix="/measurements", tags=["measurements"])


@router.post("", response_model=MeasurementResponse)
def create_measurement(payload: MeasurementRequest) -> MeasurementResponse:
    result = MeasurementService.measure(payload)
    measurement_repository.save_measurement(payload=payload, result=result)
    return result


@router.post("/geojson", response_model=MeasurementResponse)
def create_measurement_geojson(payload: GeoJsonMeasurementRequest) -> MeasurementResponse:
    request_payload = MeasurementRequest(
        image_url="geojson://boundary",
        measurement_type=payload.measurement_type,
        known_distance_ft=payload.known_distance_ft,
        known_distance_pixels=payload.known_distance_pixels,
    )
    try:
        result = MeasurementService.measure_geojson(request_payload, payload.geometry)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    measurement_repository.save_measurement(payload=request_payload, result=result)
    return result


@router.post("/auto-classify", response_model=AutoClassifyResponse)
def auto_classify_measurement(payload: AutoClassifyRequest) -> AutoClassifyResponse:
    try:
        return MeasurementService.auto_classify_layers(
            boundary_geometry=payload.boundary_geometry,
            candidate_plowable_geometry=payload.candidate_plowable_geometry,
            candidate_sidewalk_geometry=payload.candidate_sidewalk_geometry,
            candidate_turf_geometry=payload.candidate_turf_geometry,
            candidate_mulch_geometry=payload.candidate_mulch_geometry,
            candidate_buildings_geometry=payload.candidate_buildings_geometry,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/calibrate/pixel-distance", response_model=PixelDistanceResponse)
def calculate_pixel_distance(payload: PixelDistanceRequest) -> PixelDistanceResponse:
    pixel_distance = math.dist(
        (payload.point_a.x, payload.point_a.y),
        (payload.point_b.x, payload.point_b.y),
    )
    if pixel_distance <= 0:
        raise HTTPException(status_code=422, detail="point_a and point_b cannot be identical.")
    return PixelDistanceResponse(pixel_distance=round(pixel_distance, 4))


@router.get("/history", response_model=list[MeasurementRecord])
def get_measurement_history(limit: int = Query(20, ge=1, le=200)) -> list[MeasurementRecord]:
    return measurement_repository.list_measurements(limit=limit)


@router.get("/{measurement_id}", response_model=MeasurementRecord)
def get_measurement_detail(measurement_id: int) -> MeasurementRecord:
    record = measurement_repository.get_measurement(measurement_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Measurement {measurement_id} not found.")
    return record


@router.post("/upload", response_model=MeasurementResponse)
async def create_measurement_upload(
    image: UploadFile = File(...),
    measurement_type: MeasurementType = Form(...),
    known_distance_ft: float = Form(..., gt=0),
    known_distance_pixels: float = Form(100.0, gt=0),
) -> MeasurementResponse:
    if image.content_type is None or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    payload = MeasurementRequest(
        image_url=f"upload://{image.filename or 'measurement-image'}",
        measurement_type=measurement_type,
        known_distance_ft=known_distance_ft,
        known_distance_pixels=known_distance_pixels,
    )
    result = MeasurementService.measure_uploaded(payload=payload, image_bytes=image_bytes)
    measurement_repository.save_measurement(payload=payload, result=result)
    return result


@router.post("/segment/upload", response_model=SegmentationResponse)
async def segment_upload(
    image: UploadFile = File(...),
    use_model: bool = Form(True),
    min_area_px: int = Form(60, ge=1, le=10000),
    boundary_geojson: str | None = Form(None),
) -> SegmentationResponse:
    if image.content_type is None or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image.")
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    if boundary_geojson:
        # Parsed for future clipping support in geo-referenced inference.
        try:
            json.loads(boundary_geojson)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=422, detail="boundary_geojson is not valid JSON.") from exc

    try:
        return SegmentationService.segment_uploaded(
            image_bytes=image_bytes,
            use_model=use_model,
            min_area_px=min_area_px,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
