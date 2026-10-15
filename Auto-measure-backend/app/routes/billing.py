import os
import secrets
import string
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from app.repositories.account_repository import (
    get_organization,
    get_organization_by_stripe_customer,
    is_webhook_processed,
    mark_webhook_processed,
    update_organization_billing,
)
from app.schemas import BillingSessionResponse, BillingStatusResponse
from app.services.shared_auth import require_shared_access


router = APIRouter(prefix="/billing", tags=["billing"])


def _stripe_module():
    try:
        import stripe
    except ImportError as error:
        raise HTTPException(status_code=503, detail="Stripe Billing is not installed.") from error
    api_key = str(os.getenv("STRIPE_RESTRICTED_KEY") or os.getenv("STRIPE_SECRET_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="Stripe Billing is not configured.")
    stripe.api_key = api_key
    return stripe


def _app_url() -> str:
    return str(
        os.getenv("AUTO_MEASURE_APP_URL", "https://mckennasitemanagement.vercel.app")
    ).strip().rstrip("/")


def _integration_identifier() -> str:
    suffix = "".join(secrets.choice(string.ascii_lowercase) for _ in range(8))
    return f"property_takeoff_{suffix}"


def _object_value(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _unix_iso(value: Any) -> str | None:
    try:
        return datetime.fromtimestamp(int(value), UTC).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


@router.get("/status", response_model=BillingStatusResponse)
def billing_status(session: dict = Depends(require_shared_access)) -> BillingStatusResponse:
    organization = get_organization(str(session.get("organization_id") or "")) or {}
    status = str(organization.get("subscription_status") or "inactive")
    return BillingStatusResponse(
        subscription_status=status,
        workspace_access=bool(organization.get("is_internal")) or status in {"active", "trialing"},
        current_period_end=organization.get("subscription_current_period_end"),
        cancel_at_period_end=bool(organization.get("subscription_cancel_at_period_end")),
        customer_portal_available=bool(organization.get("stripe_customer_id")),
    )


@router.post("/checkout", response_model=BillingSessionResponse)
def create_subscription_checkout(
    session: dict = Depends(require_shared_access),
) -> BillingSessionResponse:
    if session.get("is_staff"):
        raise HTTPException(status_code=409, detail="Staff workspaces already include full access.")
    stripe = _stripe_module()
    price_id = str(os.getenv("STRIPE_BASIC_PRICE_ID", "")).strip()
    if not price_id:
        raise HTTPException(status_code=503, detail="The Basic subscription price is not configured.")
    organization_id = str(session.get("organization_id") or "")
    organization = get_organization(organization_id) or {}
    if str(organization.get("subscription_status") or "") in {"active", "trialing"}:
        raise HTTPException(
            status_code=409,
            detail="This workspace already has an active Basic subscription.",
        )
    metadata = {
        "organization_id": organization_id,
        "integration_identifier": _integration_identifier(),
    }
    params: dict[str, Any] = {
        "mode": "subscription",
        "line_items": [{"price": price_id, "quantity": 1}],
        "client_reference_id": organization_id,
        "success_url": f"{_app_url()}/?billing=success",
        "cancel_url": f"{_app_url()}/?billing=canceled",
        "allow_promotion_codes": True,
        "metadata": metadata,
        "subscription_data": {"metadata": metadata},
    }
    customer_id = str(organization.get("stripe_customer_id") or "")
    if customer_id:
        params["customer"] = customer_id
    else:
        params["customer_email"] = str(session.get("email") or "")
    checkout = stripe.checkout.Session.create(**params)
    url = str(_object_value(checkout, "url") or "")
    if not url:
        raise HTTPException(status_code=502, detail="Stripe did not return a checkout URL.")
    return BillingSessionResponse(url=url)


@router.post("/portal", response_model=BillingSessionResponse)
def create_billing_portal(
    session: dict = Depends(require_shared_access),
) -> BillingSessionResponse:
    stripe = _stripe_module()
    organization = get_organization(str(session.get("organization_id") or "")) or {}
    customer_id = str(organization.get("stripe_customer_id") or "")
    if not customer_id:
        raise HTTPException(status_code=409, detail="Subscribe before opening billing settings.")
    portal = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=f"{_app_url()}/?billing=portal-return",
    )
    url = str(_object_value(portal, "url") or "")
    if not url:
        raise HTTPException(status_code=502, detail="Stripe did not return a portal URL.")
    return BillingSessionResponse(url=url)


def _organization_id_for_object(item: Any) -> str:
    metadata = _object_value(item, "metadata", {}) or {}
    organization_id = str(_object_value(metadata, "organization_id", "") or "")
    if organization_id:
        return organization_id
    customer_id = str(_object_value(item, "customer", "") or "")
    organization = get_organization_by_stripe_customer(customer_id) if customer_id else None
    return str((organization or {}).get("id") or "")


@router.post("/webhook")
async def stripe_webhook(request: Request) -> dict[str, bool]:
    stripe = _stripe_module()
    webhook_secret = str(os.getenv("STRIPE_WEBHOOK_SECRET", "")).strip()
    if not webhook_secret:
        raise HTTPException(status_code=503, detail="Stripe webhook signing is not configured.")
    payload = await request.body()
    signature = str(request.headers.get("stripe-signature") or "")
    try:
        event = stripe.Webhook.construct_event(payload, signature, webhook_secret)
    except Exception as error:
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook signature.") from error
    event_id = str(_object_value(event, "id") or "")
    event_type = str(_object_value(event, "type") or "")
    if not event_id or is_webhook_processed(event_id):
        return {"received": True}
    data = _object_value(event, "data", {}) or {}
    item = _object_value(data, "object", {}) or {}

    if event_type == "checkout.session.completed":
        organization_id = str(_object_value(item, "client_reference_id", "") or "")
        if organization_id:
            update_organization_billing(
                organization_id,
                customer_id=str(_object_value(item, "customer", "") or "") or None,
                subscription_id=str(_object_value(item, "subscription", "") or "") or None,
                status="active" if str(_object_value(item, "payment_status", "")) == "paid" else None,
            )
    elif event_type.startswith("customer.subscription."):
        organization_id = _organization_id_for_object(item)
        if organization_id:
            subscription_items = _object_value(_object_value(item, "items", {}), "data", []) or []
            price_id = ""
            if subscription_items:
                price_id = str(
                    _object_value(_object_value(subscription_items[0], "price", {}), "id", "") or ""
                )
            update_organization_billing(
                organization_id,
                customer_id=str(_object_value(item, "customer", "") or "") or None,
                subscription_id=str(_object_value(item, "id", "") or "") or None,
                status=str(_object_value(item, "status", "") or "inactive"),
                price_id=price_id or None,
                current_period_end=_unix_iso(_object_value(item, "current_period_end")),
                cancel_at_period_end=bool(_object_value(item, "cancel_at_period_end", False)),
            )
    elif event_type in {"invoice.paid", "invoice.payment_failed"}:
        organization_id = _organization_id_for_object(item)
        if organization_id:
            update_organization_billing(
                organization_id,
                customer_id=str(_object_value(item, "customer", "") or "") or None,
                subscription_id=str(_object_value(item, "subscription", "") or "") or None,
                status="active" if event_type == "invoice.paid" else "past_due",
            )
    mark_webhook_processed(event_id, event_type)
    return {"received": True}
