import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


DEFAULT_DB_PATH = "./data/measurements.db"
INTERNAL_ORGANIZATION_ID = "org-mckenna-internal"
_DB_READY = False


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _db_path() -> str:
    configured = os.getenv(
        "AUTO_MEASURE_ACCOUNT_DB_PATH",
        os.getenv("AUTO_MEASURE_DB_PATH", DEFAULT_DB_PATH),
    )
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


def _slug(value: str) -> str:
    clean = "".join(char.lower() if char.isalnum() else "-" for char in str(value or ""))
    return "-".join(part for part in clean.split("-") if part)[:80] or "workspace"


def init_db() -> None:
    global _DB_READY
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
                is_internal INTEGER NOT NULL DEFAULT 0,
                stripe_customer_id TEXT UNIQUE,
                stripe_subscription_id TEXT UNIQUE,
                subscription_status TEXT NOT NULL DEFAULT 'inactive',
                subscription_price_id TEXT,
                subscription_current_period_end TEXT,
                subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                organization_id TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'owner',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS stripe_webhook_events (
                event_id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                processed_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_users_organization
            ON users(organization_id);

            CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
            ON auth_sessions(expires_at);
            """
        )
        now = _now_iso()
        conn.execute(
            """
            INSERT INTO organizations (
                id, name, slug, is_internal, subscription_status, created_at, updated_at
            ) VALUES (?, ?, ?, 1, 'active', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                is_internal = 1,
                subscription_status = 'active',
                updated_at = excluded.updated_at
            """,
            (
                INTERNAL_ORGANIZATION_ID,
                os.getenv("AUTO_MEASURE_INTERNAL_ORG_NAME", "McKenna Site Management").strip()
                or "McKenna Site Management",
                "mckenna-site-management",
                now,
                now,
            ),
        )
        conn.commit()
    _DB_READY = True


def ensure_db_ready() -> None:
    if not _DB_READY:
        init_db()


def hash_password(password: str) -> str:
    iterations = 600_000
    salt = secrets.token_bytes(16)
    pepper = os.getenv("AUTO_MEASURE_PASSWORD_PEPPER", "").encode("utf-8")
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        str(password).encode("utf-8") + pepper,
        salt,
        iterations,
    )
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, raw_iterations, salt_hex, digest_hex = str(encoded).split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        pepper = os.getenv("AUTO_MEASURE_PASSWORD_PEPPER", "").encode("utf-8")
        candidate = hashlib.pbkdf2_hmac(
            "sha256",
            str(password).encode("utf-8") + pepper,
            bytes.fromhex(salt_hex),
            int(raw_iterations),
        )
        return hmac.compare_digest(candidate, bytes.fromhex(digest_hex))
    except Exception:
        return False


def _decode_account(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    item = dict(row)
    item["is_internal"] = bool(item.get("is_internal"))
    item["is_active"] = bool(item.get("is_active"))
    item["subscription_cancel_at_period_end"] = bool(
        item.get("subscription_cancel_at_period_end")
    )
    item["workspace_access"] = bool(item["is_internal"]) or str(
        item.get("subscription_status") or ""
    ).lower() in {"active", "trialing"}
    item["ai_access"] = bool(item["is_internal"])
    return item


ACCOUNT_SELECT = """
    SELECT
        u.id AS user_id,
        u.organization_id,
        u.email,
        u.username,
        u.display_name,
        u.password_hash,
        u.role,
        u.is_active,
        o.name AS organization_name,
        o.slug AS organization_slug,
        o.is_internal,
        o.stripe_customer_id,
        o.stripe_subscription_id,
        o.subscription_status,
        o.subscription_price_id,
        o.subscription_current_period_end,
        o.subscription_cancel_at_period_end
    FROM users u
    JOIN organizations o ON o.id = u.organization_id
"""


def get_user_by_identifier(identifier: str) -> dict[str, Any] | None:
    ensure_db_ready()
    normalized = str(identifier or "").strip()
    if not normalized:
        return None
    with _connect() as conn:
        row = conn.execute(
            ACCOUNT_SELECT + " WHERE u.username = ? COLLATE NOCASE OR u.email = ? COLLATE NOCASE",
            (normalized, normalized),
        ).fetchone()
    return _decode_account(row)


def get_user_by_id(user_id: str) -> dict[str, Any] | None:
    ensure_db_ready()
    with _connect() as conn:
        row = conn.execute(ACCOUNT_SELECT + " WHERE u.id = ?", (str(user_id),)).fetchone()
    return _decode_account(row)


def create_customer_account(
    *,
    email: str,
    password: str,
    display_name: str,
    organization_name: str,
) -> dict[str, Any]:
    ensure_db_ready()
    normalized_email = str(email or "").strip().lower()
    if get_user_by_identifier(normalized_email):
        raise ValueError("An account with that email already exists.")
    now = _now_iso()
    organization_id = f"org-{secrets.token_hex(12)}"
    user_id = f"usr-{secrets.token_hex(12)}"
    base_slug = _slug(organization_name)
    slug = f"{base_slug}-{secrets.token_hex(3)}"
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT INTO organizations (
                id, name, slug, is_internal, subscription_status, created_at, updated_at
            ) VALUES (?, ?, ?, 0, 'inactive', ?, ?)
            """,
            (organization_id, organization_name, slug, now, now),
        )
        conn.execute(
            """
            INSERT INTO users (
                id, organization_id, email, username, display_name, password_hash,
                role, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'owner', 1, ?, ?)
            """,
            (
                user_id,
                organization_id,
                normalized_email,
                normalized_email,
                display_name,
                hash_password(password),
                now,
                now,
            ),
        )
        conn.commit()
    account = get_user_by_id(user_id)
    if account is None:
        raise RuntimeError("Account could not be read after creation.")
    return account


def upsert_internal_user(username: str, password: str) -> dict[str, Any]:
    ensure_db_ready()
    normalized = str(username or "").strip()
    existing = get_user_by_identifier(normalized)
    now = _now_iso()
    password_hash = hash_password(password)
    if existing:
        with _connect() as conn:
            conn.execute(
                """
                UPDATE users
                SET organization_id = ?, password_hash = ?, is_active = 1,
                    role = 'admin', updated_at = ?
                WHERE id = ?
                """,
                (INTERNAL_ORGANIZATION_ID, password_hash, now, existing["user_id"]),
            )
            conn.commit()
        account = get_user_by_id(existing["user_id"])
        if account:
            return account
    user_id = f"usr-{secrets.token_hex(12)}"
    email = normalized if "@" in normalized else f"{_slug(normalized)}@internal.local"
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO users (
                id, organization_id, email, username, display_name, password_hash,
                role, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, ?, ?)
            """,
            (
                user_id,
                INTERNAL_ORGANIZATION_ID,
                email,
                normalized,
                normalized,
                password_hash,
                now,
                now,
            ),
        )
        conn.commit()
    account = get_user_by_id(user_id)
    if account is None:
        raise RuntimeError("Internal account could not be created.")
    return account


def create_session(user_id: str, token_hash: str, expires_at: str) -> None:
    ensure_db_ready()
    now = _now_iso()
    with _connect() as conn:
        conn.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
        conn.execute(
            """
            INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (token_hash, str(user_id), now, expires_at, now),
        )
        conn.commit()


def get_session(token_hash: str) -> dict[str, Any] | None:
    ensure_db_ready()
    now = _now_iso()
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT s.expires_at, s.user_id
            FROM auth_sessions s
            WHERE s.token_hash = ? AND s.expires_at > ?
            """,
            (str(token_hash), now),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?",
                (now, str(token_hash)),
            )
            conn.commit()
    if row is None:
        return None
    account = get_user_by_id(str(row["user_id"]))
    if not account or not account.get("is_active"):
        return None
    return {**account, "expires_at": str(row["expires_at"])}


def delete_session(token_hash: str) -> None:
    ensure_db_ready()
    with _connect() as conn:
        conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (str(token_hash),))
        conn.commit()


def get_organization(organization_id: str) -> dict[str, Any] | None:
    ensure_db_ready()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM organizations WHERE id = ?", (str(organization_id),)
        ).fetchone()
    if row is None:
        return None
    item = dict(row)
    item["is_internal"] = bool(item.get("is_internal"))
    item["subscription_cancel_at_period_end"] = bool(
        item.get("subscription_cancel_at_period_end")
    )
    return item


def get_organization_by_stripe_customer(customer_id: str) -> dict[str, Any] | None:
    ensure_db_ready()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM organizations WHERE stripe_customer_id = ?",
            (str(customer_id),),
        ).fetchone()
    return dict(row) if row else None


def update_organization_billing(
    organization_id: str,
    *,
    customer_id: str | None = None,
    subscription_id: str | None = None,
    status: str | None = None,
    price_id: str | None = None,
    current_period_end: str | None = None,
    cancel_at_period_end: bool | None = None,
) -> None:
    ensure_db_ready()
    fields = ["updated_at = ?"]
    values: list[Any] = [_now_iso()]
    updates = {
        "stripe_customer_id": customer_id,
        "stripe_subscription_id": subscription_id,
        "subscription_status": status,
        "subscription_price_id": price_id,
        "subscription_current_period_end": current_period_end,
    }
    for column, value in updates.items():
        if value is not None:
            fields.append(f"{column} = ?")
            values.append(str(value))
    if cancel_at_period_end is not None:
        fields.append("subscription_cancel_at_period_end = ?")
        values.append(1 if cancel_at_period_end else 0)
    values.append(str(organization_id))
    with _connect() as conn:
        conn.execute(
            f"UPDATE organizations SET {', '.join(fields)} WHERE id = ?",
            values,
        )
        conn.commit()


def mark_webhook_processed(event_id: str, event_type: str) -> bool:
    ensure_db_ready()
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type, processed_at)
            VALUES (?, ?, ?)
            """,
            (str(event_id), str(event_type), _now_iso()),
        )
        conn.commit()
    return bool(cursor.rowcount)


def is_webhook_processed(event_id: str) -> bool:
    ensure_db_ready()
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM stripe_webhook_events WHERE event_id = ?",
            (str(event_id),),
        ).fetchone()
    return row is not None
