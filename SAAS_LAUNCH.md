# Property Takeoff SaaS Launch

The application now has two commercial paths:

1. **Property Takeoff Basic** at **$9.99/month** for manual location and PDF/image measuring. AI and CV tools remain staff-only.
2. **Managed Takeoffs** for customers who submit a property, boundary, notes, and files; McKenna sends a quote and delivers measurements within 24 hours after quote acceptance.

## What Is Implemented

- Public company-account registration and sign-in.
- PBKDF2 password hashing and database-backed sessions that survive server restarts.
- Organization-level project isolation, including version history.
- Automatic migration of existing projects into the internal McKenna organization.
- Stripe Checkout for the $9.99 monthly Basic plan.
- Stripe Customer Portal for cancellation and payment-method management.
- Signature-verified, retry-safe Stripe subscription webhooks.
- Customer takeoff requests with GeoJSON boundaries and private PDF/image/KML/KMZ/JSON uploads.
- Staff quote, review, production, 24-hour due time, and delivery workflow.
- Delivery copies the completed staff project into the customer's organization and makes a project JSON download available.
- Staff-only audit and AI/CV access.

Managed takeoff quote acceptance currently records the customer's approval and starts the 24-hour clock; it does not collect the quoted one-time fee. Add a separate one-time Stripe Checkout flow before launch if managed takeoffs must be prepaid online.

## Stripe Setup

1. In a Stripe sandbox, create a product named `Property Takeoff Basic`.
2. Add a recurring monthly price of `$9.99 USD` and copy its `price_...` ID.
3. Configure the Stripe Customer Portal with cancellation and payment-method updates.
4. Add a webhook endpoint at `https://YOUR-RENDER-SERVICE/api/billing/webhook`.
5. Subscribe the endpoint to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`.
6. Put the sandbox restricted key, price ID, and webhook signing secret into Render using the names in `Auto-measure-backend/.env.example`.
7. Complete a full sandbox purchase, renewal, failed-payment, cancellation, and reactivation test before replacing the values with live-mode credentials.

Do not put Stripe secret or restricted keys in Vercel or any `VITE_` variable. They belong only on the backend.

## Render Setup

1. Attach a persistent disk and mount it at `/var/data`.
2. Set every backend variable from `Auto-measure-backend/.env.example` in Render.
3. Generate a unique password pepper and keep it unchanged. Changing it invalidates customer password hashes.
4. Install the updated `requirements.txt` and redeploy the backend.
5. Confirm `https://YOUR-RENDER-SERVICE/api/health` returns `{"status":"ok"}`.
6. Confirm new accounts, projects, sessions, uploads, and takeoff requests remain after a backend restart.

The current SQLite database and private file directory are safe for a single Render instance with a persistent disk. Before running multiple backend instances or marketing broadly, migrate these repositories to managed PostgreSQL and object storage such as S3 or Cloudflare R2.

## Vercel Setup

1. Keep `VITE_SHARED_API_BASE_URL` pointed at the Render backend.
2. Push the frontend and backend changes to `main` so Vercel builds the latest frontend.
3. Test registration, login, checkout redirect, billing return, takeoff submission, staff quoting, quote acceptance, and delivery on the production domain.
4. Confirm the production domain is included in `AUTO_MEASURE_CORS_ALLOW_ORIGINS` on Render.

## Required Before Public Marketing

- Publish Terms of Service, Privacy Policy, Acceptable Use Policy, refund/cancellation language, and a precise definition of when the 24-hour clock starts.
- Add transactional email for email verification, password reset, quote notifications, payment failures, and delivery notices.
- Add rate limiting, bot protection, error monitoring, database backups, upload malware scanning, and uptime alerts.
- Decide data-retention and deletion periods for customer plans, property imagery, boundaries, and exports.
- Verify sales-tax registrations before enabling Stripe automatic tax.
- Run an external security review and restore a production backup in a staging environment.
- Replace the generic McKenna branding/legal placeholders with the exact selling entity name, support email, mailing address, and customer-service terms.

## Release Test

Use a brand-new customer email and complete this sequence:

1. Register and confirm manual measuring remains locked before subscribing.
2. Submit a managed takeoff without subscribing.
3. Sign in as staff, review it, and send a quote.
4. Sign back in as the customer and accept the quote; confirm a due time appears.
5. Sign in as staff, mark it in progress, choose a completed project, and deliver it.
6. Confirm the customer can download the delivered project.
7. Start Stripe Checkout, use a sandbox card, and confirm location/PDF measuring unlocks after the webhook arrives.
8. Cancel in the Customer Portal and confirm access follows the Stripe subscription status.
