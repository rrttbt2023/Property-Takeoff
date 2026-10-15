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


class SegmentationDiagnostics(BaseModel):
    engine: str = "heuristic"
    model_loaded: bool = False
    model_version: str | None = None
    model_error: str | None = None
    tiled_inference: bool = False
    tile_size: int | None = Field(None, ge=1)
    tile_overlap: int | None = Field(None, ge=0)
    tile_count: int = Field(0, ge=0)
    mean_confidence: float = Field(0.0, ge=0, le=1)
    uncertain_fraction: float = Field(0.0, ge=0, le=1)


class SegmentationResponse(BaseModel):
    plowable: SegmentationClassResult
    sidewalks: SegmentationClassResult
    turf: SegmentationClassResult
    mulch: SegmentationClassResult
    uncertain_polygons: list[list[Point]] = Field(default_factory=list)
    diagnostics: SegmentationDiagnostics = Field(default_factory=SegmentationDiagnostics)
    notes: list[str] = Field(default_factory=list)


class SegmentationCorrectionResponse(BaseModel):
    sample_id: str
    stored_at: str
    storage_path: str


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
    saved_by: str | None = None
    last_edited_at: str | None = None
    polygon_count: int = Field(0, ge=0)
    has_boundary: bool = False
    revision: int = Field(1, ge=1)
    folder_name: str = Field("Unfiled", max_length=240)
    workflow_mode: str = Field("location", pattern="^(location|pdf)$")


class SharedProjectRecord(SharedProjectSummary):
    payload: dict[str, Any]


class SharedProjectUpsertRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=180)
    project_name: str = Field("", max_length=240)
    saved_at: str | None = None
    polygon_count: int | None = Field(None, ge=0)
    has_boundary: bool | None = None
    base_last_edited_at: str | None = None
    base_revision: int | None = Field(None, ge=1)
    force_overwrite: bool = False
    payload: dict[str, Any]


class SharedProjectDeleteResponse(BaseModel):
    deleted: bool


class SharedProjectVersionSummary(BaseModel):
    project_id: str
    revision: int = Field(..., ge=1)
    created_at: str
    saved_by: str
    polygon_count: int = Field(0, ge=0)
    has_boundary: bool = False
    project_name: str


class SharedProjectVersionRecord(SharedProjectVersionSummary):
    payload: dict[str, Any]


class SharedAuthLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=120)
    password: str = Field(..., min_length=1, max_length=240)


class SharedAuthRegisterRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=254)
    password: str = Field(..., min_length=10, max_length=240)
    display_name: str = Field(..., min_length=2, max_length=120)
    organization_name: str = Field(..., min_length=2, max_length=180)

    @field_validator("email")
    @classmethod
    def email_must_look_valid(cls, value: str) -> str:
        normalized = str(value or "").strip().lower()
        if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
            raise ValueError("Enter a valid email address")
        return normalized

    @field_validator("password")
    @classmethod
    def password_must_be_strong(cls, value: str) -> str:
        password = str(value or "")
        if not any(char.isalpha() for char in password) or not any(
            char.isdigit() for char in password
        ):
            raise ValueError("Password must include at least one letter and one number")
        return password


class SharedAuthLoginResponse(BaseModel):
    token: str
    username: str
    expires_at: str
    email: str = ""
    display_name: str = ""
    role: str = "member"
    organization_id: str = ""
    organization_name: str = "Workspace"
    subscription_status: str = "inactive"
    workspace_access: bool = False
    ai_access: bool = False
    is_staff: bool = False


class SharedAuthSessionResponse(BaseModel):
    authenticated: bool = True
    username: str
    expires_at: str
    email: str = ""
    display_name: str = ""
    role: str = "member"
    organization_id: str = ""
    organization_name: str = "Workspace"
    subscription_status: str = "inactive"
    workspace_access: bool = False
    ai_access: bool = False
    is_staff: bool = False


class SharedAuthLogoutResponse(BaseModel):
    ok: bool = True


class BillingStatusResponse(BaseModel):
    subscription_status: str
    workspace_access: bool
    plan_name: str = "Property Takeoff Basic"
    price_display: str = "$9.99/month"
    current_period_end: str | None = None
    cancel_at_period_end: bool = False
    customer_portal_available: bool = False


class BillingSessionResponse(BaseModel):
    url: str


TakeoffRequestStatus = Literal[
    "submitted",
    "reviewing",
    "quoted",
    "accepted",
    "in_progress",
    "delivered",
    "canceled",
]


class TakeoffRequestCreate(BaseModel):
    title: str = Field(..., min_length=2, max_length=180)
    address: str = Field(..., min_length=3, max_length=300)
    service_types: list[str] = Field(default_factory=list, max_length=20)
    boundary: dict[str, Any] | None = None
    notes: str = Field("", max_length=5000)


class TakeoffRequestUpdate(BaseModel):
    status: TakeoffRequestStatus | None = None
    quote_cents: int | None = Field(None, ge=0, le=10_000_000)
    quote_notes: str | None = Field(None, max_length=5000)
    delivery_notes: str | None = Field(None, max_length=5000)
    delivered_project_id: str | None = Field(None, max_length=180)


class TakeoffFileRecord(BaseModel):
    id: str
    original_name: str
    content_type: str
    size_bytes: int = Field(..., ge=0)
    created_at: str


class TakeoffRequestRecord(BaseModel):
    id: str
    organization_id: str
    organization_name: str = ""
    created_by: str
    title: str
    address: str
    service_types: list[str] = Field(default_factory=list)
    boundary: dict[str, Any] | None = None
    notes: str = ""
    status: TakeoffRequestStatus
    quote_cents: int | None = None
    quote_notes: str = ""
    quoted_at: str | None = None
    accepted_at: str | None = None
    due_at: str | None = None
    delivered_at: str | None = None
    delivery_notes: str = ""
    delivered_project_id: str | None = None
    created_at: str
    updated_at: str
    files: list[TakeoffFileRecord] = Field(default_factory=list)


class SecurityAuditEvent(BaseModel):
    id: int
    created_at: str
    username: str
    action: str
    outcome: str
    resource: str
    ip_address: str
    user_agent: str
    details: dict[str, Any] = Field(default_factory=dict)
