import json
import os
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


DEFAULT_DB_PATH = "./data/measurements.db"
_DB_READY = False


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat().replace("+00:00", "Z")


def _db_path() -> str:
    configured = os.getenv("AUTO_MEASURE_DB_PATH", DEFAULT_DB_PATH)
    path = Path(configured).expanduser()
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    return str(path)


def _connect() -> sqlite3.Connection:
    db_file = _db_path()
    Path(db_file).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_file, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    global _DB_READY
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS takeoff_requests (
                id TEXT PRIMARY KEY,
                organization_id TEXT NOT NULL,
                created_by TEXT NOT NULL,
                title TEXT NOT NULL,
                address TEXT NOT NULL,
                service_types_json TEXT NOT NULL,
                boundary_json TEXT,
                notes TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'submitted',
                quote_cents INTEGER,
                quote_notes TEXT NOT NULL DEFAULT '',
                quoted_at TEXT,
                accepted_at TEXT,
                due_at TEXT,
                delivered_at TEXT,
                delivery_notes TEXT NOT NULL DEFAULT '',
                delivered_project_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS takeoff_request_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT NOT NULL,
                actor_user_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                details_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (request_id) REFERENCES takeoff_requests(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS takeoff_files (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                organization_id TEXT NOT NULL,
                uploaded_by TEXT NOT NULL,
                storage_key TEXT NOT NULL UNIQUE,
                original_name TEXT NOT NULL,
                content_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (request_id) REFERENCES takeoff_requests(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_takeoff_requests_org_updated
            ON takeoff_requests(organization_id, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_takeoff_requests_status
            ON takeoff_requests(status, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_takeoff_files_request
            ON takeoff_files(request_id, created_at);
            """
        )
        conn.commit()
    _DB_READY = True


def ensure_db_ready() -> None:
    if not _DB_READY:
        init_db()


def _json_load(value: Any, fallback: Any) -> Any:
    try:
        parsed = json.loads(str(value))
        return parsed
    except Exception:
        return fallback


def _decode_file(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "original_name": str(row["original_name"]),
        "content_type": str(row["content_type"]),
        "size_bytes": max(0, int(row["size_bytes"] or 0)),
        "created_at": str(row["created_at"]),
    }


def _files(conn: sqlite3.Connection, request_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM takeoff_files WHERE request_id = ? ORDER BY created_at",
        (str(request_id),),
    ).fetchall()
    return [_decode_file(row) for row in rows]


def _decode_request(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    boundary = _json_load(row["boundary_json"], None) if row["boundary_json"] else None
    return {
        "id": str(row["id"]),
        "organization_id": str(row["organization_id"]),
        "organization_name": str(row["organization_name"] if "organization_name" in row.keys() else ""),
        "created_by": str(row["created_by"]),
        "title": str(row["title"]),
        "address": str(row["address"]),
        "service_types": _json_load(row["service_types_json"], []),
        "boundary": boundary if isinstance(boundary, dict) else None,
        "notes": str(row["notes"] or ""),
        "status": str(row["status"] or "submitted"),
        "quote_cents": int(row["quote_cents"]) if row["quote_cents"] is not None else None,
        "quote_notes": str(row["quote_notes"] or ""),
        "quoted_at": str(row["quoted_at"]) if row["quoted_at"] else None,
        "accepted_at": str(row["accepted_at"]) if row["accepted_at"] else None,
        "due_at": str(row["due_at"]) if row["due_at"] else None,
        "delivered_at": str(row["delivered_at"]) if row["delivered_at"] else None,
        "delivery_notes": str(row["delivery_notes"] or ""),
        "delivered_project_id": str(row["delivered_project_id"]) if row["delivered_project_id"] else None,
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
        "files": _files(conn, str(row["id"])),
    }


REQUEST_SELECT = """
    SELECT r.*, o.name AS organization_name
    FROM takeoff_requests r
    JOIN organizations o ON o.id = r.organization_id
"""


def create_request(
    *,
    organization_id: str,
    user_id: str,
    title: str,
    address: str,
    service_types: list[str],
    boundary: dict[str, Any] | None,
    notes: str,
) -> dict[str, Any]:
    ensure_db_ready()
    request_id = f"req-{secrets.token_hex(12)}"
    now = _iso()
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT INTO takeoff_requests (
                id, organization_id, created_by, title, address, service_types_json,
                boundary_json, notes, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)
            """,
            (
                request_id,
                organization_id,
                user_id,
                title,
                address,
                json.dumps(service_types, ensure_ascii=True),
                json.dumps(boundary, ensure_ascii=True) if boundary else None,
                notes,
                now,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO takeoff_request_events (
                request_id, actor_user_id, event_type, details_json, created_at
            ) VALUES (?, ?, 'submitted', '{}', ?)
            """,
            (request_id, user_id, now),
        )
        conn.commit()
    result = get_request(request_id, organization_id=organization_id)
    if result is None:
        raise RuntimeError("Takeoff request could not be read after creation.")
    return result


def list_requests(
    *, organization_id: str | None = None, include_all: bool = False, limit: int = 100
) -> list[dict[str, Any]]:
    ensure_db_ready()
    safe_limit = max(1, min(500, int(limit)))
    with _connect() as conn:
        if include_all:
            rows = conn.execute(
                REQUEST_SELECT + " ORDER BY r.updated_at DESC LIMIT ?", (safe_limit,)
            ).fetchall()
        else:
            rows = conn.execute(
                REQUEST_SELECT
                + " WHERE r.organization_id = ? ORDER BY r.updated_at DESC LIMIT ?",
                (str(organization_id), safe_limit),
            ).fetchall()
        return [_decode_request(conn, row) for row in rows]


def get_request(
    request_id: str,
    *,
    organization_id: str | None = None,
    include_all: bool = False,
) -> dict[str, Any] | None:
    ensure_db_ready()
    with _connect() as conn:
        if include_all:
            row = conn.execute(REQUEST_SELECT + " WHERE r.id = ?", (str(request_id),)).fetchone()
        else:
            row = conn.execute(
                REQUEST_SELECT + " WHERE r.id = ? AND r.organization_id = ?",
                (str(request_id), str(organization_id)),
            ).fetchone()
        return _decode_request(conn, row) if row else None


def update_request(
    request_id: str,
    *,
    actor_user_id: str,
    status: str | None = None,
    quote_cents: int | None = None,
    quote_notes: str | None = None,
    delivery_notes: str | None = None,
    delivered_project_id: str | None = None,
) -> dict[str, Any] | None:
    ensure_db_ready()
    now = _iso()
    with _connect() as conn:
        current = conn.execute(
            "SELECT * FROM takeoff_requests WHERE id = ?", (str(request_id),)
        ).fetchone()
        if current is None:
            return None
        fields = ["updated_at = ?"]
        values: list[Any] = [now]
        details: dict[str, Any] = {}
        if status is not None:
            fields.append("status = ?")
            values.append(status)
            details["status"] = status
            if status == "quoted":
                fields.append("quoted_at = ?")
                values.append(now)
            elif status == "accepted":
                fields.extend(["accepted_at = ?", "due_at = ?"])
                values.extend([now, _iso(_now() + timedelta(hours=24))])
            elif status == "delivered":
                fields.append("delivered_at = ?")
                values.append(now)
        optional = {
            "quote_cents": quote_cents,
            "quote_notes": quote_notes,
            "delivery_notes": delivery_notes,
            "delivered_project_id": delivered_project_id,
        }
        for column, value in optional.items():
            if value is not None:
                fields.append(f"{column} = ?")
                values.append(value)
                details[column] = value
        values.append(str(request_id))
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            f"UPDATE takeoff_requests SET {', '.join(fields)} WHERE id = ?", values
        )
        conn.execute(
            """
            INSERT INTO takeoff_request_events (
                request_id, actor_user_id, event_type, details_json, created_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                str(request_id),
                str(actor_user_id),
                status or "updated",
                json.dumps(details, ensure_ascii=True),
                now,
            ),
        )
        conn.commit()
    return get_request(request_id, include_all=True)


def accept_quote(request_id: str, organization_id: str, user_id: str) -> dict[str, Any] | None:
    request = get_request(request_id, organization_id=organization_id)
    if not request or request.get("status") != "quoted" or request.get("quote_cents") is None:
        return None
    return update_request(request_id, actor_user_id=user_id, status="accepted")


def add_file(
    *,
    request_id: str,
    organization_id: str,
    user_id: str,
    storage_key: str,
    original_name: str,
    content_type: str,
    size_bytes: int,
) -> dict[str, Any]:
    ensure_db_ready()
    file_id = f"file-{secrets.token_hex(12)}"
    now = _iso()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO takeoff_files (
                id, request_id, organization_id, uploaded_by, storage_key,
                original_name, content_type, size_bytes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                file_id,
                request_id,
                organization_id,
                user_id,
                storage_key,
                original_name,
                content_type,
                max(0, int(size_bytes)),
                now,
            ),
        )
        conn.commit()
    return {
        "id": file_id,
        "original_name": original_name,
        "content_type": content_type,
        "size_bytes": max(0, int(size_bytes)),
        "created_at": now,
    }


def get_file(file_id: str) -> dict[str, Any] | None:
    ensure_db_ready()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM takeoff_files WHERE id = ?", (str(file_id),)).fetchone()
    return dict(row) if row else None
