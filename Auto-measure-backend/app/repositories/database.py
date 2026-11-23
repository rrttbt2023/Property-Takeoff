import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable


DEFAULT_DB_PATH = "./data/measurements.db"


def database_url() -> str:
    return str(
        os.getenv("AUTO_MEASURE_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or ""
    ).strip()


def database_backend() -> str:
    return "postgresql" if database_url().startswith(("postgres://", "postgresql://")) else "sqlite"


def sqlite_path(default_path: str = DEFAULT_DB_PATH) -> str:
    configured = os.getenv("AUTO_MEASURE_DB_PATH", default_path)
    path = Path(configured).expanduser()
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    return str(path)


class CursorAdapter:
    def __init__(self, cursor: Any = None, *, rows: list[dict[str, Any]] | None = None):
        self._cursor = cursor
        self._rows = rows
        self._row_index = 0
        self.lastrowid = getattr(cursor, "lastrowid", None)
        self.rowcount = getattr(cursor, "rowcount", 0) if cursor is not None else len(rows or [])

    def fetchone(self) -> Any:
        if self._rows is not None:
            if self._row_index >= len(self._rows):
                return None
            row = self._rows[self._row_index]
            self._row_index += 1
            return row
        return self._cursor.fetchone() if self._cursor is not None else None

    def fetchall(self) -> list[Any]:
        if self._rows is not None:
            rows = self._rows[self._row_index :]
            self._row_index = len(self._rows)
            return rows
        return list(self._cursor.fetchall()) if self._cursor is not None else []


class DatabaseConnection:
    def __init__(self, raw: Any, backend: str):
        self._raw = raw
        self.backend = backend

    def __enter__(self) -> "DatabaseConnection":
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        try:
            if exc_type is None:
                self.commit()
            else:
                self.rollback()
        finally:
            self._raw.close()

    def commit(self) -> None:
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def executescript(self, script: str) -> None:
        if self.backend == "sqlite":
            self._raw.executescript(script)
            return
        for statement in (part.strip() for part in script.split(";")):
            if statement:
                self.execute(statement)

    def _postgres_table_info(self, table: str) -> CursorAdapter:
        cursor = self._raw.execute(
            """
            SELECT
                c.column_name AS name,
                CASE WHEN EXISTS (
                    SELECT 1
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                      AND tc.table_schema = c.table_schema
                      AND tc.table_name = c.table_name
                      AND kcu.column_name = c.column_name
                ) THEN 1 ELSE 0 END AS pk
            FROM information_schema.columns c
            WHERE c.table_schema = current_schema() AND c.table_name = %s
            ORDER BY c.ordinal_position
            """,
            (table,),
        )
        return CursorAdapter(cursor)

    @staticmethod
    def _postgres_sql(sql: str) -> str:
        normalized = re.sub(r"\s+COLLATE\s+NOCASE", "", sql, flags=re.IGNORECASE)
        normalized = re.sub(
            r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT",
            "BIGSERIAL PRIMARY KEY",
            normalized,
            flags=re.IGNORECASE,
        )
        ignored_insert = bool(re.search(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", normalized, re.I))
        normalized = re.sub(
            r"\bINSERT\s+OR\s+IGNORE\s+INTO\b",
            "INSERT INTO",
            normalized,
            flags=re.IGNORECASE,
        )
        if ignored_insert and not re.search(r"\bON\s+CONFLICT\b", normalized, re.I):
            normalized = normalized.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
        return normalized.replace("?", "%s")

    def execute(self, sql: str, params: Iterable[Any] | None = None) -> CursorAdapter:
        values = tuple(params or ())
        stripped = str(sql or "").strip()
        if self.backend == "postgresql":
            table_info = re.fullmatch(
                r"PRAGMA\s+table_info\(([^)]+)\)", stripped, flags=re.IGNORECASE
            )
            if table_info:
                return self._postgres_table_info(table_info.group(1).strip())
            if stripped.upper().startswith("PRAGMA "):
                return CursorAdapter(rows=[])
            if stripped.upper() == "BEGIN IMMEDIATE":
                return CursorAdapter(self._raw.execute("BEGIN"))
            normalized = self._postgres_sql(stripped)
            needs_id = bool(
                re.match(r"INSERT\s+INTO\s+(security_audit_events|measurements)\b", normalized, re.I)
            ) and " RETURNING " not in normalized.upper()
            if needs_id:
                normalized = normalized.rstrip().rstrip(";") + " RETURNING id"
            cursor = self._raw.execute(normalized, values)
            adapted = CursorAdapter(cursor)
            if needs_id:
                row = cursor.fetchone()
                adapted.lastrowid = int(row["id"] if isinstance(row, dict) else row[0])
            return adapted
        return CursorAdapter(self._raw.execute(stripped, values))


def connect_database(default_path: str = DEFAULT_DB_PATH) -> DatabaseConnection:
    url = database_url()
    if url.startswith(("postgres://", "postgresql://")):
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as error:
            raise RuntimeError("PostgreSQL is configured but psycopg is not installed.") from error
        return DatabaseConnection(psycopg.connect(url, row_factory=dict_row), "postgresql")

    db_file = sqlite_path(default_path)
    Path(db_file).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_file, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return DatabaseConnection(conn, "sqlite")
