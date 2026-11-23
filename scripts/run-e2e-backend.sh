#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${ROOT_DIR}/Auto-measure-backend"
export AUTO_MEASURE_ENV=development
export AUTO_MEASURE_DB_PATH="/tmp/property-takeoff-e2e-${$}.db"
export AUTO_MEASURE_ALLOW_PUBLIC_SIGNUP=true
export AUTO_MEASURE_REQUIRE_EMAIL_VERIFICATION=false
export AUTO_MEASURE_PASSWORD_PEPPER="e2e-only-password-pepper-not-for-production"
export AUTO_MEASURE_CSRF_SECRET="e2e-only-csrf-secret-not-for-production"
export AUTO_MEASURE_SHARED_AUTH_USER="e2e-staff"
export AUTO_MEASURE_SHARED_AUTH_PASS="e2e-staff-password-123"
E2E_BACKEND_PORT="${E2E_BACKEND_PORT:-8010}"
unset AUTO_MEASURE_DATABASE_URL DATABASE_URL

cd "${BACKEND_DIR}"
if [[ -x "./venv/bin/python" ]]; then
  exec ./venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "${E2E_BACKEND_PORT}"
fi
exec python3 -m uvicorn app.main:app --host 127.0.0.1 --port "${E2E_BACKEND_PORT}"
