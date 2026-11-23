import math
from typing import Any


PROPERTY_TYPE_MULTIPLIERS = {
    "commercial_retail": 1.00,
    "industrial_warehouse": 0.90,
    "hoa_multifamily": 1.15,
    "office_medical": 1.00,
    "school_campus": 1.25,
    "municipal": 1.20,
    "other": 1.10,
}

SERVICE_RATES_PER_10K_SQFT_CENTS = {
    "plowable pavement": 900,
    "sidewalks": 700,
    "turf": 750,
    "landscape beds": 850,
    "other": 650,
}

SERVICE_ALIASES = {
    "plowable": "plowable pavement",
    "pavement": "plowable pavement",
    "parking": "plowable pavement",
    "sidewalk": "sidewalks",
    "walkways": "sidewalks",
    "lawn": "turf",
    "lawns": "turf",
    "mulch": "landscape beds",
    "landscape": "landscape beds",
    "landscaping": "landscape beds",
}

SQ_METERS_TO_SQ_FEET = 10.76391041671
EARTH_RADIUS_METERS = 6_371_008.8


def _round_to_five_dollars(value: float) -> int:
    return max(0, int(round(value / 500.0) * 500))


def _normalized_services(service_types: list[Any]) -> list[str]:
    normalized: list[str] = []
    for value in service_types:
        candidate = str(value or "").strip().lower()
        if not candidate:
            continue
        candidate = SERVICE_ALIASES.get(candidate, candidate)
        if candidate not in SERVICE_RATES_PER_10K_SQFT_CENTS:
            candidate = "other"
        if candidate not in normalized:
            normalized.append(candidate)
    return normalized or ["other"]


def _coordinate_pair(value: Any) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) < 2:
        raise ValueError("Boundary contains an invalid coordinate.")
    longitude = float(value[0])
    latitude = float(value[1])
    if not math.isfinite(longitude) or not math.isfinite(latitude):
        raise ValueError("Boundary contains a non-finite coordinate.")
    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        raise ValueError("Boundary contains a coordinate outside valid longitude or latitude ranges.")
    return longitude, latitude


def _ring_area_square_meters(ring: Any) -> float:
    if not isinstance(ring, list) or len(ring) < 4:
        raise ValueError("Boundary rings must contain at least four coordinates.")
    coordinates = [_coordinate_pair(point) for point in ring]
    if coordinates[0] != coordinates[-1]:
        raise ValueError("Boundary rings must be closed.")
    latitude_origin = math.radians(
        sum(latitude for _, latitude in coordinates) / len(coordinates)
    )
    projected = [
        (
            math.radians(longitude) * EARTH_RADIUS_METERS * math.cos(latitude_origin),
            math.radians(latitude) * EARTH_RADIUS_METERS,
        )
        for longitude, latitude in coordinates
    ]
    twice_area = 0.0
    for index, (x1, y1) in enumerate(projected):
        x2, y2 = projected[(index + 1) % len(projected)]
        twice_area += x1 * y2 - x2 * y1
    return abs(twice_area) * 0.5


def _polygon_area_square_meters(coordinates: Any) -> float:
    if not isinstance(coordinates, list) or not coordinates:
        raise ValueError("Boundary polygon coordinates are missing.")
    outer_area = _ring_area_square_meters(coordinates[0])
    hole_area = sum(_ring_area_square_meters(ring) for ring in coordinates[1:])
    return max(0.0, outer_area - hole_area)


def boundary_square_feet(boundary: dict[str, Any]) -> int:
    """Calculate a customer quote area from Polygon or MultiPolygon GeoJSON."""
    if not isinstance(boundary, dict):
        raise ValueError("Draw a property boundary before requesting an estimate.")
    geometry = boundary.get("geometry") if boundary.get("type") == "Feature" else boundary
    if not isinstance(geometry, dict):
        raise ValueError("Boundary GeoJSON does not contain geometry.")
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        square_meters = _polygon_area_square_meters(coordinates)
    elif geometry_type == "MultiPolygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("Boundary multipolygon coordinates are missing.")
        square_meters = sum(
            _polygon_area_square_meters(polygon) for polygon in coordinates
        )
    else:
        raise ValueError("Boundary must be a Polygon or MultiPolygon.")
    square_feet = int(round(square_meters * SQ_METERS_TO_SQ_FEET))
    if square_feet < 1_000:
        raise ValueError("Draw a boundary of at least 1,000 square feet.")
    if square_feet > 100_000_000:
        raise ValueError("The drawn boundary exceeds the 100,000,000 square foot limit.")
    return square_feet


def estimate_takeoff_quote(
    *,
    property_type: str,
    estimated_square_feet: int,
    service_types: list[Any],
) -> dict[str, Any]:
    safe_property_type = (
        property_type if property_type in PROPERTY_TYPE_MULTIPLIERS else "other"
    )
    safe_square_feet = max(1_000, min(100_000_000, int(estimated_square_feet)))
    services = _normalized_services(service_types)
    service_rate = sum(
        SERVICE_RATES_PER_10K_SQFT_CENTS[service] for service in services
    )
    area_blocks = max(1.0, safe_square_feet / 10_000.0)
    midpoint = 4_500 + (
        service_rate * area_blocks * PROPERTY_TYPE_MULTIPLIERS[safe_property_type]
    )
    midpoint_cents = max(9_500, _round_to_five_dollars(midpoint))
    low_cents = max(7_500, _round_to_five_dollars(midpoint_cents * 0.85))
    high_cents = max(low_cents + 2_500, _round_to_five_dollars(midpoint_cents * 1.20))
    return {
        "low_cents": low_cents,
        "high_cents": high_cents,
        "midpoint_cents": midpoint_cents,
        "currency": "USD",
        "estimated_square_feet": safe_square_feet,
        "property_type": safe_property_type,
        "service_types": services,
        "area_source": "boundary",
        "disclaimer": (
            "Planning estimate only. Final price is confirmed after boundary, imagery, "
            "requested layers, and site complexity are reviewed."
        ),
    }
