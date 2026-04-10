import math
from typing import Any

import httpx
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry
from shapely.validation import make_valid

from app.schemas import AutoClassifyResponse, MeasurementRequest, MeasurementResponse, Point

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover - fallback path if CV deps are missing
    cv2 = None
    np = None


class MeasurementService:
    """CV-backed measurement service with deterministic fallback."""

    @staticmethod
    def measure(payload: MeasurementRequest) -> MeasurementResponse:
        if cv2 is None or np is None:
            fallback = MeasurementService._mock_measurement(payload)
            fallback.notes.insert(0, "OpenCV dependencies are not installed; returning mock output.")
            return fallback

        try:
            image = MeasurementService._download_image(payload.image_url)
            return MeasurementService._measure_from_image(image=image, payload=payload)
        except Exception as exc:
            fallback = MeasurementService._mock_measurement(payload)
            fallback.notes.insert(0, f"CV measurement failed; fallback used: {exc}")
            return fallback

    @staticmethod
    def measure_uploaded(payload: MeasurementRequest, image_bytes: bytes) -> MeasurementResponse:
        if cv2 is None or np is None:
            fallback = MeasurementService._mock_measurement(payload)
            fallback.notes.insert(0, "OpenCV dependencies are not installed; returning mock output.")
            return fallback

        try:
            image = MeasurementService._decode_image_bytes(image_bytes)
            return MeasurementService._measure_from_image(image=image, payload=payload)
        except Exception as exc:
            fallback = MeasurementService._mock_measurement(payload)
            fallback.notes.insert(0, f"CV upload measurement failed; fallback used: {exc}")
            return fallback

    @staticmethod
    def measure_geojson(payload: MeasurementRequest, geometry: dict[str, Any]) -> MeasurementResponse:
        geom_type = geometry.get("type")
        if geom_type not in {"Polygon", "MultiPolygon", "LineString", "MultiLineString"}:
            raise ValueError("geometry must be Polygon, MultiPolygon, LineString, or MultiLineString.")

        area_sqm = 0.0
        length_m = 0.0
        polygons: list[list[Point]] = []
        lines: list[list[Point]] = []

        if geom_type == "Polygon":
            area_sqm = MeasurementService._polygon_area_sqm(geometry["coordinates"])
            length_m = MeasurementService._polygon_perimeter_m(geometry["coordinates"])
            polygons = [MeasurementService._ring_to_points(geometry["coordinates"][0])]
        elif geom_type == "MultiPolygon":
            for polygon_coords in geometry["coordinates"]:
                area_sqm += MeasurementService._polygon_area_sqm(polygon_coords)
                length_m += MeasurementService._polygon_perimeter_m(polygon_coords)
                if polygon_coords:
                    polygons.append(MeasurementService._ring_to_points(polygon_coords[0]))
        elif geom_type == "LineString":
            length_m = MeasurementService._line_length_m(geometry["coordinates"])
            lines = [MeasurementService._ring_to_points(geometry["coordinates"])]
        elif geom_type == "MultiLineString":
            for line_coords in geometry["coordinates"]:
                length_m += MeasurementService._line_length_m(line_coords)
                lines.append(MeasurementService._ring_to_points(line_coords))

        area_sqft = round(area_sqm * 10.7639104167097, 2)
        length_ft = round(length_m * 3.280839895, 2)

        is_area_type = "area" in payload.measurement_type
        is_length_type = "length" in payload.measurement_type

        return MeasurementResponse(
            total_area_sqft=area_sqft if is_area_type else 0.0,
            total_length_ft=length_ft if is_length_type else 0.0,
            confidence=0.94,
            polygons=polygons if is_area_type else [],
            lines=lines if is_length_type else [],
            notes=[
                "Measured directly from uploaded KML/GeoJSON geometry.",
                "No image contour detection was used for this result.",
            ],
        )

    @staticmethod
    def auto_classify_layers(
        *,
        boundary_geometry: dict[str, Any],
        candidate_plowable_geometry: dict[str, Any] | None,
        candidate_sidewalk_geometry: dict[str, Any] | None,
        candidate_turf_geometry: dict[str, Any] | None,
        candidate_mulch_geometry: dict[str, Any] | None,
        candidate_buildings_geometry: dict[str, Any] | None,
    ) -> AutoClassifyResponse:
        notes: list[str] = []
        boundary = MeasurementService._shape_or_none(boundary_geometry)
        if boundary is None or boundary.is_empty:
            raise ValueError("boundary_geometry is invalid or empty.")
        boundary_area = max(float(boundary.area), 1e-12)

        plowable_candidate = MeasurementService._shape_or_none(candidate_plowable_geometry)
        sidewalks = MeasurementService._shape_or_none(candidate_sidewalk_geometry)
        turf_geom = MeasurementService._shape_or_none(candidate_turf_geometry)
        mulch = MeasurementService._shape_or_none(candidate_mulch_geometry)
        buildings = MeasurementService._shape_or_none(candidate_buildings_geometry)

        if plowable_candidate is not None:
            plowable = plowable_candidate
            notes.append("Using plowable candidate geometry as base.")
        else:
            plowable = MeasurementService._clip(boundary, boundary)
            notes.append("No plowable candidate provided; using boundary as base.")

        sidewalks = MeasurementService._clip(sidewalks, boundary)
        turf_geom = MeasurementService._clip(turf_geom, boundary)
        mulch = MeasurementService._clip(mulch, boundary)
        plowable_candidate = MeasurementService._clip(plowable_candidate, boundary)
        buildings = MeasurementService._clip(buildings, boundary)
        plowable = MeasurementService._clip(plowable, boundary)

        if buildings is not None:
            plowable = MeasurementService._subtract(plowable, buildings)
            sidewalks = MeasurementService._subtract(sidewalks, buildings)
            turf_geom = MeasurementService._subtract(turf_geom, buildings)
            mulch = MeasurementService._subtract(mulch, buildings)
            notes.append("Subtracted building footprints from all layers.")

        if turf_geom is not None and plowable_candidate is not None:
            turf_geom = MeasurementService._subtract(turf_geom, plowable_candidate)
            notes.append("Trimmed turf using plowable candidate to reduce overestimation.")

        if turf_geom is not None:
            turf_geom = MeasurementService._clip(turf_geom, boundary)
            turf_ratio_explicit = (
                float(turf_geom.area) / boundary_area
                if turf_geom is not None and not turf_geom.is_empty
                else 0.0
            )
            plowable_ratio = (
                float(plowable_candidate.area) / boundary_area
                if plowable_candidate is not None and not plowable_candidate.is_empty
                else 0.0
            )
            if turf_ratio_explicit > 0.45:
                notes.append(
                    f"Explicit turf candidate too large ({round(turf_ratio_explicit * 100)}%); turf discarded."
                )
                turf_geom = None
            elif plowable_candidate is not None and plowable_ratio < 0.15 and turf_ratio_explicit > 0.2:
                notes.append(
                    f"Rejected turf candidate because plowable coverage is too low ({round(plowable_ratio * 100)}%)."
                )
                turf_geom = None

        if sidewalks is not None:
            plowable = MeasurementService._subtract(plowable, sidewalks)
            turf_geom = MeasurementService._subtract(turf_geom, sidewalks)
            notes.append("Separated sidewalks from plowable.")

        if mulch is not None:
            mulch = MeasurementService._subtract(mulch, sidewalks)
            mulch = MeasurementService._subtract(mulch, turf_geom)
            plowable = MeasurementService._subtract(plowable, mulch)
            notes.append("Applied provided mulch candidate and removed overlaps.")

        if turf_geom is None:
            if plowable_candidate is not None:
                plowable_ratio = float(plowable_candidate.area) / boundary_area
                if plowable_ratio < 0.18:
                    notes.append(
                        f"No explicit turf candidate and plowable coverage too low ({round(plowable_ratio * 100)}%); turf left empty."
                    )
                    plowable = MeasurementService._clip(plowable, boundary)
                    return AutoClassifyResponse(
                        plowable_geometry=MeasurementService._geometry_mapping_or_none(plowable),
                        sidewalks_geometry=MeasurementService._geometry_mapping_or_none(sidewalks),
                        turf_geometry=MeasurementService._geometry_mapping_or_none(turf_geom),
                        mulch_geometry=MeasurementService._geometry_mapping_or_none(mulch),
                        notes=notes,
                    )

                derived_turf = MeasurementService._subtract(boundary, plowable_candidate)
                derived_turf = MeasurementService._subtract(derived_turf, sidewalks)
                derived_turf = MeasurementService._subtract(derived_turf, buildings)
                derived_turf = MeasurementService._subtract(derived_turf, mulch)
                derived_turf = MeasurementService._clip(derived_turf, boundary)

                try:
                    if derived_turf is not None:
                        # Remove very thin slivers introduced by line buffering/topology.
                        smoothed = MeasurementService._make_valid(
                            derived_turf.buffer(-1e-5).buffer(1e-5)
                        )
                        if smoothed is not None and not smoothed.is_empty:
                            derived_turf = smoothed
                except Exception:
                    pass

                turf_ratio = (
                    float(derived_turf.area) / boundary_area
                    if derived_turf is not None and not derived_turf.is_empty
                    else 0.0
                )
                if 0.01 <= turf_ratio <= 0.65:
                    turf_geom = derived_turf
                    notes.append(
                        f"No explicit turf candidate; derived turf from residual area ({round(turf_ratio * 100)}% of boundary)."
                    )
                elif turf_ratio > 0.65:
                    notes.append(
                        f"Residual turf estimate too large ({round(turf_ratio * 100)}%); turf left empty."
                    )
                else:
                    notes.append("No explicit turf candidate detected; turf left empty.")
            else:
                notes.append("No explicit turf candidate detected; turf left empty.")

        if turf_geom is not None:
            plowable = MeasurementService._subtract(plowable, turf_geom)
            notes.append("Enforced no overlap: turf removed from plowable.")

        if not notes:
            notes.append("No candidate geometries found; returning boundary as plowable.")

        return AutoClassifyResponse(
            plowable_geometry=MeasurementService._geometry_mapping_or_none(plowable),
            sidewalks_geometry=MeasurementService._geometry_mapping_or_none(sidewalks),
            turf_geometry=MeasurementService._geometry_mapping_or_none(turf_geom),
            mulch_geometry=MeasurementService._geometry_mapping_or_none(mulch),
            notes=notes,
        )

    @staticmethod
    def _measure_from_image(image, payload: MeasurementRequest) -> MeasurementResponse:
        contour = MeasurementService._largest_contour(image)
        if contour is None:
            raise ValueError("No measurable contour detected in image.")

        ft_per_px = payload.known_distance_ft / payload.known_distance_pixels
        area_px = float(cv2.contourArea(contour))
        perimeter_px = float(cv2.arcLength(contour, closed=True))

        area_sqft = round(area_px * (ft_per_px**2), 2)
        perimeter_ft = round(perimeter_px * ft_per_px, 2)

        polygons = [MeasurementService._contour_to_points(contour)]
        lines = [MeasurementService._fit_line_to_contour(contour)] if "length" in payload.measurement_type else []

        img_area = max(float(image.shape[0] * image.shape[1]), 1.0)
        coverage = min(area_px / img_area, 1.0)
        confidence = round(max(0.35, min(0.95, 0.55 + coverage * 0.4)), 2)

        return MeasurementResponse(
            total_area_sqft=area_sqft if "area" in payload.measurement_type else 0.0,
            total_length_ft=perimeter_ft if "length" in payload.measurement_type else 0.0,
            confidence=confidence,
            polygons=polygons if "area" in payload.measurement_type else [],
            lines=lines,
            notes=[
                "Measurement computed from detected primary contour.",
                "Calibration uses known_distance_ft / known_distance_pixels.",
            ],
        )

    @staticmethod
    def _download_image(image_url: str):
        response = httpx.get(image_url, timeout=15.0)
        response.raise_for_status()
        return MeasurementService._decode_image_bytes(response.content)

    @staticmethod
    def _decode_image_bytes(image_bytes: bytes):
        frame = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(frame, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Failed to decode image bytes.")
        return image

    @staticmethod
    def _largest_contour(image):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, 50, 150)
        kernel = np.ones((3, 3), np.uint8)
        closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None
        return max(contours, key=cv2.contourArea)

    @staticmethod
    def _contour_to_points(contour) -> list[Point]:
        epsilon = 0.01 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        points = []
        for p in approx[:, 0]:
            points.append(Point(x=float(p[0]), y=float(p[1])))
        return points

    @staticmethod
    def _fit_line_to_contour(contour) -> list[Point]:
        vx, vy, x0, y0 = cv2.fitLine(contour, cv2.DIST_L2, 0, 0.01, 0.01)
        vx = float(vx)
        vy = float(vy)
        x0 = float(x0)
        y0 = float(y0)

        ts = []
        for p in contour[:, 0]:
            px = float(p[0])
            py = float(p[1])
            ts.append((px - x0) * vx + (py - y0) * vy)
        t_min = min(ts)
        t_max = max(ts)

        p1 = Point(x=round(x0 + vx * t_min, 2), y=round(y0 + vy * t_min, 2))
        p2 = Point(x=round(x0 + vx * t_max, 2), y=round(y0 + vy * t_max, 2))
        return [p1, p2]

    @staticmethod
    def _mock_measurement(payload: MeasurementRequest) -> MeasurementResponse:
        scale = payload.known_distance_ft
        base = {
            "lawn_area": 1.25,
            "driveway_area": 0.95,
            "sidewalk_length": 0.6,
            "parking_lot_area": 1.7,
            "plow_route_length": 2.4,
        }[payload.measurement_type]

        area = round(scale * 100 * base, 2)
        length = round(scale * 12 * (base + 0.1), 2)

        polygon = [
            Point(x=10, y=10),
            Point(x=110, y=10),
            Point(x=110, y=90),
            Point(x=10, y=90),
        ]
        line = [Point(x=5, y=5), Point(x=150, y=45)]

        return MeasurementResponse(
            total_area_sqft=area,
            total_length_ft=length,
            confidence=0.78,
            polygons=[polygon] if "area" in payload.measurement_type else [],
            lines=[line] if "length" in payload.measurement_type else [],
            notes=[
                "Mock output generated by placeholder service.",
                "Integrate/verify CV pipeline calibration for production usage.",
            ],
        )

    @staticmethod
    def _ring_to_points(coords: list[list[float]]) -> list[Point]:
        points: list[Point] = []
        for coord in coords:
            lng, lat = MeasurementService._coord_xy(coord)
            points.append(Point(x=lng, y=lat))
        return points

    @staticmethod
    def _line_length_m(coords: list[list[float]]) -> float:
        total = 0.0
        for i in range(1, len(coords)):
            total += MeasurementService._haversine_m(coords[i - 1], coords[i])
        return total

    @staticmethod
    def _polygon_perimeter_m(coords: list[list[list[float]]]) -> float:
        total = 0.0
        for ring in coords:
            if len(ring) < 2:
                continue
            total += MeasurementService._line_length_m(ring)
        return total

    @staticmethod
    def _polygon_area_sqm(coords: list[list[list[float]]]) -> float:
        if not coords:
            return 0.0
        outer = abs(MeasurementService._ring_area_sqm(coords[0]))
        holes = sum(abs(MeasurementService._ring_area_sqm(ring)) for ring in coords[1:])
        return max(outer - holes, 0.0)

    @staticmethod
    def _ring_area_sqm(ring: list[list[float]]) -> float:
        if len(ring) < 3:
            return 0.0
        lat0_rad = math.radians(sum(MeasurementService._coord_xy(pt)[1] for pt in ring) / len(ring))
        radius = 6371008.8
        projected = []
        for coord in ring:
            lng, lat = MeasurementService._coord_xy(coord)
            x = math.radians(lng) * radius * math.cos(lat0_rad)
            y = math.radians(lat) * radius
            projected.append((x, y))

        area = 0.0
        for i in range(len(projected)):
            x1, y1 = projected[i]
            x2, y2 = projected[(i + 1) % len(projected)]
            area += x1 * y2 - x2 * y1
        return abs(area) * 0.5

    @staticmethod
    def _haversine_m(a: list[float], b: list[float]) -> float:
        a_lng, a_lat = MeasurementService._coord_xy(a)
        b_lng, b_lat = MeasurementService._coord_xy(b)
        lng1, lat1 = math.radians(a_lng), math.radians(a_lat)
        lng2, lat2 = math.radians(b_lng), math.radians(b_lat)
        d_lng = lng2 - lng1
        d_lat = lat2 - lat1
        h = (
            math.sin(d_lat / 2) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(d_lng / 2) ** 2
        )
        return 2 * 6371008.8 * math.asin(math.sqrt(h))

    @staticmethod
    def _coord_xy(coord: list[float]) -> tuple[float, float]:
        if not isinstance(coord, list) or len(coord) < 2:
            raise ValueError("Invalid coordinate in geometry.")
        return float(coord[0]), float(coord[1])

    @staticmethod
    def _shape_or_none(geometry: dict[str, Any] | None) -> BaseGeometry | None:
        if geometry is None:
            return None
        cleaned = MeasurementService._strip_z_geometry(geometry)
        try:
            return MeasurementService._make_valid(shape(cleaned))
        except Exception:
            return None

    @staticmethod
    def _strip_z_geometry(obj: Any) -> Any:
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                out[k] = MeasurementService._strip_z_geometry(v)
            return out
        if isinstance(obj, list):
            if obj and all(isinstance(x, (int, float)) for x in obj):
                return obj[:2]
            return [MeasurementService._strip_z_geometry(v) for v in obj]
        return obj

    @staticmethod
    def _make_valid(geom: BaseGeometry | None) -> BaseGeometry | None:
        if geom is None:
            return None
        try:
            fixed = make_valid(geom)
        except Exception:
            fixed = geom
        if fixed.is_empty:
            return None
        return fixed

    @staticmethod
    def _clip(geom: BaseGeometry | None, boundary: BaseGeometry) -> BaseGeometry | None:
        if geom is None:
            return None
        try:
            out = MeasurementService._make_valid(geom.intersection(boundary))
            return out
        except Exception:
            return None

    @staticmethod
    def _subtract(base: BaseGeometry | None, remove: BaseGeometry | None) -> BaseGeometry | None:
        if base is None:
            return None
        if remove is None:
            return base
        try:
            out = MeasurementService._make_valid(base.difference(remove))
            return out
        except Exception:
            return base

    @staticmethod
    def _geometry_mapping_or_none(geom: BaseGeometry | None) -> dict[str, Any] | None:
        if geom is None or geom.is_empty:
            return None
        from shapely.geometry import mapping

        return dict(mapping(geom))
