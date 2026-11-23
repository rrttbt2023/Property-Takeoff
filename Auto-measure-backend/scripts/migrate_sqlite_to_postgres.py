#!/usr/bin/env python3
import os
import sqlite3
import sys
from pathlib import Path

import psycopg


TABLES = [
    "organizations",
    "users",
    "auth_sessions",
    "stripe_webhook_events",
    "account_tokens",
    "rate_limit_events",
    "measurements",
    "security_audit_events",
    "shared_projects",
    "shared_project_versions",
    "takeoff_requests",
    "takeoff_request_events",
    "takeoff_files",
]


def main() -> int:
    source = Path(
        sys.argv[1] if len(sys.argv) > 1 else os.getenv("AUTO_MEASURE_DB_PATH", "./data/measurements.db")
    ).expanduser().resolve()
    target = str(os.getenv("AUTO_MEASURE_DATABASE_URL") or os.getenv("DATABASE_URL") or "").strip()
    if not source.is_file():
        raise FileNotFoundError(source)
    if not target.startswith(("postgres://", "postgresql://")):
        raise RuntimeError("Set AUTO_MEASURE_DATABASE_URL to the target PostgreSQL database.")

    # Import after the target URL is known so all application tables are initialized there.
    from app.repositories.account_repository import init_db as init_accounts
    from app.repositories.audit_repository import init_db as init_audit
    from app.repositories.measurement_repository import init_db as init_measurements
    from app.repositories.project_repository import init_db as init_projects
    from app.repositories.takeoff_repository import init_db as init_takeoffs

    init_accounts()
    init_audit()
    init_measurements()
    init_projects()
    init_takeoffs()

    source_db = sqlite3.connect(source)
    source_db.row_factory = sqlite3.Row
    copied: dict[str, int] = {}
    with psycopg.connect(target) as destination:
        for table in TABLES:
            exists = source_db.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
            ).fetchone()
            if not exists:
                continue
            rows = source_db.execute(f'SELECT * FROM "{table}"').fetchall()
            if not rows:
                copied[table] = 0
                continue
            columns = list(rows[0].keys())
            column_sql = ", ".join(f'"{column}"' for column in columns)
            placeholders = ", ".join(["%s"] * len(columns))
            statement = (
                f'INSERT INTO "{table}" ({column_sql}) VALUES ({placeholders}) '
                "ON CONFLICT DO NOTHING"
            )
            for row in rows:
                destination.execute(statement, tuple(row[column] for column in columns))
            copied[table] = len(rows)
        for table in ("measurements", "security_audit_events", "takeoff_request_events"):
            destination.execute(
                """
                SELECT setval(
                    pg_get_serial_sequence(%s, 'id'),
                    COALESCE((SELECT MAX(id) FROM {}), 1),
                    true
                )
                """.format(table),
                (table,),
            )
        destination.commit()
    source_db.close()
    for table, count in copied.items():
        print(f"{table}: {count}")
    print("Migration completed. Keep the SQLite backup until the production restore drill passes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
