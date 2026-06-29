#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${ROOT_DIR}/Auto-measure-backend"
FRONTEND_DIR="${ROOT_DIR}/frontend"

echo "==> Frontend lint"
cd "${FRONTEND_DIR}"
npm run -s lint

echo "==> Frontend build"
npm run -s build

echo "==> Backend tests"
cd "${BACKEND_DIR}"
if [[ -x "./venv/bin/pytest" ]]; then
  ./venv/bin/pytest -q
else
  python3 -m pytest -q
fi
