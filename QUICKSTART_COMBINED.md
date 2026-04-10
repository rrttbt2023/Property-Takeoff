# Combine Frontend + Backend Fast

## 1) Run both in development

From the project root:

```bash
./scripts/dev.sh
```

- Frontend: `http://localhost:5173`
- Backend API: `http://127.0.0.1:8000`
- Backend health: `http://127.0.0.1:8000/api/health`

In frontend code, call backend with relative API paths like:

- `/api/measurements`
- `/api/measurements/upload`

Vite now proxies `/api/*` to the FastAPI server.

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
