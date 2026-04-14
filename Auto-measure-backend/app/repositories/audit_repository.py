import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.schemas import SecurityAuditEvent


DEFAULT_DB_PATH = "./data/measurements.db"
_DB_READY = False


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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _retention_days() -> int:
    raw = str(os.getenv("AUTO_MEASURE_AUDIT_RETENTION_DAYS", "180")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 180
    return max(7, min(3650, value))


def _retention_cutoff_iso() -> str:
    cutoff = datetime.now(timezone.utc) - timedelta(days=_retention_days())
    return cutoff.isoformat().replace("+00:00", "Z")


def init_db() -> None:
    global _DB_READY
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS security_audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                username TEXT NOT NULL,
                action TEXT NOT NULL,
                outcome TEXT NOT NULL,
                resource TEXT NOT NULL DEFAULT '',
                ip_address TEXT NOT NULL DEFAULT '',
                user_agent TEXT NOT NULL DEFAULT '',
                details_json TEXT NOT NULL DEFAULT '{}'
            )
            """
        )
        _migrate_schema(conn)
        conn.commit()
    _DB_READY = True
    prune_old_events()


def _migrate_schema(conn: sqlite3.Connection) -> None:
    existing = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(security_audit_events)").fetchall()
    }
    required = {
        "created_at": "TEXT NOT NULL DEFAULT ''",
        "username": "TEXT NOT NULL DEFAULT ''",
        "action": "TEXT NOT NULL DEFAULT ''",
        "outcome": "TEXT NOT NULL DEFAULT ''",
        "resource": "TEXT NOT NULL DEFAULT ''",
        "ip_address": "TEXT NOT NULL DEFAULT ''",
        "user_agent": "TEXT NOT NULL DEFAULT ''",
        "details_json": "TEXT NOT NULL DEFAULT '{}'",
    }
    for col, ddl in required.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE security_audit_events ADD COLUMN {col} {ddl}")


def ensure_db_ready() -> None:
    if not _DB_READY:
        init_db()


def prune_old_events() -> None:
    if not _DB_READY:
        return
    cutoff = _retention_cutoff_iso()
    with _connect() as conn:
        conn.execute(
            "DELETE FROM security_audit_events WHERE created_at < ?",
            (cutoff,),
        )
        conn.commit()


def write_event(
    *,
    username: str,
    action: str,
    outcome: str,
    resource: str = "",
    ip_address: str = "",
    user_agent: str = "",
    details: dict[str, Any] | None = None,
) -> int:
    ensure_db_ready()
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO security_audit_events (
                created_at,
                username,
                action,
                outcome,
                resource,
                ip_address,
                user_agent,
                details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _now_iso(),
                str(username or "unknown")[:120],
                str(action or "unknown")[:120],
                str(outcome or "unknown")[:60],
                str(resource or "")[:240],
                str(ip_address or "")[:120],
                str(user_agent or "")[:500],
                json.dumps(details or {}, ensure_ascii=True, separators=(",", ":")),
            ),
        )
        conn.commit()
        row_id = int(cursor.lastrowid)
    # Keep retention bounded without needing a cron.
    prune_old_events()
    return row_id


def list_events(limit: int = 100) -> list[SecurityAuditEvent]:
    ensure_db_ready()
    safe_limit = max(1, min(500, int(limit)))
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM security_audit_events
            ORDER BY id DESC
            LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()
    out: list[SecurityAuditEvent] = []
    for row in rows:
        try:
            details_raw = str(row["details_json"] or "{}")
            details = json.loads(details_raw)
            if not isinstance(details, dict):
                details = {}
            out.append(
                SecurityAuditEvent(
                    id=int(row["id"]),
                    created_at=str(row["created_at"] or ""),
                    username=str(row["username"] or ""),
                    action=str(row["action"] or ""),
                    outcome=str(row["outcome"] or ""),
                    resource=str(row["resource"] or ""),
                    ip_address=str(row["ip_address"] or ""),
                    user_agent=str(row["user_agent"] or ""),
                    details=details,
                )
            )
        except Exception:
            continue
    return out
