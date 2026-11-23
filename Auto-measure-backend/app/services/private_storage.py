import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import BinaryIO


def storage_backend() -> str:
    configured = str(os.getenv("AUTO_MEASURE_STORAGE_BACKEND", "local")).strip().lower()
    return "s3" if configured in {"s3", "r2", "object"} else "local"


def upload_root() -> Path:
    configured = os.getenv("AUTO_MEASURE_PRIVATE_UPLOAD_DIR", "./data/private_uploads")
    path = Path(configured).expanduser()
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def _s3_client():
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise RuntimeError("S3 storage is configured but boto3 is not installed.") from error
    kwargs = {
        "service_name": "s3",
        "region_name": os.getenv("AUTO_MEASURE_S3_REGION") or None,
        "endpoint_url": os.getenv("AUTO_MEASURE_S3_ENDPOINT_URL") or None,
        "aws_access_key_id": os.getenv("AUTO_MEASURE_S3_ACCESS_KEY_ID") or None,
        "aws_secret_access_key": os.getenv("AUTO_MEASURE_S3_SECRET_ACCESS_KEY") or None,
        "config": Config(
            connect_timeout=3,
            read_timeout=4,
            retries={"max_attempts": 1, "mode": "standard"},
        ),
    }
    return boto3.client(**{key: value for key, value in kwargs.items() if value})


def _bucket() -> str:
    bucket = str(os.getenv("AUTO_MEASURE_S3_BUCKET", "")).strip()
    if not bucket:
        raise RuntimeError("AUTO_MEASURE_S3_BUCKET is required for object storage.")
    return bucket


def storage_configuration_valid() -> bool:
    if storage_backend() != "s3":
        return True
    bucket = str(os.getenv("AUTO_MEASURE_S3_BUCKET", "")).strip()
    endpoint = str(os.getenv("AUTO_MEASURE_S3_ENDPOINT_URL", "")).strip()
    access_key = str(os.getenv("AUTO_MEASURE_S3_ACCESS_KEY_ID", "")).strip()
    secret_key = str(os.getenv("AUTO_MEASURE_S3_SECRET_ACCESS_KEY", "")).strip()
    use_iam_role = str(os.getenv("AUTO_MEASURE_S3_USE_IAM_ROLE", "")).lower() in {
        "1", "true", "yes", "on"
    }
    if not bucket or bool(access_key) != bool(secret_key):
        return False
    return bool(access_key and secret_key) or (not endpoint and use_iam_role)


def storage_ready(*, probe: bool = False) -> bool:
    if not storage_configuration_valid():
        return False
    if storage_backend() != "s3" or not probe:
        return True
    try:
        _s3_client().head_bucket(Bucket=_bucket())
        return True
    except Exception:
        return False


def malware_scanner_available() -> bool:
    command = str(os.getenv("AUTO_MEASURE_CLAMSCAN_COMMAND", "clamscan")).strip() or "clamscan"
    return bool(shutil.which(command) or (Path(command).is_file() and os.access(command, os.X_OK)))


def validate_file_content(path: Path, suffix: str) -> None:
    prefix = path.read_bytes()[:4096]
    suffix = suffix.lower()
    valid = False
    if suffix == ".pdf":
        valid = prefix.startswith(b"%PDF-")
    elif suffix == ".png":
        valid = prefix.startswith(b"\x89PNG\r\n\x1a\n")
    elif suffix in {".jpg", ".jpeg"}:
        valid = prefix.startswith(b"\xff\xd8\xff")
    elif suffix in {".tif", ".tiff"}:
        valid = prefix.startswith((b"II*\x00", b"MM\x00*"))
    elif suffix == ".json":
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
            valid = isinstance(parsed, (dict, list))
        except Exception:
            valid = False
    elif suffix == ".kml":
        try:
            text = path.read_text(encoding="utf-8", errors="strict").lstrip()[:8192].lower()
            valid = "<kml" in text and "<!doctype" not in text
        except Exception:
            valid = False
    elif suffix == ".kmz":
        try:
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                expanded_size = sum(max(0, item.file_size) for item in members)
                valid = (
                    len(members) <= 250
                    and expanded_size <= 100 * 1024 * 1024
                    and any(item.filename.lower().endswith(".kml") for item in members)
                    and all(not Path(item.filename).is_absolute() and ".." not in Path(item.filename).parts for item in members)
                )
        except Exception:
            valid = False
    if not valid:
        raise ValueError("The uploaded file contents do not match the selected file type.")


def scan_file(path: Path) -> None:
    mode = str(os.getenv("AUTO_MEASURE_UPLOAD_SCAN_MODE", "optional")).strip().lower()
    if mode == "off":
        return
    command = str(os.getenv("AUTO_MEASURE_CLAMSCAN_COMMAND", "clamscan")).strip() or "clamscan"
    try:
        result = subprocess.run(
            [command, "--no-summary", str(path)],
            capture_output=True,
            check=False,
            text=True,
            timeout=90,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        if mode == "required":
            raise RuntimeError("Upload scanning is required but the malware scanner is unavailable.") from error
        return
    if result.returncode == 1:
        raise ValueError("The uploaded file was rejected by the malware scanner.")
    if result.returncode not in {0, 1} and mode == "required":
        raise RuntimeError("The malware scanner could not verify this upload.")


def temporary_upload_file() -> tuple[BinaryIO, Path]:
    handle = tempfile.NamedTemporaryFile(prefix="takeoff-", suffix=".upload", delete=False)
    return handle, Path(handle.name)


def store_private_file(source: Path, storage_key: str, content_type: str) -> None:
    if storage_backend() == "s3":
        extra = {"ContentType": content_type}
        encryption = str(os.getenv("AUTO_MEASURE_S3_SERVER_SIDE_ENCRYPTION", "")).strip()
        if encryption:
            extra["ServerSideEncryption"] = encryption
        _s3_client().upload_file(str(source), _bucket(), storage_key, ExtraArgs=extra)
        return
    destination = (upload_root() / storage_key).resolve()
    root = upload_root().resolve()
    if root not in destination.parents:
        raise ValueError("Invalid storage key.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, destination)


def local_private_file(storage_key: str) -> Path | None:
    if storage_backend() != "local":
        return None
    path = (upload_root() / storage_key).resolve()
    if upload_root().resolve() not in path.parents:
        return None
    return path


def private_download_url(storage_key: str, original_name: str) -> str | None:
    if storage_backend() != "s3":
        return None
    return str(
        _s3_client().generate_presigned_url(
            "get_object",
            Params={
                "Bucket": _bucket(),
                "Key": storage_key,
                "ResponseContentDisposition": f'attachment; filename="{Path(original_name).name}"',
            },
            ExpiresIn=300,
        )
    )


def delete_private_file(storage_key: str) -> None:
    if storage_backend() == "s3":
        _s3_client().delete_object(Bucket=_bucket(), Key=str(storage_key))
        return
    path = local_private_file(storage_key)
    if path is not None:
        path.unlink(missing_ok=True)
