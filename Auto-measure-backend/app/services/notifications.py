import os
from html import escape

from app.repositories.account_repository import get_organization_owner
from app.services.email_service import send_email


def notify_organization(
    organization_id: str,
    *,
    subject: str,
    heading: str,
    message: str,
) -> bool:
    owner = get_organization_owner(organization_id)
    recipient = str((owner or {}).get("email") or "").strip()
    if not recipient:
        return False
    app_url = str(os.getenv("AUTO_MEASURE_APP_URL", "https://mckennasitemanagement.vercel.app")).rstrip("/")
    display_name = str((owner or {}).get("display_name") or "there")
    text = f"Hi {display_name},\n\n{message}\n\nOpen Property Takeoff: {app_url}\n"
    html = f"<h2>{escape(heading)}</h2><p>Hi {escape(display_name)},</p><p>{escape(message)}</p><p><a href=\"{app_url}\">Open Property Takeoff</a></p>"
    try:
        return send_email(recipient=recipient, subject=subject, text=text, html=html)
    except Exception:
        return False
