import base64
import os
from pathlib import Path

from fastapi.testclient import TestClient
from shapely.geometry import shape

DB_PATH = "/tmp/auto_measure_backend_test.db"
os.environ["AUTO_MEASURE_DB_PATH"] = DB_PATH
if Path(DB_PATH).exists():
    Path(DB_PATH).unlink()

from app.main import app
from app.repositories.measurement_repository import init_db

init_db()

client = TestClient(app)


def test_root_health() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "Auto Measure Backend Running"}


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
