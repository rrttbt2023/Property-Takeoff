from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


MeasurementType = Literal[
    "lawn_area",
    "driveway_area",
    "sidewalk_length",
    "parking_lot_area",
    "plow_route_length",
]


class Point(BaseModel):
    x: float = Field(..., description="X coordinate in image/map space")
    y: float = Field(..., description="Y coordinate in image/map space")


class MeasurementRequest(BaseModel):
    image_url: str = Field(..., min_length=5)
    measurement_type: MeasurementType
    known_distance_ft: float = Field(..., gt=0)
    known_distance_pixels: float = Field(
        100.0,
        gt=0,
        description="Pixel length in the image that corresponds to known_distance_ft",
    )

    @field_validator("image_url")
    @classmethod
    def image_url_must_look_like_url(cls, value: str) -> str:
        if not value.startswith(("http://", "https://", "upload://", "geojson://")):
            raise ValueError("image_url must start with http://, https://, upload://, or geojson://")
        return value


class GeoJsonMeasurementRequest(BaseModel):
    measurement_type: MeasurementType
    geometry: dict[str, Any] = Field(..., description="GeoJSON geometry object")
    known_distance_ft: float = Field(1.0, gt=0)
    known_distance_pixels: float = Field(1.0, gt=0)


class AutoClassifyRequest(BaseModel):
    boundary_geometry: dict[str, Any]
    candidate_plowable_geometry: dict[str, Any] | None = None
    candidate_sidewalk_geometry: dict[str, Any] | None = None
    candidate_turf_geometry: dict[str, Any] | None = None
    candidate_mulch_geometry: dict[str, Any] | None = None
    candidate_buildings_geometry: dict[str, Any] | None = None


class AutoClassifyResponse(BaseModel):
    plowable_geometry: dict[str, Any] | None = None
    sidewalks_geometry: dict[str, Any] | None = None
    turf_geometry: dict[str, Any] | None = None
    mulch_geometry: dict[str, Any] | None = None
    notes: list[str] = []


class SegmentationClassResult(BaseModel):
    polygons: list[list[Point]]
    confidence: float = Field(..., ge=0, le=1)


class SegmentationResponse(BaseModel):
    plowable: SegmentationClassResult
    sidewalks: SegmentationClassResult
    turf: SegmentationClassResult
    mulch: SegmentationClassResult
    notes: list[str] = []


class MeasurementResponse(BaseModel):
    total_area_sqft: float
    total_length_ft: float
    confidence: float = Field(..., ge=0, le=1)
    polygons: list[list[Point]]
    lines: list[list[Point]]
    notes: list[str]


class PixelDistanceRequest(BaseModel):
    point_a: Point
    point_b: Point


class PixelDistanceResponse(BaseModel):
    pixel_distance: float = Field(..., gt=0)


class MeasurementRecord(BaseModel):
    id: int
    created_at: str
    image_url: str
    measurement_type: MeasurementType
    known_distance_ft: float
    known_distance_pixels: float
    total_area_sqft: float
    total_length_ft: float
    confidence: float = Field(..., ge=0, le=1)
    polygons: list[list[Point]]
    lines: list[list[Point]]
    notes: list[str]


class SharedProjectSummary(BaseModel):
    id: str
    project_name: str
    saved_at: str
    polygon_count: int = Field(0, ge=0)
    has_boundary: bool = False


class SharedProjectRecord(SharedProjectSummary):
    payload: dict[str, Any]


class SharedProjectUpsertRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=180)
    project_name: str = Field("", max_length=240)
    saved_at: str | None = None
    polygon_count: int | None = Field(None, ge=0)
    has_boundary: bool | None = None
    payload: dict[str, Any]


class SharedProjectDeleteResponse(BaseModel):
    deleted: bool


class SharedAuthLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=120)
    password: str = Field(..., min_length=1, max_length=240)


class SharedAuthLoginResponse(BaseModel):
    token: str
    username: str
    expires_at: str


class SharedAuthSessionResponse(BaseModel):
    authenticated: bool = True
    username: str
    expires_at: str


class SharedAuthLogoutResponse(BaseModel):
    ok: bool = True
