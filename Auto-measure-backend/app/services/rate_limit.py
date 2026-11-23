import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import HTTPException, Request

from app.repositories.database import connect_database, database_backend


_events: dict[str, deque[float]] = defaultdict(deque)
_lock = Lock()


def client_ip(request: Request) -> str:
    forwarded = str(request.headers.get("x-forwarded-for", "")).split(",")[0].strip()
    return (forwarded or str(request.client.host if request.client else "unknown"))[:120]


def enforce_rate_limit(key: str, *, limit: int, window_seconds: int) -> None:
    if database_backend() == "postgresql":
        _enforce_database_rate_limit(key, limit=limit, window_seconds=window_seconds)
        return
    now = time.monotonic()
    cutoff = now - max(1, int(window_seconds))
    with _lock:
        bucket = _events[str(key)]
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= max(1, int(limit)):
            retry_after = max(1, int(window_seconds - (now - bucket[0])))
            raise HTTPException(
                status_code=429,
                detail="Too many attempts. Please wait and try again.",
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)


def _enforce_database_rate_limit(key: str, *, limit: int, window_seconds: int) -> None:
    now_ms = int(time.time() * 1000)
    window_ms = max(1, int(window_seconds)) * 1000
    cutoff_ms = now_ms - window_ms
    normalized_key = str(key)[:240]
    with connect_database() as connection:
        # The advisory transaction lock makes the count-and-insert atomic across web instances.
        connection.execute("SELECT pg_advisory_xact_lock(hashtext(?))", (normalized_key,))
        connection.execute(
            "DELETE FROM rate_limit_events WHERE bucket_key = ? AND occurred_at_ms <= ?",
            (normalized_key, cutoff_ms),
        )
        rows = connection.execute(
            "SELECT occurred_at_ms FROM rate_limit_events WHERE bucket_key = ? ORDER BY occurred_at_ms",
            (normalized_key,),
        ).fetchall()
        if len(rows) >= max(1, int(limit)):
            oldest = int(rows[0]["occurred_at_ms"])
            retry_after = max(1, int((window_ms - (now_ms - oldest) + 999) / 1000))
            connection.rollback()
            raise HTTPException(
                status_code=429,
                detail="Too many attempts. Please wait and try again.",
                headers={"Retry-After": str(retry_after)},
            )
        connection.execute(
            "INSERT INTO rate_limit_events (bucket_key, occurred_at_ms) VALUES (?, ?)",
            (normalized_key, now_ms),
        )
        connection.commit()


def reset_rate_limits() -> None:
    with _lock:
        _events.clear()
    if database_backend() == "postgresql":
        with connect_database() as connection:
            connection.execute("DELETE FROM rate_limit_events")
            connection.commit()
