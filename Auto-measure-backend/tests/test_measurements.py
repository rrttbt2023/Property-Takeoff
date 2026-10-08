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


def test_shared_project_revisions_and_polygon_drop_guard() -> None:
    previous = _set_shared_auth_env(
        AUTO_MEASURE_SHARED_AUTH_USER="revision-user",
        AUTO_MEASURE_SHARED_AUTH_PASS="revision-secret",
    )
    project_id = "revision-safety-test"
    try:
        login_response = client.post(
            "/api/auth/login",
            json={"username": "revision-user", "password": "revision-secret"},
        )
        assert login_response.status_code == 200
        headers = {"Authorization": f"Bearer {login_response.json()['token']}"}
        many_polygons = [{"id": f"p-{idx}", "type": "Feature"} for idx in range(25)]
        payload = {
            "version": 1,
            "projectName": "Revision Safety",
            "folderName": "Training Properties",
            "workflowMode": "location",
            "layerFeatures": {
                "plowable": many_polygons,
                "sidewalks": [],
                "turf": [],
                "mulch": [],
            },
        }
        create_response = client.put(
            f"/api/projects/{project_id}",
            headers=headers,
            json={
                "id": project_id,
                "project_name": "Revision Safety",
                "polygon_count": 25,
                "payload": payload,
            },
        )
        assert create_response.status_code == 200
        assert create_response.json()["revision"] == 1
        assert create_response.json()["folder_name"] == "Training Properties"
        assert create_response.json()["workflow_mode"] == "location"

        project_response = client.get(
            f"/api/projects/{project_id}",
            headers=headers,
        )
        assert project_response.status_code == 200
        assert project_response.json()["folder_name"] == "Training Properties"
        assert project_response.json()["workflow_mode"] == "location"

        versions_response = client.get(
            f"/api/projects/{project_id}/versions",
            headers=headers,
        )
        assert versions_response.status_code == 200
        assert versions_response.json()[0]["revision"] == 1

        reduced_payload = {
            **payload,
            "layerFeatures": {
                **payload["layerFeatures"],
                "plowable": many_polygons[:1],
            },
        }
        blocked_response = client.put(
            f"/api/projects/{project_id}",
            headers=headers,
            json={
                "id": project_id,
                "project_name": "Revision Safety",
                "polygon_count": 1,
                "base_revision": 1,
                "payload": reduced_payload,
            },
        )
        assert blocked_response.status_code == 409
        assert blocked_response.json()["detail"]["code"] == "polygon_count_drop"

        mismatched_count_response = client.put(
            f"/api/projects/{project_id}",
            headers=headers,
            json={
                "id": project_id,
                "project_name": "Revision Safety",
                "polygon_count": 25,
                "base_revision": 1,
                "payload": reduced_payload,
            },
        )
        assert mismatched_count_response.status_code == 400

        forced_response = client.put(
            f"/api/projects/{project_id}",
            headers=headers,
            json={
                "id": project_id,
                "project_name": "Revision Safety",
                "polygon_count": 1,
                "base_revision": 1,
                "force_overwrite": True,
                "payload": reduced_payload,
            },
        )
        assert forced_response.status_code == 200
        assert forced_response.json()["revision"] == 2

        stale_response = client.put(
            f"/api/projects/{project_id}",
            headers=headers,
            json={
                "id": project_id,
                "project_name": "Revision Safety",
                "polygon_count": 25,
                "base_revision": 1,
                "payload": payload,
            },
        )
        assert stale_response.status_code == 409
        assert stale_response.json()["detail"]["conflict"]["revision"] == 2

        revision_response = client.get(
            f"/api/projects/{project_id}/versions/1",
            headers=headers,
        )
        assert revision_response.status_code == 200
        assert revision_response.json()["polygon_count"] == 25
    finally:
        try:
            if "headers" in locals():
                client.delete(f"/api/projects/{project_id}", headers=headers)
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
    assert body["diagnostics"]["engine"] == "heuristic-disabled"


def test_segmentation_status_and_tile_coverage() -> None:
    response = client.get("/measurements/segment/status")
    assert response.status_code == 200
    assert response.json()["engine"] in {"torchscript-ready", "heuristic-fallback"}

    starts = SegmentationService._tile_starts(2500, 1024, 192)
    assert starts[0] == 0
    assert starts[-1] == 2500 - 1024
    assert all((b - a) <= (1024 - 192) for a, b in zip(starts, starts[1:]))


def test_save_segmentation_correction(tmp_path, monkeypatch) -> None:
    import cv2
    import numpy as np

    monkeypatch.setenv("AUTO_MEASURE_TRAINING_FEEDBACK_DIR", str(tmp_path))
    image = np.zeros((16, 16, 3), dtype=np.uint8)
    image[:, :] = (30, 150, 45)
    mask = np.full((16, 16), 3, dtype=np.uint8)
    ok_image, encoded_image = cv2.imencode(".png", image)
    ok_mask, encoded_mask = cv2.imencode(".png", mask)
    assert ok_image and ok_mask

    response = client.post(
        "/measurements/segment/corrections",
        data={"metadata": '{"project_name":"Correction Test"}'},
        files={
            "image": ("image.png", encoded_image.tobytes(), "image/png"),
            "mask": ("mask.png", encoded_mask.tobytes(), "image/png"),
        },
    )

    assert response.status_code == 200
    sample_id = response.json()["sample_id"]
    assert (tmp_path / sample_id / "image.png").exists()
    assert (tmp_path / sample_id / "mask.png").exists()
    assert (tmp_path / sample_id / "metadata.json").exists()


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
