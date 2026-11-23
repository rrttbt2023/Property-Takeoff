#!/usr/bin/env python3
import os
from datetime import UTC, datetime, timedelta

from app.repositories.audit_repository import prune_old_events
from app.repositories.database import connect_database


def _iso_days_ago(days: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).isoformat().replace("+00:00", "Z")


def main() -> int:
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    token_days = max(1, int(os.getenv("AUTO_MEASURE_TOKEN_RETENTION_DAYS", "30")))
    webhook_days = max(30, int(os.getenv("AUTO_MEASURE_WEBHOOK_RETENTION_DAYS", "365")))
    rate_limit_cutoff_ms = int((datetime.now(UTC) - timedelta(days=2)).timestamp() * 1000)
    with connect_database() as connection:
        sessions = connection.execute(
            "DELETE FROM auth_sessions WHERE expires_at <= ?", (now,)
        ).rowcount
        tokens = connection.execute(
            "DELETE FROM account_tokens WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at < ?)",
            (now, _iso_days_ago(token_days)),
        ).rowcount
        webhooks = connection.execute(
            "DELETE FROM stripe_webhook_events WHERE processed_at < ?",
            (_iso_days_ago(webhook_days),),
        ).rowcount
        limits = connection.execute(
            "DELETE FROM rate_limit_events WHERE occurred_at_ms < ?", (rate_limit_cutoff_ms,)
        ).rowcount
        connection.commit()
    prune_old_events()
    print(
        f"maintenance complete: sessions={sessions}, tokens={tokens}, "
        f"webhooks={webhooks}, rate_limits={limits}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
