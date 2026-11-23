#!/usr/bin/env python3
import os
import shutil
import sqlite3
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path


def _upload_backup(path: Path, timestamp: str) -> None:
    bucket = str(os.getenv("AUTO_MEASURE_BACKUP_S3_BUCKET", "")).strip()
    if not bucket:
        return
    import boto3
    from botocore.config import Config

    prefix = str(os.getenv("AUTO_MEASURE_BACKUP_S3_PREFIX", "database")).strip("/")
    endpoint = str(os.getenv("AUTO_MEASURE_BACKUP_S3_ENDPOINT_URL", "")).strip() or None
    client = boto3.client(
        "s3",
        region_name=os.getenv("AUTO_MEASURE_BACKUP_S3_REGION") or None,
        endpoint_url=endpoint,
        aws_access_key_id=os.getenv("AUTO_MEASURE_BACKUP_S3_ACCESS_KEY_ID") or None,
        aws_secret_access_key=os.getenv("AUTO_MEASURE_BACKUP_S3_SECRET_ACCESS_KEY") or None,
        config=Config(connect_timeout=5, read_timeout=60, retries={"max_attempts": 3}),
    )
    encryption = str(os.getenv("AUTO_MEASURE_BACKUP_S3_SERVER_SIDE_ENCRYPTION", "AES256")).strip()
    extra = {"ServerSideEncryption": encryption} if encryption else {}
    versioned_key = f"{prefix}/{timestamp}/{path.name}" if prefix else f"{timestamp}/{path.name}"
    latest_key = f"{prefix}/latest{path.suffix}" if prefix else f"latest{path.suffix}"
    client.upload_file(str(path), bucket, versioned_key, ExtraArgs=extra)
    client.copy_object(
        Bucket=bucket,
        CopySource={"Bucket": bucket, "Key": versioned_key},
        Key=latest_key,
        **({"ServerSideEncryption": encryption} if encryption else {}),
    )
    print(f"s3://{bucket}/{versioned_key}")


def _prune_local_backups(backup_dir: Path) -> None:
    retention_days = max(1, int(os.getenv("AUTO_MEASURE_BACKUP_LOCAL_RETENTION_DAYS", "14")))
    cutoff = datetime.now(UTC) - timedelta(days=retention_days)
    for candidate in backup_dir.glob("property-takeoff-*"):
        modified = datetime.fromtimestamp(candidate.stat().st_mtime, UTC)
        if candidate.is_file() and modified < cutoff:
            candidate.unlink(missing_ok=True)


def main() -> int:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = Path(os.getenv("AUTO_MEASURE_BACKUP_DIR", "./backups")).expanduser().resolve()
    backup_dir.mkdir(parents=True, exist_ok=True)
    database_url = str(os.getenv("AUTO_MEASURE_DATABASE_URL") or os.getenv("DATABASE_URL") or "")
    if database_url.startswith(("postgres://", "postgresql://")):
        destination = backup_dir / f"property-takeoff-{timestamp}.dump"
        subprocess.run(
            ["pg_dump", "--format=custom", "--no-owner", "--file", str(destination), database_url],
            check=True,
        )
    else:
        source = Path(os.getenv("AUTO_MEASURE_DB_PATH", "./data/measurements.db")).expanduser().resolve()
        destination = backup_dir / f"property-takeoff-{timestamp}.sqlite3"
        with sqlite3.connect(source) as source_db, sqlite3.connect(destination) as backup_db:
            source_db.backup(backup_db)
            result = backup_db.execute("PRAGMA integrity_check").fetchone()
            if not result or str(result[0]).lower() != "ok":
                raise RuntimeError("SQLite backup failed its integrity check.")
    latest = backup_dir / ("latest" + destination.suffix)
    shutil.copy2(destination, latest)
    _upload_backup(destination, timestamp)
    _prune_local_backups(backup_dir)
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
