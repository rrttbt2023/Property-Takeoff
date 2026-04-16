const RAW_API_BASE = String(import.meta.env.VITE_API_BASE_URL || "").trim();
const API_BASE_URL = RAW_API_BASE.replace(/\/+$/, "");
let sharedAuthToken = "";

export function setSharedAuthToken(token) {
  sharedAuthToken = String(token || "").trim();
}

function buildApiCandidates(path) {
  const candidates = [];
  const normalizedPath = String(path || "");
  if (API_BASE_URL) {
    candidates.push(`${API_BASE_URL}${normalizedPath}`);
  }
  candidates.push(normalizedPath);

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    const host = String(window.location.hostname || "").trim();
    if (host) {
      candidates.push(`${protocol}//${host}:8000${normalizedPath}`);
    }
    if (host !== "127.0.0.1") {
      candidates.push(`http://127.0.0.1:8000${normalizedPath}`);
    }
    if (host !== "localhost") {
      candidates.push(`http://localhost:8000${normalizedPath}`);
    }
  }

  return [...new Set(candidates)];
}

function extractErrorMessage(payload, fallback = "Request failed") {
  if (typeof payload?.detail === "string" && payload.detail.trim()) {
    return payload.detail;
  }
  if (Array.isArray(payload?.detail)) {
    const joined = payload.detail
      .map((item) => item?.msg || JSON.stringify(item))
      .filter(Boolean)
      .join(", ");
    if (joined) return joined;
  }
  if (payload?.detail && typeof payload.detail === "object") {
    const nested = payload.detail;
    if (typeof nested?.message === "string" && nested.message.trim()) {
      return nested.message;
    }
  }
  if (typeof payload?.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  return fallback;
}

async function readErrorPayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request(path, options = {}) {
  const candidates = buildApiCandidates(path);
  let networkError = null;
  for (const url of candidates) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        // If relative /api path 404s (common when no dev proxy), try next candidate.
        if (
          String(url) === String(path) &&
          String(path).startsWith("/api/") &&
          response.status === 404
        ) {
          continue;
        }
        const payload = await readErrorPayload(response);
        const message = extractErrorMessage(payload, response.statusText || "Request failed");
        const error = new Error(`${response.status}: ${message}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return response.json();
    } catch (error) {
      const text = String(error?.message || "").toLowerCase();
      const isNetwork =
        text.includes("failed to fetch") ||
        text.includes("load failed") ||
        text.includes("networkerror") ||
        text.includes("network request failed") ||
        text.includes("typeerror");
      if (isNetwork) {
        networkError = error;
        continue;
      }
      throw error;
    }
  }
  if (networkError) {
    throw networkError;
  }
  throw new Error("Request failed");
}

export function getMeasurementHistory(limit = 20) {
  return request(`/api/measurements/history?limit=${encodeURIComponent(limit)}`);
}

export function calculatePixelDistance(pointA, pointB) {
  return request("/api/measurements/calibrate/pixel-distance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      point_a: pointA,
      point_b: pointB,
    }),
  });
}

export function uploadMeasurement({
  imageFile,
  measurementType,
  knownDistanceFt,
  knownDistancePixels,
}) {
  const formData = new FormData();
  formData.append("image", imageFile);
  formData.append("measurement_type", measurementType);
  formData.append("known_distance_ft", String(knownDistanceFt));
  formData.append("known_distance_pixels", String(knownDistancePixels));

  return request("/api/measurements/upload", {
    method: "POST",
    body: formData,
  });
}

export function measureGeoJson({
  geometry,
  measurementType,
  knownDistanceFt,
  knownDistancePixels,
}) {
  return request("/api/measurements/geojson", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      geometry,
      measurement_type: measurementType,
      known_distance_ft: knownDistanceFt,
      known_distance_pixels: knownDistancePixels,
    }),
  });
}

export function autoClassifyMeasurement({
  boundaryGeometry,
  candidatePlowableGeometry,
  candidateSidewalkGeometry,
  candidateTurfGeometry,
  candidateMulchGeometry,
  candidateBuildingsGeometry,
}) {
  return request("/api/measurements/auto-classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      boundary_geometry: boundaryGeometry,
      candidate_plowable_geometry: candidatePlowableGeometry || null,
      candidate_sidewalk_geometry: candidateSidewalkGeometry || null,
      candidate_turf_geometry: candidateTurfGeometry || null,
      candidate_mulch_geometry: candidateMulchGeometry || null,
      candidate_buildings_geometry: candidateBuildingsGeometry || null,
    }),
  });
}

export function segmentMeasurementUpload({
  imageFile,
  useModel = true,
  minAreaPx = 60,
  boundaryGeojson = null,
}) {
  const formData = new FormData();
  formData.append("image", imageFile);
  formData.append("use_model", String(!!useModel));
  formData.append("min_area_px", String(minAreaPx));
  if (boundaryGeojson) {
    formData.append("boundary_geojson", JSON.stringify(boundaryGeojson));
  }
  return request("/api/measurements/segment/upload", {
    method: "POST",
    body: formData,
  });
}

export function listSharedProjects(limit = 100) {
  return request(`/api/projects?limit=${encodeURIComponent(limit)}`, {
    headers: sharedAuthToken
      ? { Authorization: `Bearer ${sharedAuthToken}` }
      : {},
  });
}

export function getSharedProject(projectId) {
  return request(`/api/projects/${encodeURIComponent(projectId)}`, {
    headers: sharedAuthToken
      ? { Authorization: `Bearer ${sharedAuthToken}` }
      : {},
  });
}

export function saveSharedProject({
  id,
  projectName,
  savedAt,
  polygonCount,
  hasBoundary,
  baseLastEditedAt,
  forceOverwrite = false,
  payload,
}) {
  return request(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(sharedAuthToken ? { Authorization: `Bearer ${sharedAuthToken}` } : {}),
    },
    body: JSON.stringify({
      id,
      project_name: projectName,
      saved_at: savedAt || null,
      polygon_count: Number.isFinite(Number(polygonCount)) ? Number(polygonCount) : null,
      has_boundary: typeof hasBoundary === "boolean" ? hasBoundary : null,
      base_last_edited_at: String(baseLastEditedAt || "").trim() || null,
      force_overwrite: !!forceOverwrite,
      payload,
    }),
  });
}

export function deleteSharedProject(projectId) {
  return request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    headers: sharedAuthToken
      ? { Authorization: `Bearer ${sharedAuthToken}` }
      : {},
  });
}

export function loginSharedAccess({ username, password }) {
  return request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: String(username || "").trim(),
      password: String(password || ""),
    }),
  });
}

export function getSharedAccessSession() {
  return request("/api/auth/session", {
    headers: sharedAuthToken
      ? { Authorization: `Bearer ${sharedAuthToken}` }
      : {},
  });
}

export function logoutSharedAccess() {
  return request("/api/auth/logout", {
    method: "POST",
    headers: sharedAuthToken
      ? { Authorization: `Bearer ${sharedAuthToken}` }
      : {},
  });
}

export function getSecurityAuditEvents(limit = 120) {
  return request(`/api/audit/events?limit=${encodeURIComponent(limit)}`, {
    headers: sharedAuthToken
      ? { Authorization: `Bearer ${sharedAuthToken}` }
      : {},
  });
}
