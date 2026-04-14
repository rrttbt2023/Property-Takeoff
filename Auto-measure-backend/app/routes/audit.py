from fastapi import APIRouter, Depends, Query

from app.repositories.audit_repository import list_events
from app.schemas import SecurityAuditEvent
from app.services.shared_auth import require_shared_access

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/events", response_model=list[SecurityAuditEvent])
def list_security_audit_events(
    limit: int = Query(100, ge=1, le=500),
    _: dict[str, str] = Depends(require_shared_access),
) -> list[SecurityAuditEvent]:
    return list_events(limit=limit)
