import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.schemas import MeasurementRecord, MeasurementRequest, MeasurementResponse


DEFAULT_DB_PATH = "./data/measurements.db"
_DB_READY = False
_ALLOWED_MEASUREMENT_TYPES = {
    "lawn_area",
    "driveway_area",
    "sidewalk_length",
    "parking_lot_area",
    "plow_route_length",
}


def _db_path() -> str:
    configured = os.getenv("AUTO_MEASURE_DB_PATH", DEFAULT_DB_PATH)
    path = Path(configured).expanduser()
    if not path.is_absolute():
        backend_root = Path(__file__).resolve().parents[2]
        path = backend_root / path
    return str(path)


def _connect() -> sqlite3.Connection:
    db_file = _db_path()
    Path(db_file).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    global _DB_READY
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                image_url TEXT NOT NULL,
                measurement_type TEXT NOT NULL,
                known_distance_ft REAL NOT NULL,
                known_distance_pixels REAL NOT NULL,
                total_area_sqft REAL NOT NULL,
                total_length_ft REAL NOT NULL,
                confidence REAL NOT NULL,
                polygons_json TEXT NOT NULL,
                lines_json TEXT NOT NULL,
                notes_json TEXT NOT NULL
            )
            """
        )
        _migrate_schema(conn)
        conn.commit()
    _DB_READY = True


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """Backfill columns for older DB files so reads don't fail with 500s."""
    existing = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(measurements)").fetchall()
    }
    required = {
        "created_at": "TEXT NOT NULL DEFAULT ''",
        "image_url": "TEXT NOT NULL DEFAULT ''",
        "measurement_type": "TEXT NOT NULL DEFAULT 'lawn_area'",
        "known_distance_ft": "REAL NOT NULL DEFAULT 1.0",
        "known_distance_pixels": "REAL NOT NULL DEFAULT 100.0",
        "total_area_sqft": "REAL NOT NULL DEFAULT 0.0",
        "total_length_ft": "REAL NOT NULL DEFAULT 0.0",
        "confidence": "REAL NOT NULL DEFAULT 0.0",
        "polygons_json": "TEXT NOT NULL DEFAULT '[]'",
        "lines_json": "TEXT NOT NULL DEFAULT '[]'",
        "notes_json": "TEXT NOT NULL DEFAULT '[]'",
    }
    for col, ddl in required.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE measurements ADD COLUMN {col} {ddl}")


def ensure_db_ready() -> None:
    if not _DB_READY:
        init_db()


def save_measurement(payload: MeasurementRequest, result: MeasurementResponse) -> int:
    ensure_db_ready()
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO measurements (
                created_at,
                image_url,
                measurement_type,
                known_distance_ft,
                known_distance_pixels,
                total_area_sqft,
                total_length_ft,
                confidence,
                polygons_json,
                lines_json,
                notes_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                created_at,
                payload.image_url,
                payload.measurement_type,
                payload.known_distance_ft,
                payload.known_distance_pixels,
                result.total_area_sqft,
                result.total_length_ft,
                result.confidence,
                json.dumps([[[p.x, p.y] for p in polygon] for polygon in result.polygons]),
                json.dumps([[[p.x, p.y] for p in line] for line in result.lines]),
                json.dumps(result.notes),
            ),
        )
        conn.commit()
        return int(cursor.lastrowid)


def get_measurement(measurement_id: int) -> MeasurementRecord | None:
    ensure_db_ready()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM measurements WHERE id = ?",
            (measurement_id,),
        ).fetchone()
    if row is None:
        return None
    return _row_to_record(row)


def list_measurements(limit: int = 20) -> list[MeasurementRecord]:
    ensure_db_ready()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM measurements ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out: list[MeasurementRecord] = []
    for row in rows:
        try:
            out.append(_row_to_record(row))
        except Exception:
            # Keep history endpoint stable even if one row is malformed.
            continue
    return out


def _json_load(raw: Any, fallback: Any) -> Any:
    if raw is None:
        return fallback
    if isinstance(raw, (list, dict)):
        return raw
    if not isinstance(raw, str):
        return fallback
    try:
        return json.loads(raw)
    except Exception:
        return fallback


def _to_point_pairs(raw: Any) -> list[list[tuple[float, float]]]:
    out: list[list[tuple[float, float]]] = []
    if not isinstance(raw, list):
        return out
    for segment in raw:
        if not isinstance(segment, list):
            continue
        points: list[tuple[float, float]] = []
        for item in segment:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            try:
                x = float(item[0])
                y = float(item[1])
            except Exception:
                continue
            points.append((x, y))
        if points:
            out.append(points)
    return out


def _row_to_record(row: sqlite3.Row) -> MeasurementRecord:
    from app.schemas import Point

    polygons_raw = _json_load(row["polygons_json"], [])
    lines_raw = _json_load(row["lines_json"], [])
    notes_raw = _json_load(row["notes_json"], [])

    polygons = [[Point(x=x, y=y) for x, y in polygon] for polygon in _to_point_pairs(polygons_raw)]
    lines = [[Point(x=x, y=y) for x, y in line] for line in _to_point_pairs(lines_raw)]

    measurement_type = str(row["measurement_type"] or "lawn_area")
    if measurement_type not in _ALLOWED_MEASUREMENT_TYPES:
        measurement_type = "lawn_area"
    try:
        confidence = float(row["confidence"])
    except Exception:
        confidence = 0.0
    confidence = min(1.0, max(0.0, confidence))
    notes = [str(n) for n in notes_raw] if isinstance(notes_raw, list) else []

    return MeasurementRecord(
        id=int(row["id"]),
        created_at=str(row["created_at"]),
        image_url=str(row["image_url"]),
        measurement_type=measurement_type,
        known_distance_ft=float(row["known_distance_ft"]),
        known_distance_pixels=float(row["known_distance_pixels"]),
        total_area_sqft=float(row["total_area_sqft"]),
        total_length_ft=float(row["total_length_ft"]),
        confidence=confidence,
        polygons=polygons,
        lines=lines,
        notes=notes,
    )
