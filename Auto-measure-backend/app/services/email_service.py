import os
import smtplib
from email.message import EmailMessage
from html import escape


def email_configured() -> bool:
    return bool(str(os.getenv("AUTO_MEASURE_SMTP_HOST", "")).strip())


def send_email(*, recipient: str, subject: str, text: str, html: str | None = None) -> bool:
    host = str(os.getenv("AUTO_MEASURE_SMTP_HOST", "")).strip()
    if not host:
        return False
    port = int(str(os.getenv("AUTO_MEASURE_SMTP_PORT", "587")).strip() or "587")
    username = str(os.getenv("AUTO_MEASURE_SMTP_USERNAME", "")).strip()
    password = str(os.getenv("AUTO_MEASURE_SMTP_PASSWORD", ""))
    sender = str(os.getenv("AUTO_MEASURE_EMAIL_FROM", "support@mckennasitemanagement.com")).strip()
    message = EmailMessage()
    message["From"] = sender
    message["To"] = str(recipient).strip()
    message["Subject"] = str(subject).strip()
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")
    use_ssl = str(os.getenv("AUTO_MEASURE_SMTP_SSL", "false")).lower() in {"1", "true", "yes"}
    smtp_class = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
    with smtp_class(host, port, timeout=20) as server:
        if not use_ssl:
            server.starttls()
        if username:
            server.login(username, password)
        server.send_message(message)
    return True


def send_action_email(*, recipient: str, display_name: str, action: str, token: str) -> bool:
    app_url = str(os.getenv("AUTO_MEASURE_APP_URL", "https://mckennasitemanagement.vercel.app")).rstrip("/")
    if action == "verify":
        url = f"{app_url}/?verify={token}"
        subject = "Verify your Property Takeoff email"
        heading = "Verify your email"
        instruction = "Confirm this address to finish securing your Property Takeoff workspace."
    else:
        url = f"{app_url}/?reset={token}"
        subject = "Reset your Property Takeoff password"
        heading = "Reset your password"
        instruction = "Use this secure link to choose a new password. The link expires shortly."
    text = f"Hi {display_name or 'there'},\n\n{instruction}\n\n{url}\n\nIf you did not request this, you can ignore this email."
    html = (
        f"<h2>{escape(heading)}</h2><p>Hi {escape(display_name or 'there')},</p><p>{escape(instruction)}</p>"
        f'<p><a href="{url}">{heading}</a></p><p>If you did not request this, you can ignore this email.</p>'
    )
    return send_email(recipient=recipient, subject=subject, text=text, html=html)
