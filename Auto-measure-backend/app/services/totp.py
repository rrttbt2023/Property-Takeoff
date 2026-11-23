import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote


def generate_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _code(secret: str, counter: int) -> str:
    padded = str(secret).upper() + "=" * ((8 - len(str(secret)) % 8) % 8)
    key = base64.b32decode(padded, casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{value:06d}"


def verify_totp(secret: str, code: str, *, at_time: int | None = None) -> bool:
    candidate = "".join(char for char in str(code or "") if char.isdigit())
    if len(candidate) != 6:
        return False
    counter = int(at_time if at_time is not None else time.time()) // 30
    return any(hmac.compare_digest(candidate, _code(secret, counter + offset)) for offset in (-1, 0, 1))


def provisioning_url(secret: str, email: str) -> str:
    label = quote(f"Property Takeoff:{email}")
    issuer = quote("Property Takeoff")
    return f"otpauth://totp/{label}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits=6&period=30"
