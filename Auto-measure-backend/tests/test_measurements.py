import base64
import os
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from shapely.geometry import shape

DB_PATH = "/tmp/auto_measure_backend_test.db"
os.environ["AUTO_MEASURE_DB_PATH"] = DB_PATH
if Path(DB_PATH).exists():
    Path(DB_PATH).unlink()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app
from app.repositories.measurement_repository import init_db
from app.services import shared_auth as shared_auth_service
from app.services.segmentation_service import SegmentationService

init_db()

client = TestClient(app)
SHARED_AUTH_ENV_KEYS = [
    "AUTO_MEASURE_SHARED_AUTH_USER",
    "AUTO_MEASURE_SHARED_AUTH_PASS",
    "AUTO_MEASURE_SHARED_AUTH_USERS",
    "AUTO_MEASURE_SHARED_AUTH_USERS_JSON",
    "AUTO_MEASURE_SHARED_AUTH_ALLOW_INSECURE_DEFAULTS",
]


def _set_shared_auth_env(**overrides: str | None) -> dict[str, str | None]:
    previous = {key: os.environ.get(key) for key in SHARED_AUTH_ENV_KEYS}
    for key in SHARED_AUTH_ENV_KEYS:
        next_value = overrides.get(key)
        if next_value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = next_value
    shared_auth_service._TOKEN_STORE.clear()
    return previous


def _restore_shared_auth_env(previous: dict[str, str | None]) -> None:
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    shared_auth_service._TOKEN_STORE.clear()


def test_root_health() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "Auto Measure Backend Running"}


def test_shared_login_requires_explicit_configuration() -> None:
    previous = _set_shared_auth_env()
    try:
        response = client.post(
            "/auth/login",
            json={"username": "admin", "password": "changeme"},
        )
        assert response.status_code == 503
        assert "not configured" in response.json()["detail"].lower()
    finally:
        _restore_shared_auth_env(previous)


def test_shared_login_session_and_logout() -> None:
    previous = _set_shared_auth_env(
        AUTO_MEASURE_SHARED_AUTH_USER="qa-user",
        AUTO_MEASURE_SHARED_AUTH_PASS="super-secret",
    )
    try:
        login_response = client.post(
            "/auth/login",
            json={"username": "qa-user", "password": "super-secret"},
        )
        assert login_response.status_code == 200
        body = login_response.json()
        assert body["username"] == "qa-user"
        assert body["token"]

        headers = {"Authorization": f"Bearer {body['token']}"}
        session_response = client.get("/auth/session", headers=headers)
        assert session_response.status_code == 200
        assert session_response.json()["authenticated"] is True

        logout_response = client.post("/auth/logout", headers=headers)
        assert logout_response.status_code == 200
        assert logout_response.json() == {"ok": True}

        expired_session_response = client.get("/auth/session", headers=headers)
        assert expired_session_response.status_code == 401
    finally:
        _restore_shared_auth_env(previous)


def test_create_measurement_success() -> None:
    payload = {
        "image_url": "https://example.com/site.png",
        "measurement_type": "lawn_area",
        "known_distance_ft": 20,
    }

    response = client.post("/measurements", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["total_area_sqft"] > 0
    assert body["total_length_ft"] > 0
    assert 0 <= body["confidence"] <= 1
    assert len(body["polygons"]) == 1


def test_create_measurement_validation_error() -> None:
    payload = {
        "image_url": "invalid-url",
        "measurement_type": "lawn_area",
        "known_distance_ft": 0,
    }

    response = client.post("/measurements", json=payload)

    assert response.status_code == 422


def test_create_measurement_upload_success() -> None:
    png_1x1 = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Y8xkAAAAASUVORK5CYII="
    )
    data = {
        "measurement_type": "lawn_area",
        "known_distance_ft": "20",
        "known_distance_pixels": "100",
    }
    files = {"image": ("site.png", png_1x1, "image/png")}

    response = client.post("/measurements/upload", data=data, files=files)

    assert response.status_code == 200
    body = response.json()
    assert "confidence" in body
    assert 0 <= body["confidence"] <= 1


def test_create_measurement_upload_requires_image() -> None:
    data = {
        "measurement_type": "lawn_area",
        "known_distance_ft": "20",
    }
    files = {"image": ("not-image.txt", b"plain text", "text/plain")}

    response = client.post("/measurements/upload", data=data, files=files)

    assert response.status_code == 400


def test_segment_upload_success() -> None:
    import cv2
    import numpy as np

    img = np.zeros((16, 16, 3), dtype=np.uint8)
    img[:, :] = (0, 180, 0)
    ok, encoded = cv2.imencode(".png", img)
    assert ok
    files = {"image": ("site.png", encoded.tobytes(), "image/png")}
    data = {"use_model": "false", "min_area_px": "1"}

    response = client.post("/measurements/segment/upload", data=data, files=files)

    assert response.status_code == 200
    body = response.json()
    assert "plowable" in body
    assert "turf" in body


def test_segmentation_heuristics_keep_parking_lot_plowable() -> None:
    import cv2
    import numpy as np

    img = np.full((96, 96, 3), 95, dtype=np.uint8)
    cv2.rectangle(img, (0, 0), (95, 95), (90, 90, 90), -1)
    for x in range(10, 90, 16):
        cv2.rectangle(img, (x, 18), (x + 3, 78), (235, 235, 235), -1)
    cv2.rectangle(img, (28, 30), (40, 56), (60, 60, 60), -1)
    cv2.rectangle(img, (56, 34), (70, 62), (200, 200, 200), -1)

    masks, confidences = SegmentationService._heuristic_masks(img)
    coverage = SegmentationService._coverage_by_class(masks)

    assert coverage["plowable"] > coverage["sidewalks"]
    assert coverage["plowable"] > 0.20
    assert coverage["sidewalks"] < 0.12
    assert confidences["plowable"] > 0.60


def test_segmentation_heuristics_keep_grass_as_turf() -> None:
    import numpy as np

    img = np.zeros((48, 48, 3), dtype=np.uint8)
    img[:, :] = (35, 150, 40)

    masks, confidences = SegmentationService._heuristic_masks(img)
    coverage = SegmentationService._coverage_by_class(masks)

    assert coverage["turf"] > 0.70
    assert coverage["plowable"] < 0.05
    assert confidences["turf"] > confidences["plowable"]


def test_calibrate_pixel_distance_success() -> None:
    payload = {
        "point_a": {"x": 10, "y": 20},
        "point_b": {"x": 40, "y": 60},
    }

    response = client.post("/measurements/calibrate/pixel-distance", json=payload)

    assert response.status_code == 200
    assert response.json()["pixel_distance"] == 50.0


def test_calibrate_pixel_distance_identical_points() -> None:
    payload = {
        "point_a": {"x": 10, "y": 20},
        "point_b": {"x": 10, "y": 20},
    }

    response = client.post("/measurements/calibrate/pixel-distance", json=payload)

    assert response.status_code == 422


def test_measurement_history_and_detail() -> None:
    payload = {
        "image_url": "https://example.com/site.png",
        "measurement_type": "driveway_area",
        "known_distance_ft": 18,
        "known_distance_pixels": 120,
    }
    create_response = client.post("/measurements", json=payload)
    assert create_response.status_code == 200

    history_response = client.get("/measurements/history", params={"limit": 5})
    assert history_response.status_code == 200
    history = history_response.json()
    assert len(history) >= 1
    latest = history[0]
    assert latest["measurement_type"] == "driveway_area"
    assert latest["known_distance_ft"] == 18

    detail_response = client.get(f"/measurements/{latest['id']}")
    assert detail_response.status_code == 200
    detail = detail_response.json()
    assert detail["id"] == latest["id"]
    assert "created_at" in detail


def test_create_measurement_geojson_success() -> None:
    payload = {
        "measurement_type": "lawn_area",
        "known_distance_ft": 20,
        "known_distance_pixels": 100,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [-74.0, 40.0],
                    [-74.0, 40.0001],
                    [-73.9999, 40.0001],
                    [-73.9999, 40.0],
                    [-74.0, 40.0],
                ]
            ],
        },
    }

    response = client.post("/measurements/geojson", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["total_area_sqft"] > 0
    assert body["confidence"] >= 0.9
    assert body["notes"][0].startswith("Measured directly from uploaded KML/GeoJSON")


def test_create_measurement_geojson_with_altitude_coords_success() -> None:
    payload = {
        "measurement_type": "lawn_area",
        "known_distance_ft": 20,
        "known_distance_pixels": 100,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [-74.0, 40.0, 0],
                    [-74.0, 40.0001, 0],
                    [-73.9999, 40.0001, 0],
                    [-73.9999, 40.0, 0],
                    [-74.0, 40.0, 0],
                ]
            ],
        },
    }

    response = client.post("/measurements/geojson", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["total_area_sqft"] > 0


def test_auto_classify_layers_success() -> None:
    payload = {
        "boundary_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0, 40.0],
                [-74.0, 40.001],
                [-73.999, 40.001],
                [-73.999, 40.0],
                [-74.0, 40.0],
            ]],
        },
        "candidate_sidewalk_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0, 40.0],
                [-74.0, 40.0002],
                [-73.999, 40.0002],
                [-73.999, 40.0],
                [-74.0, 40.0],
            ]],
        },
        "candidate_turf_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0, 40.0006],
                [-74.0, 40.001],
                [-73.9994, 40.001],
                [-73.9994, 40.0006],
                [-74.0, 40.0006],
            ]],
        },
        "candidate_buildings_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-73.9998, 40.0004],
                [-73.9998, 40.0005],
                [-73.9997, 40.0005],
                [-73.9997, 40.0004],
                [-73.9998, 40.0004],
            ]],
        },
    }

    response = client.post("/measurements/auto-classify", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["plowable_geometry"] is not None
    assert body["sidewalks_geometry"] is not None
    assert body["turf_geometry"] is not None
    assert isinstance(body["notes"], list)


def test_auto_classify_no_synthetic_mulch() -> None:
    payload = {
        "boundary_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0, 40.0],
                [-74.0, 40.001],
                [-73.999, 40.001],
                [-73.999, 40.0],
                [-74.0, 40.0],
            ]],
        },
        "candidate_buildings_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-73.9998, 40.0004],
                [-73.9998, 40.0005],
                [-73.9997, 40.0005],
                [-73.9997, 40.0004],
                [-73.9998, 40.0004],
            ]],
        },
    }
    response = client.post("/measurements/auto-classify", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["mulch_geometry"] is None


def test_auto_classify_residual_turf_fallback_enabled() -> None:
    payload = {
        "boundary_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0, 40.0],
                [-74.0, 40.001],
                [-73.999, 40.001],
                [-73.999, 40.0],
                [-74.0, 40.0],
            ]],
        },
        "candidate_plowable_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0, 40.0],
                [-74.0, 40.0004],
                [-73.999, 40.0004],
                [-73.999, 40.0],
                [-74.0, 40.0],
            ]],
        },
    }
    response = client.post("/measurements/auto-classify", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["turf_geometry"] is not None
    assert any("derived turf from residual area" in n.lower() for n in body["notes"])


def test_auto_classify_buildings_removed_from_plowable() -> None:
    payload = {
        "boundary_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0, 40.0],
                [-74.0, 40.001],
                [-73.999, 40.001],
                [-73.999, 40.0],
                [-74.0, 40.0],
            ]],
        },
        "candidate_plowable_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0, 40.0],
                [-74.0, 40.001],
                [-73.999, 40.001],
                [-73.999, 40.0],
                [-74.0, 40.0],
            ]],
        },
        "candidate_buildings_geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-73.9998, 40.0004],
                [-73.9998, 40.0006],
                [-73.9996, 40.0006],
                [-73.9996, 40.0004],
                [-73.9998, 40.0004],
            ]],
        },
    }
    response = client.post("/measurements/auto-classify", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["plowable_geometry"] is not None
    plowable = shape(body["plowable_geometry"])
    building = shape(payload["candidate_buildings_geometry"])
    assert plowable.intersection(building).area == 0.0
