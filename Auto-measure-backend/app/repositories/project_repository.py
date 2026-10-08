import json
import os
import sqlite3
from pathlib import Path
from typing import Any


DEFAULT_DB_PATH = "./data/measurements.db"
DEFAULT_MAX_REVISIONS = 100
LEGACY_PROJECTS_DIR = Path(__file__).resolve().parents[2] / "data" / "shared_projects"
_DB_READY = False


class ProjectRevisionConflictError(RuntimeError):
    def __init__(self, current_revision: int):
        super().__init__("Project revision changed before this save completed.")
        self.current_revision = max(1, int(current_revision))


def _db_path() -> str:
    configured = os.getenv(
        "AUTO_MEASURE_PROJECT_DB_PATH",
        os.getenv("AUTO_MEASURE_DB_PATH", DEFAULT_DB_PATH),
    )
    path = Path(configured).expanduser()
    if not path.is_absolute():
        backend_root = Path(__file__).resolve().parents[2]
        path = backend_root / path
    return str(path)


def _connect() -> sqlite3.Connection:
    db_file = _db_path()
    Path(db_file).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_file, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _max_revisions() -> int:
    raw = str(os.getenv("AUTO_MEASURE_PROJECT_MAX_REVISIONS", DEFAULT_MAX_REVISIONS))
    try:
        value = int(raw)
    except Exception:
        value = DEFAULT_MAX_REVISIONS
    return max(10, min(1000, value))


def _decode_record(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    try:
        payload = json.loads(str(row["payload_json"] or "{}"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return {
        "id": str(row["id"] or ""),
        "project_name": str(row["project_name"] or "Untitled Project"),
        "saved_at": str(row["saved_at"] or ""),
        "saved_by": str(row["saved_by"] or "unknown"),
        "last_edited_at": str(row["last_edited_at"] or ""),
        "created_at": str(row["created_at"] or ""),
        "created_by": str(row["created_by"] or "unknown"),
        "polygon_count": max(0, int(row["polygon_count"] or 0)),
        "has_boundary": bool(row["has_boundary"]),
        "revision": max(1, int(row["revision"] or 1)),
        "payload": payload,
    }


def init_db() -> None:
    global _DB_READY
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS shared_projects (
                id TEXT PRIMARY KEY,
                project_name TEXT NOT NULL,
                saved_at TEXT NOT NULL,
                saved_by TEXT NOT NULL,
                last_edited_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL,
                polygon_count INTEGER NOT NULL DEFAULT 0,
                has_boundary INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL DEFAULT 1,
                payload_json TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS shared_project_versions (
                project_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                saved_by TEXT NOT NULL,
                polygon_count INTEGER NOT NULL DEFAULT 0,
                has_boundary INTEGER NOT NULL DEFAULT 0,
                project_name TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (project_id, revision)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_shared_projects_last_edited
            ON shared_projects(last_edited_at DESC)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_shared_project_versions_created
            ON shared_project_versions(project_id, revision DESC)
            """
        )
        conn.commit()
    _DB_READY = True
    _import_legacy_json_files()


def ensure_db_ready() -> None:
    if not _DB_READY:
        init_db()


def _import_legacy_json_files() -> None:
    if not LEGACY_PROJECTS_DIR.exists():
        return
    for path in LEGACY_PROJECTS_DIR.glob("*.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or not isinstance(value.get("payload"), dict):
                continue
            record = {
                **value,
                "id": str(value.get("id") or path.stem),
                "revision": max(1, int(value.get("revision") or 1)),
            }
            insert_record_if_missing(record)
        except Exception:
            continue


def insert_record_if_missing(record: dict[str, Any]) -> bool:
    ensure_db_ready()
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return False
    revision = max(1, int(record.get("revision") or 1))
    payload_json = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO shared_projects (
                id, project_name, saved_at, saved_by, last_edited_at,
                created_at, created_by, polygon_count, has_boundary,
                revision, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(record.get("id") or ""),
                str(record.get("project_name") or "Untitled Project"),
                str(record.get("saved_at") or record.get("last_edited_at") or ""),
                str(record.get("saved_by") or "unknown"),
                str(record.get("last_edited_at") or record.get("saved_at") or ""),
                str(record.get("created_at") or record.get("saved_at") or ""),
                str(record.get("created_by") or record.get("saved_by") or "unknown"),
                max(0, int(record.get("polygon_count") or 0)),
                1 if record.get("has_boundary") else 0,
                revision,
                payload_json,
            ),
        )
        if cursor.rowcount:
            conn.execute(
                """
                INSERT OR IGNORE INTO shared_project_versions (
                    project_id, revision, created_at, saved_by, polygon_count,
                    has_boundary, project_name, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(record.get("id") or ""),
                    revision,
                    str(record.get("last_edited_at") or record.get("saved_at") or ""),
                    str(record.get("saved_by") or "unknown"),
                    max(0, int(record.get("polygon_count") or 0)),
                    1 if record.get("has_boundary") else 0,
                    str(record.get("project_name") or "Untitled Project"),
                    payload_json,
                ),
            )
        conn.commit()
        return bool(cursor.rowcount)


def list_records(limit: int = 100) -> list[dict[str, Any]]:
    ensure_db_ready()
    safe_limit = max(1, min(500, int(limit)))
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM shared_projects ORDER BY last_edited_at DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()
    return [record for row in rows if (record := _decode_record(row)) is not None]


def get_record(project_id: str) -> dict[str, Any] | None:
    ensure_db_ready()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM shared_projects WHERE id = ?",
            (str(project_id),),
        ).fetchone()
    return _decode_record(row)


def save_record(
    record: dict[str, Any],
    *,
    expected_revision: int | None = None,
    force: bool = False,
) -> dict[str, Any]:
    ensure_db_ready()
    payload = record.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("Project payload must be an object.")
    project_id = str(record.get("id") or "")
    payload_json = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT revision FROM shared_projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        current_revision = int(row["revision"]) if row is not None else 0
        if (
            row is not None
            and expected_revision is not None
            and int(expected_revision) != current_revision
            and not force
        ):
            conn.rollback()
            raise ProjectRevisionConflictError(current_revision)
        revision = current_revision + 1 if row is not None else 1
        conn.execute(
            """
            INSERT INTO shared_projects (
                id, project_name, saved_at, saved_by, last_edited_at,
                created_at, created_by, polygon_count, has_boundary,
                revision, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                project_name = excluded.project_name,
                saved_at = excluded.saved_at,
                saved_by = excluded.saved_by,
                last_edited_at = excluded.last_edited_at,
                polygon_count = excluded.polygon_count,
                has_boundary = excluded.has_boundary,
                revision = excluded.revision,
                payload_json = excluded.payload_json
            """,
            (
                project_id,
                str(record.get("project_name") or "Untitled Project"),
                str(record.get("saved_at") or ""),
                str(record.get("saved_by") or "unknown"),
                str(record.get("last_edited_at") or ""),
                str(record.get("created_at") or record.get("last_edited_at") or ""),
                str(record.get("created_by") or record.get("saved_by") or "unknown"),
                max(0, int(record.get("polygon_count") or 0)),
                1 if record.get("has_boundary") else 0,
                revision,
                payload_json,
            ),
        )
        conn.execute(
            """
            INSERT INTO shared_project_versions (
                project_id, revision, created_at, saved_by, polygon_count,
                has_boundary, project_name, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                revision,
                str(record.get("last_edited_at") or ""),
                str(record.get("saved_by") or "unknown"),
                max(0, int(record.get("polygon_count") or 0)),
                1 if record.get("has_boundary") else 0,
                str(record.get("project_name") or "Untitled Project"),
                payload_json,
            ),
        )
        conn.execute(
            """
            DELETE FROM shared_project_versions
            WHERE project_id = ? AND revision NOT IN (
                SELECT revision FROM shared_project_versions
                WHERE project_id = ? ORDER BY revision DESC LIMIT ?
            )
            """,
            (project_id, project_id, _max_revisions()),
        )
        conn.commit()
    saved = get_record(project_id)
    if saved is None:
        raise RuntimeError("Saved project could not be read back.")
    return saved


def delete_record(project_id: str) -> bool:
    ensure_db_ready()
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.execute("DELETE FROM shared_projects WHERE id = ?", (str(project_id),))
        conn.execute("DELETE FROM shared_project_versions WHERE project_id = ?", (str(project_id),))
        conn.commit()
    return bool(cursor.rowcount)


def list_versions(project_id: str, limit: int = 100) -> list[dict[str, Any]]:
    ensure_db_ready()
    safe_limit = max(1, min(1000, int(limit)))
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT project_id, revision, created_at, saved_by, polygon_count,
                   has_boundary, project_name
            FROM shared_project_versions
            WHERE project_id = ?
            ORDER BY revision DESC
            LIMIT ?
            """,
            (str(project_id), safe_limit),
        ).fetchall()
    return [dict(row) for row in rows]


def get_version(project_id: str, revision: int) -> dict[str, Any] | None:
    ensure_db_ready()
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT project_id, revision, created_at, saved_by, polygon_count,
                   has_boundary, project_name, payload_json
            FROM shared_project_versions
            WHERE project_id = ? AND revision = ?
            """,
            (str(project_id), int(revision)),
        ).fetchone()
    if row is None:
        return None
    try:
        payload = json.loads(str(row["payload_json"] or "{}"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return {**dict(row), "payload": payload}
