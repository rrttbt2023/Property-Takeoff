# Property Takeoff Public Launch Runbook

This is the production checklist for the $9.99 Basic subscription and managed takeoff service. Do not accept public payments until every launch gate is complete and `GET /api/ready` returns HTTP 200 in production.

## 1. Business and policy gates

- Confirm the legal business name, mailing address, support email, governing state, and tax treatment with an attorney/accountant.
- Have counsel review `frontend/public/terms.html`, `privacy.html`, `acceptable-use.html`, and `refunds.html` before launch.
- Confirm written commercial rights and attribution requirements for every imagery, geocoding, map, and export provider used by each paid feature.
- Publish a customer support response target and assign a person to account, billing, security, and managed-takeoff requests.
- Update `AUTO_MEASURE_LEGAL_VERSION` whenever legal terms materially change. Existing acceptance remains recorded against its version.

## 2. Production services

Create separate production resources. Never reuse local-development secrets.

1. Managed PostgreSQL with encryption, point-in-time recovery, and restricted network access.
2. Private S3/R2-compatible upload bucket with public access blocked, encryption enabled, CORS restricted, and lifecycle rules for deleted objects.
3. A separate private backup bucket with object versioning, encryption, and a retention/lifecycle policy.
4. Stripe live-mode product and recurring price for the Basic plan, Customer Portal, tax configuration, and webhook endpoint.
5. Transactional SMTP provider with verified sending domain, SPF, DKIM, and DMARC.
6. Cloudflare Turnstile site and secret keys restricted to the production domain.
7. Sentry frontend and backend projects with alerts routed to an actively monitored address.
8. External uptime checks for `/api/health`, `/api/ready`, and the public home page.

Use `Auto-measure-backend/.env.example` and `frontend/.env.example` as the source-of-truth variable lists. Store secrets only in Render/Vercel secret settings.

## 3. Data migration and backups

1. Stop project writes during the initial migration.
2. Create and verify a SQLite backup:

   ```bash
   cd Auto-measure-backend
   ./venv/bin/python scripts/backup.py
   ./venv/bin/python scripts/verify_backup.py backups/latest.sqlite3
   ```

3. Set `AUTO_MEASURE_DATABASE_URL` to PostgreSQL and migrate:

   ```bash
   ./venv/bin/python scripts/migrate_sqlite_to_postgres.py ./data/measurements.db
   ```

4. Compare project, user, takeoff, and version counts before reopening writes.
5. Schedule `scripts/backup.py` at least daily and `scripts/maintenance.py` daily.
6. Perform a restore into a separate database before launch and quarterly afterward. A backup that has not been restored is not considered verified.
7. Keep database backups and customer uploads in different buckets/accounts where practical.

## 4. Authentication rollout

1. Generate independent random values of at least 64 characters for `AUTO_MEASURE_PASSWORD_PEPPER` and `AUTO_MEASURE_CSRF_SECRET`.
2. Deploy first with `AUTO_MEASURE_REQUIRE_STAFF_MFA=false`.
3. Sign in as every staff operator and enroll an authenticator from Account & Security.
4. Set `AUTO_MEASURE_REQUIRE_STAFF_MFA=true`, redeploy, and confirm staff login requires a valid six-digit code.
5. Confirm registration email verification, password reset, account lockout, logout, account export, and permanent deletion.
6. Confirm browser storage contains no session token or CSRF secret; authentication must survive refresh through the secure cookie.

## 5. Stripe rollout

1. Test the Basic subscription, managed takeoff payment, cancellation, failed renewal, refund, and Customer Portal in Stripe test mode.
2. Add the production webhook URL: `https://YOUR_DOMAIN/api/billing/webhook`.
3. Subscribe it to the event types handled in `app/routes/billing.py`, then set the matching signing secret.
4. Verify checkout displays the correct legal name, $9.99 monthly price, taxes, terms consent, and support contact.
5. Switch all three Stripe values together: secret/restricted key, price ID, and webhook secret. Never mix test and live values.
6. Submit one real low-value transaction, verify the account unlocks, cancel/refund it, and confirm the audit trail.

## 6. Deployment and launch gates

Backend deployments use `Auto-measure-backend/Dockerfile`; it installs ClamAV and the PostgreSQL client. Frontend production requests use the same-origin `/api` Vercel proxy in `frontend/vercel.json`.

Run before every release:

```bash
./scripts/check.sh
cd frontend
npm audit --omit=dev --audit-level=high
npm run test:e2e
```

Required green gates:

- GitHub CI and CodeQL pass on the exact commit being deployed.
- `npm audit` reports no high/critical production issues and `pip check` reports no broken requirements.
- `https://YOUR_DOMAIN/api/health` returns 200.
- `https://YOUR_DOMAIN/api/ready` returns 200 with every check `true`.
- A clean-browser signup receives verification email and the membership offer.
- Stripe test and live smoke transactions receive signed webhook events.
- A PDF/image upload is private, malware-scanned, downloadable only by its organization, and removable by account deletion.
- Tenant-isolation tests pass and a customer cannot read another organization's project or takeoff request.
- iPad Safari and desktop Chrome/Safari complete login, map drawing, PDF measurement, autosave, refresh/reopen, and export.
- Restore drill completes and produces the expected project counts.

## 7. Controlled release

1. Invite 3-5 known companies for a two-week beta.
2. Cap managed takeoff volume manually while turnaround and pricing are validated.
3. Review Sentry errors, uptime, failed logins, support requests, Stripe failures, backup logs, and takeoff SLA daily.
4. Expand access only after seven consecutive days without data loss, cross-tenant access, failed backups, or unresolved payment defects.

## 8. Incident and rollback

- For suspected cross-tenant access, credential exposure, malicious upload, or data loss: disable public signup and affected routes, preserve logs, rotate relevant secrets, and notify the responsible operator immediately.
- Roll frontend back in Vercel and backend back in Render to the last green commit. Do not roll the database backward blindly.
- For a bad schema/data release, stop writes, take a fresh backup, assess forward repair first, and restore only after confirming the recovery point and customer impact.
- Record incident timeline, affected accounts, remediation, notifications, and prevention work.

## External actions still required

Repository code cannot create or legally approve third-party production accounts. The owner must supply PostgreSQL, S3/R2, Stripe, SMTP, Turnstile, Sentry, domain/DNS, uptime-monitor, insurance, tax, and legal-review credentials/settings. The application intentionally reports `not_ready` until the required production services are configured.
