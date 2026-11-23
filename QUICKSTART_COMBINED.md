# Combine Frontend + Backend Fast

## 1) Run both in development

From the project root:

```bash
./scripts/dev.sh
```

- Frontend: `http://localhost:5173`
- Backend API: `http://127.0.0.1:8000`
- Backend health: `http://127.0.0.1:8000/api/health`

Shared file login now requires explicit backend credentials. Before starting the
backend, configure one of:

```bash
export AUTO_MEASURE_SHARED_AUTH_USER="your-user"
export AUTO_MEASURE_SHARED_AUTH_PASS="your-password"
```

or

```bash
export AUTO_MEASURE_SHARED_AUTH_USERS="estimator:secret123,reviewer:secret456"
```

### Production project durability

SQLite is the local-development default. Public production requires managed
PostgreSQL through `AUTO_MEASURE_DATABASE_URL`, private S3/R2 storage, and
verified off-site backups. Follow `PUBLIC_LAUNCH_RUNBOOK.md`; production
readiness intentionally fails if these services are missing.

For local development only:

```bash
export AUTO_MEASURE_DB_PATH="/var/data/property-takeoff.db"
export AUTO_MEASURE_TRAINING_FEEDBACK_DIR="/var/data/training-corrections"
```

The second path keeps operator-corrected CV masks across backend restarts. The
frontend still downloads a correction ZIP as a local backup if the inbox is unavailable.

Existing `data/shared_projects/*.json` files are imported automatically the
first time the revision database starts.

In frontend code, call backend with relative API paths like:

- `/api/measurements`
- `/api/measurements/upload`

Vite now proxies `/api/*` to the FastAPI server.

## 1b) Run repo checks

From the project root:

```bash
./scripts/check.sh
```

This runs:

- frontend lint
- frontend production build
- backend tests

The public signup browser test is separate because it starts local servers:

```bash
cd frontend
npx playwright install chromium
npm run test:e2e
```

## 2) Serve built frontend from backend (single backend process)

Build frontend:

```bash
cd frontend
npm run build
```

Run backend:

```bash
cd ../Auto-measure-backend
./venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then open:

- UI: `http://127.0.0.1:8000/ui`
- API: `http://127.0.0.1:8000/api/measurements`
