// src/App.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import * as turf from "@turf/turf";
import { strToU8, zipSync } from "fflate";

import { loadKmlOrKmz } from "./kml";
import {
  PROJECT_SCHEMA_VERSION,
  isValidProjectPayload,
  normalizeLayerVisibility,
} from "./projectSchema";
import {
  autoClassifyMeasurement,
  calculatePixelDistance,
  deleteSharedProject,
  getSharedProject,
  getSharedAccessSession,
  getSecurityAuditEvents,
  getMeasurementHistory,
  loginSharedAccess,
  listSharedProjects,
  logoutSharedAccess,
  measureGeoJson,
  saveSharedProject,
  setSharedAuthToken,
  segmentMeasurementUpload,
  uploadMeasurement,
} from "./api";

// ---------- Layer config (single source of truth) ----------
const LAYER_KEYS = ["plowable", "sidewalks", "turf", "mulch"];

const LAYER_META = {
  plowable: { name: "Plowable" },
  sidewalks: { name: "Sidewalks" },
  turf: { name: "Turf" },
  mulch: { name: "Mulch" },
};

const MEASUREMENT_TYPE_LAYER_MAP = {
  lawn_area: "turf",
  driveway_area: "plowable",
  parking_lot_area: "plowable",
  sidewalk_length: "sidewalks",
  plow_route_length: "plowable",
};

const LAYER_COLORS = {
  plowable: { fill: "#00ffff", line: "#0088ff" },
  sidewalks: { fill: "#ffff00", line: "#ffaa00" },
  turf: { fill: "#00ff00", line: "#00cc00" },
  mulch: { fill: "#ff6600", line: "#ff5500" },
};

const BOUNDARY_COLORS = {
  line: "#00ffea",
  fill: "#00ffea",
};

const AUTOSAVE_KEY = "takeoff-autosave-v1";
const MEASURE_SOURCE_ID = "measure-two-point-src";
const MEASURE_LINE_LAYER_ID = "measure-two-point-line";
const MEASURE_POINT_LAYER_ID = "measure-two-point-points";
const SHOW_TWO_POINT_MEASURE_TOOL = true;
const SHOW_TWO_POINT_CALIBRATION = false;
const PDF_ANNOTATIONS_SOURCE_ID = "pdf-annotations-src";
const PDF_ANNOT_LINE_LAYER_ID = "pdf-annotations-line";
const PDF_ANNOT_FILL_LAYER_ID = "pdf-annotations-fill";
const PDF_ANNOT_TEXT_LAYER_ID = "pdf-annotations-text";
const PDF_ANNOT_DEFAULT_COLOR = "#ff3b30";
const TRAIN_MASK_VALUES = {
  background: 0,
  plowable: 64,
  sidewalks: 128,
  turf: 192,
  mulch: 255,
};
const TRAIN_CLASS_IDS = {
  background: 0,
  plowable: 1,
  sidewalks: 2,
  turf: 3,
  mulch: 4,
};
const TRAIN_PREVIEW_COLORS = {
  0: [0, 0, 0],
  1: [0, 136, 255],
  2: [255, 170, 0],
  3: [0, 204, 0],
  4: [255, 85, 0],
};
const UNDO_REDO_MAX_DEPTH = 80;
const TINY_POLYGON_SQFT = 25;
const DEFAULT_SNAP_DISTANCE_M = 2.25;
const DEFAULT_TERRAIN_EXAGGERATION = 1.4;
const DEFAULT_3D_OBJECT_OPACITY = 0.36;
const ENABLE_TRUE_TERRAIN = false;
const ENABLE_OBJECTS_3D = false;
const PLAN_OVERLAY_SOURCE_ID = "uploaded-plan-overlay-src";
const PLAN_OVERLAY_LAYER_ID = "uploaded-plan-overlay-layer";
const WORKFLOW_MODE_STORAGE_KEY = "takeoff-workflow-mode-v1";
const ESTIMATE_TEMPLATES_STORAGE_KEY = "takeoff-estimate-templates-v1";
const PROJECT_LIBRARY_STORAGE_KEY = "takeoff-project-library-v1";
const PROJECT_VERSION_HISTORY_STORAGE_KEY = "takeoff-project-version-history-v1";
const SHARED_PROJECT_QUEUE_STORAGE_KEY = "takeoff-shared-project-queue-v1";
const SHARED_AUTH_STORAGE_KEY = "takeoff-shared-auth-v1";
const PROJECT_LIBRARY_MAX_ENTRIES = 30;
const PROJECT_VERSION_HISTORY_MAX_PER_PROJECT = 16;
const WORKFLOW_MODE_LOCATION = "location";
const WORKFLOW_MODE_PDF = "pdf";
const APP_SCREEN_HOME = "home";
const APP_SCREEN_LOCATION = "location";
const APP_SCREEN_PDF = "pdf";
const ESTIMATE_BINARY_SPREADSHEET_EXT_RE = /\.(numbers|xlsx|xlsm|xlsb|xls|ods|fods)$/i;
const ESTIMATE_BINARY_SPREADSHEET_MIME_RE =
  /(spreadsheet|excel|officedocument|oasis|numbers)/i;
const ESTIMATE_SECTION_HINTS = {
  plowable: ["plowable", "parking", "drive", "road", "lot"],
  sidewalks: ["sidewalk", "walkway", "walk", "path"],
  turf: ["grass areas to be mowed", "grass", "turf", "lawn"],
  mulch: ["mulch beds", "mulch", "beds"],
};
const ESTIMATE_TOTAL_LABEL_HINTS = {
  plowable: ["total plowable", "total parking", "total lot"],
  sidewalks: ["total sidewalks", "total sidewalk"],
  turf: ["total grass", "total turf", "total lawn"],
  mulch: ["total beds", "total mulch", "yards of mulch"],
};
const ESTIMATE_STOP_ROW_HINTS = [
  "page 2 totals",
  "total grass",
  "total beds",
  "total plowable",
  "total sidewalks",
  "markup",
  "mowing",
  "cleanup",
  "fert",
  "weed control",
  "total #",
];
const PROPERTY_LOOKUP_PROVIDER_MAPTILER = "maptiler";
const PROPERTY_LOOKUP_PROVIDER_GOOGLE = "google";
const CESIUM_JS_URL = "https://unpkg.com/cesium@1.127.0/Build/Cesium/Cesium.js";
const CESIUM_CSS_URL = "https://unpkg.com/cesium@1.127.0/Build/Cesium/Widgets/widgets.css";
let estimateSpreadsheetReaderPromise = null;
let exportModulePromise = null;

async function loadExportModule() {
  if (!exportModulePromise) {
    exportModulePromise = import("./export");
  }
  return exportModulePromise;
}

function ensureStylesheetOnce(href, id) {
  if (typeof document === "undefined") return;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

async function loadCesiumGlobal() {
  if (typeof window === "undefined") {
    throw new Error("Browser context is required for 3D viewer.");
  }
  if (window.Cesium) return window.Cesium;
  ensureStylesheetOnce(CESIUM_CSS_URL, "cesium-widgets-css");

  await new Promise((resolve, reject) => {
    const existing = document.getElementById("cesium-js-script");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Failed to load Cesium script.")),
        { once: true }
      );
      return;
    }
    const script = document.createElement("script");
    script.id = "cesium-js-script";
    script.src = CESIUM_JS_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Cesium script."));
    document.body.appendChild(script);
  });

  if (!window.Cesium) {
    throw new Error("Cesium did not initialize.");
  }
  return window.Cesium;
}

function parseGoogleLatLngPoint(point) {
  if (!point || typeof point !== "object") return null;
  const lat = Number(point.lat ?? point.latitude);
  const lng = Number(point.lng ?? point.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function parseGoogleViewportBbox(viewport) {
  if (!viewport || typeof viewport !== "object") return null;
  const ne = parseGoogleLatLngPoint(viewport.northeast || viewport.high);
  const sw = parseGoogleLatLngPoint(viewport.southwest || viewport.low);
  if (!ne || !sw) return null;
  const west = Math.min(sw.lng, ne.lng);
  const east = Math.max(sw.lng, ne.lng);
  const south = Math.min(sw.lat, ne.lat);
  const north = Math.max(sw.lat, ne.lat);
  return [west, south, east, north];
}

function normalizeGoogleLookupFeature(raw, fallbackLabel = "") {
  if (!raw || typeof raw !== "object") return null;
  const types = Array.isArray(raw.types) ? raw.types.map((t) => String(t)) : [];
  const placeIdRaw = raw.place_id || raw.placeId || "";
  const placeNameRef = typeof raw.name === "string" ? raw.name : "";
  const placeId =
    String(placeIdRaw || "").trim() ||
    (placeNameRef.startsWith("places/") ? placeNameRef.replace(/^places\//, "") : "");
  const label = String(
    raw.formatted_address ||
      raw.formattedAddress ||
      raw.displayName?.text ||
      raw.display_name ||
      fallbackLabel ||
      ""
  ).trim();
  const mainText = String(
    raw.address_components?.[0]?.long_name ||
      raw.displayName?.text ||
      raw.display_name ||
      label
  ).trim();
  const location = parseGoogleLatLngPoint(raw.geometry?.location || raw.location);
  const center = location ? [location.lng, location.lat] : null;
  const bbox = parseGoogleViewportBbox(raw.geometry?.viewport || raw.viewport);

  return {
    provider: PROPERTY_LOOKUP_PROVIDER_GOOGLE,
    place_name: label,
    text: mainText,
    center: center || undefined,
    geometry: center
      ? {
          type: "Point",
          coordinates: center,
        }
      : undefined,
    bbox: bbox || undefined,
    place_type: types,
    properties: {
      category: types.join(","),
      google_place_id: placeId || undefined,
    },
  };
}

function normalizeGoogleAutocompleteSuggestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const prediction = raw.placePrediction || raw.place_prediction || raw;
  if (!prediction || typeof prediction !== "object") return null;

  const label = String(
    prediction.text?.text || prediction.description || prediction.formattedAddress || ""
  ).trim();
  if (!label) return null;

  const mainText = String(
    prediction.structuredFormat?.mainText?.text ||
      prediction.structured_formatting?.main_text ||
      prediction.text?.text ||
      label
  ).trim();
  const placeId = String(prediction.placeId || prediction.place_id || "").trim();
  const types = Array.isArray(prediction.types) ? prediction.types.map((t) => String(t)) : [];

  return {
    provider: PROPERTY_LOOKUP_PROVIDER_GOOGLE,
    place_name: label,
    text: mainText,
    place_type: types,
    properties: {
      category: types.join(","),
      google_place_id: placeId || undefined,
    },
  };
}

function addCesiumPolygonEntities(viewer, Cesium, prefix, feature, options = {}) {
  if (!viewer || !Cesium || !feature || !feature.geometry) return 0;
  const geometry = feature.geometry;
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
  if (!Array.isArray(polygons) || !polygons.length) return 0;

  const material = options.material || Cesium.Color.CYAN.withAlpha(0.2);
  const outlineColor = options.outlineColor || Cesium.Color.CYAN.withAlpha(0.9);
  const clampToGround = options.clampToGround !== false;
  const collectEntityIds = Array.isArray(options.collectEntityIds)
    ? options.collectEntityIds
    : null;

  let added = 0;
  polygons.forEach((polyCoords, polyIdx) => {
    const outer = Array.isArray(polyCoords?.[0]) ? polyCoords[0] : [];
    if (outer.length < 3) return;
    const flat = [];
    for (const pt of outer) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      flat.push(Number(pt[0]), Number(pt[1]));
    }
    if (flat.length < 6) return;
    const entityId = `${prefix}-${polyIdx}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    viewer.entities.add({
      id: entityId,
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
        material,
        outline: false,
        ...(clampToGround
          ? {
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              classificationType: Cesium.ClassificationType.BOTH,
            }
          : {
              height: 0,
            }),
      },
    });
    if (collectEntityIds) collectEntityIds.push(entityId);
    // Polygon outlines can float if rendered in 3D space; draw a clamped ground polyline instead.
    viewer.entities.add({
      id: `${entityId}-outline`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(flat),
        clampToGround: true,
        width: Number.isFinite(options.outlineWidth) ? options.outlineWidth : 2,
        material: outlineColor,
      },
    });
    if (collectEntityIds) collectEntityIds.push(`${entityId}-outline`);
    added += 1;
  });
  return added;
}

function isTrainingExportMetadataPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return (
    typeof payload.image_filename === "string" &&
    typeof payload.mask_filename === "string" &&
    payload.class_ids &&
    typeof payload.class_ids === "object" &&
    "background" in payload.class_ids &&
    "plowable" in payload.class_ids &&
    "sidewalks" in payload.class_ids &&
    "turf" in payload.class_ids &&
    "mulch" in payload.class_ids
  );
}

// ---------- Tiny UI helpers (single-file) ----------
function Toasts({ toasts, onClose }) {
  return (
    <div
      style={{
        position: "fixed",
        right: 14,
        bottom: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        zIndex: 9999,
        maxWidth: 420,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            background:
              t.type === "error"
                ? "rgba(140, 20, 20, 0.95)"
                : t.type === "warn"
                ? "rgba(140, 110, 20, 0.95)"
                : "rgba(20, 20, 20, 0.95)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 12,
            padding: "10px 12px",
            color: "#fff",
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <div style={{ fontSize: 13, lineHeight: 1.35, flex: 1 }}>
            {t.message}
          </div>
          <button
            onClick={() => onClose(t.id)}
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.85)",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              padding: 2,
            }}
            aria-label="Close toast"
            title="Close"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function ConfirmDialog({
  open,
  title = "Confirm",
  message = "Are you sure?",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 9998,
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        // click outside closes
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          background: "#0f0f0f",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 16,
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
          padding: 16,
          color: "#fff",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.45 }}>
          {message}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 14,
          }}
        >
          <button
            onClick={onCancel}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.05)",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: danger ? "rgba(200,40,40,0.95)" : "#1d5cff",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

// rAF throttle (single-file)
function useRafThrottle(fn) {
  const fnRef = useRef(fn);
  const rafRef = useRef(null);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return useCallback((...args) => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      fnRef.current?.(...args);
    });
  }, []);
}

// MapboxDraw default polygon mode is tap-focused on mobile and makes panning while
// drawing awkward on iPad. This mode keeps draw behavior but lets touch-drag pan.
function createTouchPanDrawPolygonMode(baseMode, options = {}) {
  if (!baseMode) return null;
  const stylusOnlyRef = options?.stylusOnlyRef || null;

  const mode = { ...baseMode };
  const resetPanState = (state) => {
    if (state) state.__panLastPoint = null;
  };
  const getPointerType = (e) => {
    const original = e?.originalEvent;
    if (!original) return "unknown";

    if (typeof original.pointerType === "string" && original.pointerType) {
      return original.pointerType.toLowerCase();
    }

    const touch =
      original.touches?.[0] ||
      original.changedTouches?.[0] ||
      original.targetTouches?.[0] ||
      null;
    const touchType = String(touch?.touchType || "").toLowerCase();
    if (touchType === "stylus") return "pen";
    if (touch) return "touch";

    const type = String(original.type || "").toLowerCase();
    if (type.startsWith("touch")) return "touch";
    if (type.startsWith("mouse")) return "mouse";
    return "unknown";
  };
  const isStylusLikeEvent = (e) => {
    const pointerType = getPointerType(e);
    return pointerType === "pen" || pointerType === "mouse";
  };
  const shouldIgnoreForStylusOnly = (e) =>
    !!stylusOnlyRef?.current && !isStylusLikeEvent(e);

  mode.onSetup = function (...args) {
    const state = baseMode.onSetup.apply(this, args);
    state.__panLastPoint = null;
    return state;
  };

  mode.onTouchMove = function (state, e) {
    if (shouldIgnoreForStylusOnly(e)) {
      mode.onDrag(state, e);
      return;
    }
    if (typeof baseMode.onMouseMove === "function") {
      baseMode.onMouseMove.call(this, state, e);
    } else if (typeof baseMode.onTouchMove === "function") {
      baseMode.onTouchMove.call(this, state, e);
    }
  };

  mode.onDrag = function (state, e) {
    const touchEvent = e?.originalEvent;
    const touchCount = touchEvent?.touches?.length ?? touchEvent?.changedTouches?.length ?? 0;
    if (touchCount !== 1 || !e?.point) {
      resetPanState(state);
      return;
    }

    const nextPoint = { x: e.point.x, y: e.point.y };
    if (!state.__panLastPoint) {
      state.__panLastPoint = nextPoint;
      return;
    }

    const dx = nextPoint.x - state.__panLastPoint.x;
    const dy = nextPoint.y - state.__panLastPoint.y;
    state.__panLastPoint = nextPoint;

    if (Math.abs(dx) + Math.abs(dy) < 1) return;

    touchEvent?.preventDefault?.();
    touchEvent?.stopPropagation?.();

    try {
      this.map.panBy([-dx, -dy], { animate: false });
      const lngLat = this.map.unproject([nextPoint.x, nextPoint.y]);
      state.polygon?.updateCoordinate?.(
        `0.${state.currentVertexPosition}`,
        lngLat.lng,
        lngLat.lat
      );
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  };

  mode.onTap = function (state, e) {
    resetPanState(state);
    if (shouldIgnoreForStylusOnly(e)) return undefined;
    if (typeof baseMode.onTap === "function") {
      return baseMode.onTap.call(this, state, e);
    }
    return undefined;
  };

  mode.onClick = function (state, e) {
    resetPanState(state);
    if (shouldIgnoreForStylusOnly(e)) return undefined;
    if (typeof baseMode.onClick === "function") {
      return baseMode.onClick.call(this, state, e);
    }
    return undefined;
  };

  mode.onTouchEnd = function (state, e) {
    resetPanState(state);
    if (typeof baseMode.onTouchEnd === "function") {
      return baseMode.onTouchEnd.call(this, state, e);
    }
    return undefined;
  };

  mode.onStop = function (state) {
    resetPanState(state);
    if (typeof baseMode.onStop === "function") {
      return baseMode.onStop.call(this, state);
    }
    return undefined;
  };

  return mode;
}

// ---------- Geometry helpers ----------
const SQM_TO_SQFT = 10.7639104167097;

function to2DPosition(pos) {
  if (!Array.isArray(pos) || pos.length < 2) return pos;
  return [Number(pos[0]), Number(pos[1])];
}

function to2DCoordinates(coords) {
  if (!Array.isArray(coords)) return coords;
  if (coords.length > 0 && typeof coords[0] === "number") {
    return to2DPosition(coords);
  }
  return coords.map((c) => to2DCoordinates(c));
}

function to2DGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") return geometry;
  if (geometry.type === "GeometryCollection") {
    return {
      ...geometry,
      geometries: Array.isArray(geometry.geometries)
        ? geometry.geometries.map((g) => to2DGeometry(g))
        : [],
    };
  }
  if (!("coordinates" in geometry)) return geometry;
  return {
    ...geometry,
    coordinates: to2DCoordinates(geometry.coordinates),
  };
}

function to2DFeature(feature) {
  if (!feature || feature.type !== "Feature") return feature;
  return {
    ...feature,
    geometry: to2DGeometry(feature.geometry),
  };
}

function isPolygonLike(f) {
  const t = f?.geometry?.type;
  return t === "Polygon" || t === "MultiPolygon";
}

function safeIntersectFeature(a, b) {
  if (!a || !b || !isPolygonLike(a) || !isPolygonLike(b)) return null;
  try {
    const out = turf.intersect(a, b);
    if (out && isPolygonLike(out)) return out;
  } catch {
    try {
      const out = turf.intersect(turf.featureCollection([a, b]));
      if (out && isPolygonLike(out)) return out;
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }
  return null;
}

function subtractFeatureAllowEmpty(a, b) {
  if (!a || !isPolygonLike(a)) return null;
  if (!b || !isPolygonLike(b)) return a;
  try {
    const out = turf.difference(a, b);
    if (out && isPolygonLike(out)) return out;
    return null;
  } catch {
    try {
      const out = turf.difference(turf.featureCollection([a, b]));
      if (out && isPolygonLike(out)) return out;
      return null;
    } catch {
      return a;
    }
  }
}

function combinePolygonFeatures(features) {
  if (!Array.isArray(features) || !features.length) return null;
  if (features.length === 1) return features[0];
  try {
    const combined = turf.combine(turf.featureCollection(features));
    const out = combined?.features?.[0];
    return out && isPolygonLike(out) ? out : features[0];
  } catch {
    return features[0];
  }
}

function polygonFeatureParts(feature) {
  if (!feature || !isPolygonLike(feature)) return [];
  if (feature.geometry.type === "Polygon") return [feature];
  if (feature.geometry.type === "MultiPolygon") {
    return (feature.geometry.coordinates || []).map((coords) => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: coords },
      properties: { ...(feature.properties || {}) },
    }));
  }
  return [];
}

function featureSqft(feature) {
  try {
    return turf.area(feature) * SQM_TO_SQFT;
  } catch {
    return 0;
  }
}

function buildMeasureFeatureCollection(points) {
  const features = [];
  if (points[0]) {
    features.push({
      type: "Feature",
      properties: { role: "point", index: 1 },
      geometry: { type: "Point", coordinates: points[0] },
    });
  }
  if (points[1]) {
    features.push({
      type: "Feature",
      properties: { role: "point", index: 2 },
      geometry: { type: "Point", coordinates: points[1] },
    });
    features.push({
      type: "Feature",
      properties: { role: "line" },
      geometry: {
        type: "LineString",
        coordinates: [points[0], points[1]],
      },
    });
  }
  return {
    type: "FeatureCollection",
    features,
  };
}

function computeTwoPointMeasure(map, points) {
  if (!map || !Array.isArray(points) || points.length !== 2) return null;
  const a = turf.point(points[0]);
  const b = turf.point(points[1]);
  const feet = turf.distance(a, b, { units: "miles" }) * 5280;
  const p1 = map.project(points[0]);
  const p2 = map.project(points[1]);
  const pixels = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  return { feet, pixels };
}

function normalizeHexColor(value, fallback = PDF_ANNOT_DEFAULT_COLOR) {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text;
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
  }
  return fallback;
}

function createPdfAnnotationFeatureCollection(features = []) {
  return {
    type: "FeatureCollection",
    features: (Array.isArray(features) ? features : []).filter(
      (feature) =>
        feature &&
        feature.type === "Feature" &&
        feature.geometry &&
        (feature.geometry.type === "LineString" ||
          feature.geometry.type === "Polygon" ||
          feature.geometry.type === "Point")
    ),
  };
}

function normalizePdfAnnotationFeature(feature, idx = 0) {
  if (!feature || feature.type !== "Feature" || !feature.geometry) return null;
  const geometry = to2DFeature(feature).geometry;
  const kindRaw = String(feature.properties?.kind || "").toLowerCase();
  const kind = ["pen", "marker", "shape", "text"].includes(kindRaw) ? kindRaw : "pen";
  const color = normalizeHexColor(feature.properties?.color, PDF_ANNOT_DEFAULT_COLOR);
  const strokeWidthRaw = Number(feature.properties?.width);
  const width = Number.isFinite(strokeWidthRaw)
    ? Math.max(1, Math.min(30, strokeWidthRaw))
    : kind === "marker"
    ? 10
    : 3;
  const opacityRaw = Number(feature.properties?.opacity);
  const opacity = Number.isFinite(opacityRaw)
    ? Math.max(0.05, Math.min(1, opacityRaw))
    : kind === "marker"
    ? 0.35
    : 1;
  const fillOpacityRaw = Number(feature.properties?.fillOpacity);
  const fillOpacity = Number.isFinite(fillOpacityRaw)
    ? Math.max(0.01, Math.min(1, fillOpacityRaw))
    : kind === "shape"
    ? 0.2
    : 0;
  const label =
    typeof feature.properties?.label === "string" ? feature.properties.label : "";
  return {
    type: "Feature",
    id:
      feature.id ||
      `pdf-annot-${Date.now()}-${idx + 1}-${Math.round(Math.random() * 100000)}`,
    properties: {
      kind,
      color,
      fillColor: normalizeHexColor(feature.properties?.fillColor, color),
      width,
      opacity,
      fillOpacity,
      label,
    },
    geometry,
  };
}

// More reliable “extends outside boundary” check:
// If (feature - boundary) has non-trivial area => outside.
function isOutsideBoundary(feature, boundaryFeature) {
  try {
    if (!feature || !boundaryFeature) return false;
    if (!isPolygonLike(feature) || !isPolygonLike(boundaryFeature)) return false;

    const diff = turf.difference(feature, boundaryFeature);
    if (!diff) return false;

    const outsideSqft = turf.area(diff) * SQM_TO_SQFT;
    return outsideSqft > 3; // tolerance for tiny slivers (sq ft)
  } catch {
    return false;
  }
}

// Creates a big rectangle around the boundary and subtracts the boundary,
// leaving a "mask" outside the boundary.
function makeOutsideMask(boundaryFeature) {
  try {
    const bbox = turf.bbox(boundaryFeature);
    const pad = 0.01;
    const big = turf.bboxPolygon([
      bbox[0] - pad,
      bbox[1] - pad,
      bbox[2] + pad,
      bbox[3] + pad,
    ]);
    const diff = turf.difference(big, boundaryFeature);
    return diff || null;
  } catch {
    return null;
  }
}

// Put custom outlines just BELOW the vertex/handle layers so dots stay on top.
function getDrawVertexLayerId(map) {
  try {
    const layers = map?.getStyle?.()?.layers || [];
    const preferredPrefixes = [
      "gl-draw-vertex-outer",
      "gl-draw-vertex-inner",
      "gl-draw-midpoint",
      "gl-draw-polygon-and-line-vertex-halo-active",
      "gl-draw-polygon-and-line-vertex-active",
      "gl-draw-polygon-midpoint",
    ];

    for (const prefix of preferredPrefixes) {
      const found = layers.find(
        (l) => typeof l.id === "string" && l.id.startsWith(prefix)
      );
      if (found) return found.id;
    }

    const drawLayer = layers.find(
      (l) => typeof l.id === "string" && l.id.startsWith("gl-draw")
    );
    return drawLayer?.id || null;
  } catch {
    return null;
  }
}

// MapLibre fix for MapboxDraw: numeric dash arrays must be ["literal", [...]]
function fixDashArrayPaint(paint) {
  if (!paint) return paint;
  const next = { ...paint };
  if (
    Array.isArray(next["line-dasharray"]) &&
    typeof next["line-dasharray"][0] === "number"
  ) {
    next["line-dasharray"] = ["literal", next["line-dasharray"]];
  }
  return next;
}

// Filename helpers
function safeFilename(name) {
  const trimmed = (name || "").trim();
  const base = trimmed || "takeoff-project";
  return base
    .replace(/[^\w\- ]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function isPdfFile(file) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  if (type === "application/pdf") return true;
  return /\.pdf$/i.test(String(file.name || ""));
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function cloneLayerFeatures(featuresByLayer) {
  if (!featuresByLayer) {
    return { plowable: [], sidewalks: [], turf: [], mulch: [] };
  }
  return {
    plowable: [...(featuresByLayer.plowable || [])],
    sidewalks: [...(featuresByLayer.sidewalks || [])],
    turf: [...(featuresByLayer.turf || [])],
    mulch: [...(featuresByLayer.mulch || [])],
  };
}

function layerFeaturesSignature(featuresByLayer) {
  try {
    return JSON.stringify(featuresByLayer || {});
  } catch {
    return "";
  }
}

function waitForMapIdle(map, timeoutMs = 4500) {
  return new Promise((resolve) => {
    if (!map) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        map.off("idle", onIdle);
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      resolve();
    };
    const onIdle = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    try {
      if (map.loaded?.() && map.areTilesLoaded?.()) {
        finish();
        return;
      }
      map.on("idle", onIdle);
      map.triggerRepaint?.();
    } catch {
      finish();
    }
  });
}

async function mapCanvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) resolve(nextBlob);
      else reject(new Error("Could not capture current map view."));
    }, "image/png");
  });
}

function mapBoundsToImageSourceCoordinates(map) {
  if (!map?.getBounds) return null;
  try {
    const bounds = map.getBounds();
    return [
      [bounds.getWest(), bounds.getNorth()],
      [bounds.getEast(), bounds.getNorth()],
      [bounds.getEast(), bounds.getSouth()],
      [bounds.getWest(), bounds.getSouth()],
    ];
  } catch {
    return null;
  }
}

async function renderPdfPageToImageFile(pdfFile, options = {}) {
  const maxDimension = Math.max(900, Number(options.maxDimension) || 2400);
  const arrayBuffer = await pdfFile.arrayBuffer();
  const [{ default: workerUrl }, pdfjsLib] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    import("pdfjs-dist/legacy/build/pdf.mjs"),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    useWorkerFetch: true,
    isEvalSupported: false,
  });

  let pdfDoc = null;
  try {
    pdfDoc = await loadingTask.promise;
    if (!pdfDoc || !pdfDoc.numPages) {
      throw new Error("PDF has no readable pages.");
    }

    const requestedPage = Number(options.pageNumber) || 1;
    const pageNumber = Math.max(1, Math.min(pdfDoc.numPages, Math.round(requestedPage)));
    const page = await pdfDoc.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const nativeMax = Math.max(baseViewport.width || 1, baseViewport.height || 1);
    const targetScale = maxDimension / nativeMax;
    const scale = Math.max(0.8, Math.min(2.5, targetScale));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not render PDF page.");

    await page.render({ canvasContext: ctx, viewport }).promise;
    const pngBlob = await mapCanvasToPngBlob(canvas);
    const baseName = safeFilename(String(pdfFile.name || "pdf-plan").replace(/\.pdf$/i, ""));
    return new File([pngBlob], `${baseName}-p${pageNumber}.png`, { type: "image/png" });
  } finally {
    try {
      pdfDoc?.cleanup?.();
      pdfDoc?.destroy?.();
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    try {
      loadingTask?.destroy?.();
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }
}

function listCaptureOverlayLayerIds(map) {
  if (!map?.getStyle) return [];
  const layers = map.getStyle()?.layers || [];
  const exactIds = new Set([
    "polys-fill",
    "polys-outline-halo",
    "polys-outline-line",
    "boundary-fill",
    "boundary-line",
    "boundary-mask-fill",
    "3d-buildings",
    MEASURE_LINE_LAYER_ID,
    MEASURE_POINT_LAYER_ID,
  ]);
  const prefixes = [
    "gl-draw-",
    "mapbox-gl-draw-",
    "draw-border-",
  ];
  const out = [];
  for (const layer of layers) {
    const id = String(layer?.id || "");
    if (!id) continue;
    if (exactIds.has(id) || prefixes.some((prefix) => id.startsWith(prefix))) {
      out.push(id);
    }
  }
  return out;
}

async function withTemporarilyHiddenLayers(map, layerIds, fn) {
  if (!map || !Array.isArray(layerIds) || layerIds.length === 0) {
    return fn();
  }
  const touched = [];
  const seen = new Set();
  for (const id of layerIds) {
    if (!id || seen.has(id) || !map.getLayer(id)) continue;
    seen.add(id);
    let prev = "visible";
    try {
      prev = map.getLayoutProperty(id, "visibility") || "visible";
    } catch {
      prev = "visible";
    }
    touched.push({ id, prev });
    if (prev !== "none") {
      try {
        map.setLayoutProperty(id, "visibility", "none");
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    }
  }

  try {
    map.triggerRepaint?.();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    return await fn();
  } finally {
    for (const { id, prev } of touched) {
      if (!map.getLayer(id)) continue;
      try {
        map.setLayoutProperty(id, "visibility", prev === "none" ? "none" : "visible");
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    }
    map.triggerRepaint?.();
  }
}

async function isLikelyBlankPng(blob) {
  if (!blob || blob.size <= 0) return true;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, bitmap.width);
    canvas.height = Math.max(1, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bitmap.close?.();
      return false;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const totalPixels = Math.max(1, data.length / 4);
    const stride = Math.max(11, Math.floor(totalPixels / 10000));
    let sampled = 0;
    let opaque = 0;
    let nonBlack = 0;
    let maxChannel = 0;
    let sum = 0;
    let sumSq = 0;
    for (let p = 0; p < totalPixels; p += stride) {
      const i = p * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const rgb = r + g + b;
      sampled += 1;
      if (a > 8) opaque += 1;
      if (r > maxChannel) maxChannel = r;
      if (g > maxChannel) maxChannel = g;
      if (b > maxChannel) maxChannel = b;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luma;
      sumSq += luma * luma;
      if (rgb > 24) {
        nonBlack += 1;
      }
    }
    const n = Math.max(1, sampled);
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    const std = Math.sqrt(variance);
    const nonBlackRatio = nonBlack / n;
    const opaqueRatio = opaque / n;

    // Truly blank/failed captures are near-zero intensity with almost no
    // opaque or non-black pixels. Real imagery (even dark imagery) has
    // texture variation and many non-black samples.
    if (maxChannel <= 6 && mean < 1.6 && std < 1.2) return true;
    if (opaqueRatio < 0.002 && nonBlackRatio < 0.002) return true;
    return false;
  } catch {
    // If decode fails, do not block the workflow as a false blank.
    return false;
  }
}

async function captureMapImageBlob(
  map,
  {
    retries = 2,
    requireNonBlank = true,
    failOnBlank = true,
    hideOverlays = true,
  } = {}
) {
  if (!map) throw new Error("Map is not ready yet.");
  const hiddenLayerIds = hideOverlays ? listCaptureOverlayLayerIds(map) : [];

  return withTemporarilyHiddenLayers(map, hiddenLayerIds, async () => {
    let lastBlob = null;
    let lastWasBlank = false;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await waitForMapIdle(map);
      map.triggerRepaint?.();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const canvas = map.getCanvas();
      const blob = await mapCanvasToPngBlob(canvas);
      lastBlob = blob;
      if (!requireNonBlank) return blob;
      const blank = await isLikelyBlankPng(blob);
      lastWasBlank = blank;
      if (!blank) return blob;
      await new Promise((resolve) => setTimeout(resolve, 140 + attempt * 120));
    }
    if (lastBlob) {
      if (!failOnBlank && lastWasBlank) {
        console.warn("Map capture looked blank after retries; using last capture anyway.");
        return lastBlob;
      }
      throw new Error("Map capture looked blank. Pan/zoom slightly and try again.");
    }
    throw new Error("Could not capture current map view.");
  });
}

function resolveBaseMapChoice(baseMap, hasMapbox, hasAzure, hasGoogle) {
  if (baseMap === "mapbox" && !hasMapbox) return "maptiler";
  if (baseMap === "azure" && !hasAzure) return "maptiler";
  if (baseMap === "google" && !hasGoogle) return "maptiler";
  return baseMap || "maptiler";
}

function readStoredWorkflowMode() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WORKFLOW_MODE_STORAGE_KEY);
    if (raw === WORKFLOW_MODE_LOCATION || raw === WORKFLOW_MODE_PDF) {
      return raw;
    }
  } catch {
    /* intentionally ignore localStorage errors */
  }
  return null;
}

function buildProjectLibraryId(projectName) {
  const normalized = String(projectName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return `untitled-${Date.now()}`;
  return `name-${normalized}`;
}

function countProjectPayloadPolygons(payload) {
  let count = 0;
  for (const key of LAYER_KEYS) {
    count += Array.isArray(payload?.layerFeatures?.[key]) ? payload.layerFeatures[key].length : 0;
  }
  return count;
}

function summarizePayloadMetrics(payload) {
  const summary = {
    polygons: 0,
    byLayer: {
      plowable: { polygons: 0, sqft: 0 },
      sidewalks: { polygons: 0, sqft: 0 },
      turf: { polygons: 0, sqft: 0 },
      mulch: { polygons: 0, sqft: 0 },
    },
  };
  if (!payload || typeof payload !== "object") return summary;
  for (const layer of LAYER_KEYS) {
    const features = Array.isArray(payload?.layerFeatures?.[layer])
      ? payload.layerFeatures[layer]
      : [];
    summary.byLayer[layer].polygons = features.length;
    summary.polygons += features.length;
    let sqft = 0;
    for (const feature of features) {
      sqft += featureSqft(feature);
    }
    summary.byLayer[layer].sqft = sqft;
  }
  return summary;
}

function readStoredProjectLibrary() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROJECT_LIBRARY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const entry of parsed) {
      const payload = entry?.payload;
      if (!isValidProjectPayload(payload)) continue;
      const projectName =
        String(entry?.projectName || payload?.projectName || "").trim() || "Untitled Project";
      out.push({
        id: String(entry?.id || buildProjectLibraryId(projectName)),
        projectName,
        savedAt: String(entry?.savedAt || payload?.savedAt || new Date().toISOString()),
        savedBy: String(entry?.savedBy || "").trim(),
        lastEditedAt: String(entry?.lastEditedAt || entry?.savedAt || payload?.savedAt || "").trim(),
        polygonCount: Number.isFinite(Number(entry?.polygonCount))
          ? Math.max(0, Number(entry.polygonCount))
          : countProjectPayloadPolygons(payload),
        hasBoundary: typeof entry?.hasBoundary === "boolean" ? entry.hasBoundary : !!payload?.boundary,
        payload,
      });
      if (out.length >= PROJECT_LIBRARY_MAX_ENTRIES) break;
    }
    return out;
  } catch {
    return [];
  }
}

function buildProjectPayloadSignature(payload) {
  if (!payload || typeof payload !== "object") return "";
  try {
    const stable = { ...payload };
    delete stable.savedAt;
    delete stable.autosavedAt;
    return JSON.stringify(stable);
  } catch {
    return "";
  }
}

function readStoredProjectVersionHistory() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROJECT_VERSION_HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const [projectId, versions] of Object.entries(parsed)) {
      if (!Array.isArray(versions) || !String(projectId || "").trim()) continue;
      const normalized = [];
      for (const version of versions) {
        if (!isValidProjectPayload(version?.payload)) continue;
        const savedAt = String(
          version?.savedAt || version?.payload?.savedAt || new Date().toISOString()
        ).trim();
        const source = String(version?.source || "local").trim() || "local";
        const savedBy = String(version?.savedBy || "").trim();
        const id = String(version?.id || "").trim() || `${savedAt}-${Math.random().toString(36).slice(2, 8)}`;
        const payload = version.payload;
        normalized.push({
          id,
          savedAt,
          source,
          savedBy,
          polygonCount: countProjectPayloadPolygons(payload),
          hasBoundary: !!payload?.boundary,
          signature: buildProjectPayloadSignature(payload),
          payload,
        });
        if (normalized.length >= PROJECT_VERSION_HISTORY_MAX_PER_PROJECT) break;
      }
      if (normalized.length) out[projectId] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeSharedQueueOperation(op) {
  const type = String(op?.op || "").toLowerCase();
  if (type !== "upsert" && type !== "delete") return null;
  const id = String(op?.id || "").trim();
  if (!id) return null;
  const base = {
    op: type,
    id,
    enqueuedAt: String(op?.enqueuedAt || new Date().toISOString()),
  };
  if (type === "delete") return base;
  const payload = op?.payload;
  if (!isValidProjectPayload(payload)) return null;
  return {
    ...base,
    projectName: String(op?.projectName || payload?.projectName || "").trim(),
    savedAt: String(op?.savedAt || payload?.savedAt || new Date().toISOString()),
    polygonCount: Number.isFinite(Number(op?.polygonCount))
      ? Math.max(0, Number(op.polygonCount))
      : countProjectPayloadPolygons(payload),
    hasBoundary:
      typeof op?.hasBoundary === "boolean" ? op.hasBoundary : !!payload?.boundary,
    payload,
  };
}

function readStoredSharedProjectQueue() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SHARED_PROJECT_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const item of parsed) {
      const normalized = normalizeSharedQueueOperation(item);
      if (!normalized) continue;
      out.push(normalized);
    }
    return out.slice(0, 500);
  } catch {
    return [];
  }
}

function readStoredSharedAuth() {
  if (typeof window === "undefined") {
    return { token: "", username: "admin", expiresAt: "" };
  }
  try {
    const raw = window.localStorage.getItem(SHARED_AUTH_STORAGE_KEY);
    if (!raw) return { token: "", username: "admin", expiresAt: "" };
    const parsed = JSON.parse(raw);
    const token = String(parsed?.token || "").trim();
    const username = String(parsed?.username || "admin").trim() || "admin";
    const expiresAt = String(parsed?.expiresAt || "").trim();
    return { token, username, expiresAt };
  } catch {
    return { token: "", username: "admin", expiresAt: "" };
  }
}

function isAuthError(error) {
  const text = String(error?.message || "").toLowerCase();
  return (
    text.includes("401") ||
    text.includes("login required") ||
    text.includes("session expired")
  );
}

function upsertSharedQueueOperation(prevQueue, nextOp) {
  const queue = Array.isArray(prevQueue) ? prevQueue : [];
  const normalized = normalizeSharedQueueOperation(nextOp);
  if (!normalized) return queue;
  // Keep only the latest operation per project id.
  const filtered = queue.filter((item) => String(item?.id) !== normalized.id);
  return [...filtered, normalized].slice(-500);
}

function buildProjectLibraryEntryFromPayload(payload, fallbackProjectName = "", metadata = null) {
  if (!isValidProjectPayload(payload)) return null;
  const projectName =
    String(payload?.projectName || fallbackProjectName || "").trim() || "Untitled Project";
  const savedBy = String(metadata?.savedBy || "").trim();
  const lastEditedAt = String(
    metadata?.lastEditedAt || payload?.savedAt || new Date().toISOString()
  ).trim();
  return {
    id: buildProjectLibraryId(projectName),
    projectName,
    savedAt: String(payload?.savedAt || new Date().toISOString()),
    savedBy,
    lastEditedAt,
    polygonCount: countProjectPayloadPolygons(payload),
    hasBoundary: !!payload?.boundary,
    payload,
  };
}

function upsertProjectLibraryEntries(
  prevEntries,
  payload,
  fallbackProjectName = "",
  metadata = null
) {
  const nextEntry = buildProjectLibraryEntryFromPayload(
    payload,
    fallbackProjectName,
    metadata
  );
  if (!nextEntry) return Array.isArray(prevEntries) ? prevEntries : [];
  const prev = Array.isArray(prevEntries) ? prevEntries : [];
  const existing = prev.find((entry) => entry?.id === nextEntry.id);
  if (!nextEntry.savedBy && existing?.savedBy) {
    nextEntry.savedBy = String(existing.savedBy).trim();
  }
  if (!nextEntry.lastEditedAt && existing?.lastEditedAt) {
    nextEntry.lastEditedAt = String(existing.lastEditedAt).trim();
  }
  return [nextEntry, ...prev.filter((entry) => entry?.id !== nextEntry.id)].slice(
    0,
    PROJECT_LIBRARY_MAX_ENTRIES
  );
}

function mergeSharedProjectLibrarySummaries(prevEntries, remoteEntries) {
  const previous = Array.isArray(prevEntries) ? prevEntries : [];
  const remote = Array.isArray(remoteEntries) ? remoteEntries : [];
  const payloadById = new Map(
    previous
      .filter((entry) => entry?.id && entry?.payload && isValidProjectPayload(entry.payload))
      .map((entry) => [String(entry.id), entry.payload])
  );

  const merged = remote.map((entry) => {
    const id = String(entry?.id || "").trim();
    const projectName = String(entry?.project_name || entry?.projectName || "").trim();
    const savedAt = String(entry?.saved_at || entry?.savedAt || new Date().toISOString());
    const savedBy = String(entry?.saved_by || entry?.savedBy || "").trim();
    const lastEditedAt = String(
      entry?.last_edited_at || entry?.lastEditedAt || savedAt
    ).trim();
    const polygonCount = Number.isFinite(Number(entry?.polygon_count))
      ? Math.max(0, Number(entry.polygon_count))
      : Number.isFinite(Number(entry?.polygonCount))
      ? Math.max(0, Number(entry.polygonCount))
      : 0;
    const hasBoundary =
      typeof entry?.has_boundary === "boolean"
        ? entry.has_boundary
        : typeof entry?.hasBoundary === "boolean"
        ? entry.hasBoundary
        : false;

    return {
      id,
      projectName: projectName || "Untitled Project",
      savedAt,
      savedBy,
      lastEditedAt,
      polygonCount,
      hasBoundary,
      payload: payloadById.get(id) || null,
    };
  });

  return merged
    .filter((entry) => !!entry.id)
    .slice(0, PROJECT_LIBRARY_MAX_ENTRIES);
}

function createEmptyEstimateTemplates() {
  return {
    snow: {
      name: "",
      mime: "text/plain",
      content: "",
      format: "text",
      binaryBase64: "",
      binaryExt: "",
    },
    landscaping: {
      name: "",
      mime: "text/plain",
      content: "",
      format: "text",
      binaryBase64: "",
      binaryExt: "",
    },
  };
}

function readStoredEstimateTemplates() {
  if (typeof window === "undefined") return createEmptyEstimateTemplates();
  try {
    const raw = window.localStorage.getItem(ESTIMATE_TEMPLATES_STORAGE_KEY);
    if (!raw) return createEmptyEstimateTemplates();
    const parsed = JSON.parse(raw);
    const next = createEmptyEstimateTemplates();
    for (const key of ["snow", "landscaping"]) {
      const entry = parsed?.[key];
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.name === "string") next[key].name = entry.name;
      if (typeof entry.mime === "string") next[key].mime = entry.mime;
      if (typeof entry.content === "string") next[key].content = entry.content;
      if (entry.format === "text" || entry.format === "workbook") {
        next[key].format = entry.format;
      }
      if (typeof entry.binaryBase64 === "string") next[key].binaryBase64 = entry.binaryBase64;
      if (typeof entry.binaryExt === "string") next[key].binaryExt = entry.binaryExt;
    }
    return next;
  } catch {
    return createEmptyEstimateTemplates();
  }
}

function buildEstimateTemplateTokens(projectName, totals) {
  const now = new Date();
  const dateIso = now.toISOString().slice(0, 10);
  const dateLocal = now.toLocaleDateString();
  const dateTimeLocal = now.toLocaleString();
  const metric = (key) => {
    const sqft = Number(totals?.[key]?.sqft || 0);
    const acres = Number(totals?.[key]?.acres || 0);
    return {
      sqftRaw: Math.max(0, Math.round(sqft)),
      sqftFmt: Math.max(0, Math.round(sqft)).toLocaleString(),
      acresRaw: acres,
      acresFmt: acres.toFixed(2),
    };
  };
  const plowable = metric("plowable");
  const sidewalks = metric("sidewalks");
  const turf = metric("turf");
  const mulch = metric("mulch");
  const snowTotalSqftRaw = plowable.sqftRaw + sidewalks.sqftRaw;
  const snowTotalAcresRaw = plowable.acresRaw + sidewalks.acresRaw;
  const landscapingTotalSqftRaw = turf.sqftRaw + mulch.sqftRaw;
  const landscapingTotalAcresRaw = turf.acresRaw + mulch.acresRaw;

  return {
    PROJECT_NAME: String(projectName || "").trim() || "Untitled Project",
    PROPERTY_NAME: String(projectName || "").trim() || "Untitled Project",
    DATE: dateIso,
    DATE_LOCAL: dateLocal,
    DATETIME_LOCAL: dateTimeLocal,
    DATE_MEASURED: dateLocal,

    PLOWABLE_SQFT: plowable.sqftFmt,
    PLOWABLE_SQFT_RAW: String(plowable.sqftRaw),
    PLOW_SQFT: plowable.sqftFmt,
    PLOW_SQFT_RAW: String(plowable.sqftRaw),
    PLOWABLE_ACRES: plowable.acresFmt,
    PLOWABLE_ACRES_RAW: String(plowable.acresRaw),

    SIDEWALKS_SQFT: sidewalks.sqftFmt,
    SIDEWALKS_SQFT_RAW: String(sidewalks.sqftRaw),
    SIDEWALK_SQFT: sidewalks.sqftFmt,
    SIDEWALK_SQFT_RAW: String(sidewalks.sqftRaw),
    SIDEWALKS_ACRES: sidewalks.acresFmt,
    SIDEWALKS_ACRES_RAW: String(sidewalks.acresRaw),

    TURF_SQFT: turf.sqftFmt,
    TURF_SQFT_RAW: String(turf.sqftRaw),
    GRASS_SQFT: turf.sqftFmt,
    GRASS_SQFT_RAW: String(turf.sqftRaw),
    TOTAL_GRASS: turf.sqftFmt,
    TURF_ACRES: turf.acresFmt,
    TURF_ACRES_RAW: String(turf.acresRaw),

    MULCH_SQFT: mulch.sqftFmt,
    MULCH_SQFT_RAW: String(mulch.sqftRaw),
    BEDS_SQFT: mulch.sqftFmt,
    BEDS_SQFT_RAW: String(mulch.sqftRaw),
    TOTAL_BEDS: mulch.sqftFmt,
    MULCH_BEDS_SQFT: mulch.sqftFmt,
    MULCH_ACRES: mulch.acresFmt,
    MULCH_ACRES_RAW: String(mulch.acresRaw),

    SNOW_TOTAL_SQFT: snowTotalSqftRaw.toLocaleString(),
    SNOW_TOTAL_SQFT_RAW: String(snowTotalSqftRaw),
    SNOW_TOTAL_ACRES: snowTotalAcresRaw.toFixed(2),
    SNOW_TOTAL_ACRES_RAW: String(snowTotalAcresRaw),

    LANDSCAPING_TOTAL_SQFT: landscapingTotalSqftRaw.toLocaleString(),
    LANDSCAPING_TOTAL_SQFT_RAW: String(landscapingTotalSqftRaw),
    LANDSCAPING_TOTAL_ACRES: landscapingTotalAcresRaw.toFixed(2),
    LANDSCAPING_TOTAL_ACRES_RAW: String(landscapingTotalAcresRaw),
  };
}

function normalizeEstimateTemplateToken(token) {
  return String(token || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function applyEstimateTemplateText(templateText, tokens) {
  const replacer = (full, key) => {
    const token = normalizeEstimateTemplateToken(key);
    if (!token) return full;
    return token in tokens ? String(tokens[token]) : full;
  };
  return String(templateText || "")
    .replace(/\{\{\s*([^{}\n]+?)\s*\}\}/g, replacer)
    .replace(/\[\[\s*([^\n]+?)\s*\]\]/g, replacer);
}

function isBinarySpreadsheetTemplateFile(file) {
  if (!file) return false;
  const name = String(file.name || "");
  const mime = String(file.type || "");
  return (
    ESTIMATE_BINARY_SPREADSHEET_EXT_RE.test(name) ||
    ESTIMATE_BINARY_SPREADSHEET_MIME_RE.test(mime)
  );
}

function estimateTemplateHasData(template) {
  if (!template || typeof template !== "object") return false;
  if (template.format === "workbook") {
    return !!String(template.binaryBase64 || "").trim();
  }
  return !!String(template.content || "").trim();
}

function uint8ArrayToBase64(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < input.length; i += chunkSize) {
    const chunk = input.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

function base64ToUint8Array(base64) {
  const clean = String(base64 || "").replace(/\s+/g, "");
  const binary = window.atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i) & 0xff;
  }
  return out;
}

async function loadEstimateSpreadsheetReader() {
  if (!estimateSpreadsheetReaderPromise) {
    estimateSpreadsheetReaderPromise = Promise.all([
      import("xlsx"),
      import("xlsx/dist/xlsx.zahl.mjs"),
    ]).then(([xlsxModule, zahlModule]) => ({
      XLSX: xlsxModule?.default || xlsxModule,
      xlsxZahl: zahlModule?.default || zahlModule,
    }));
  }
  return estimateSpreadsheetReaderPromise;
}

function spreadsheetRowsContainPlaceholders(rows) {
  for (const row of rows || []) {
    for (const cell of row || []) {
      const value = String(cell || "");
      if (/\{\{\s*[^{}\n]+\s*\}\}/.test(value) || /\[\[\s*[^\n]+\s*\]\]/.test(value)) {
        return true;
      }
    }
  }
  return false;
}

function normalizeSpreadsheetLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumberLikeText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.replace(/,/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function setSheetRowTokenValue(row, labelCol, token) {
  const targetCol = Math.max(0, Number(labelCol || 0) + 1);
  while (row.length <= targetCol) row.push("");
  row[targetCol] = `{{${token}}}`;
}

function autoTokenizeSpreadsheetRows(rows) {
  const out = (rows || []).map((r) => (Array.isArray(r) ? [...r] : []));
  for (const row of out) {
    for (let c = 0; c < row.length; c += 1) {
      const label = normalizeSpreadsheetLabel(row[c]);
      if (!label) continue;

      if (label.includes("name of property")) {
        setSheetRowTokenValue(row, c, "PROJECT_NAME");
        continue;
      }
      if (label.includes("date measured")) {
        setSheetRowTokenValue(row, c, "DATE_LOCAL");
        continue;
      }
      if (label.includes("total grass")) {
        setSheetRowTokenValue(row, c, "TURF_SQFT");
        continue;
      }
      if (label.includes("total beds") || label.includes("yards of mulch")) {
        setSheetRowTokenValue(row, c, "MULCH_SQFT");
        continue;
      }
      if (label === "page 2 totals") {
        setSheetRowTokenValue(row, c, c <= 3 ? "TURF_SQFT" : "MULCH_SQFT");
      }
    }
  }
  return out;
}

function pickEstimateTemplateSheetName(XLSX, workbook, templateKind) {
  const names = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];

  const landscaping = String(templateKind || "").toLowerCase() === "landscaping";
  let bestName = names[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const name of names) {
    const sheet = workbook?.Sheets?.[name];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      blankrows: false,
      defval: "",
    });
    const sample = rows
      .flat()
      .slice(0, 450)
      .map((v) => normalizeSpreadsheetLabel(v))
      .join(" ");
    const nameNorm = normalizeSpreadsheetLabel(name);

    let score = 0;
    if (landscaping) {
      if (sample.includes("grass")) score += 4;
      if (sample.includes("turf")) score += 4;
      if (sample.includes("mulch")) score += 5;
      if (sample.includes("landscape")) score += 3;
      if (nameNorm.includes("maint") || nameNorm.includes("land")) score += 2;
    } else {
      if (sample.includes("plow")) score += 5;
      if (sample.includes("sidewalk")) score += 5;
      if (sample.includes("snow")) score += 4;
      if (sample.includes("salt")) score += 2;
      if (nameNorm.includes("snow") || nameNorm.includes("winter")) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  return bestName;
}

function getSectionKeyFromCell(cellNorm) {
  if (!cellNorm) return "";
  for (const key of LAYER_KEYS) {
    if (
      (ESTIMATE_SECTION_HINTS[key] || []).some((hint) => cellNorm.includes(hint)) &&
      !cellNorm.includes("total")
    ) {
      return key;
    }
  }
  return "";
}

function detectSqftColumnForSection(rows, headerRowIndex, nameCol, maxSearchCol = Number.POSITIVE_INFINITY) {
  const headerRow = Array.isArray(rows?.[headerRowIndex]) ? rows[headerRowIndex] : [];
  const maxHeaderCol = Math.min(
    headerRow.length - 1,
    Number.isFinite(maxSearchCol) ? maxSearchCol : headerRow.length - 1
  );
  for (let c = nameCol + 1; c <= maxHeaderCol; c += 1) {
    const norm = normalizeSpreadsheetLabel(headerRow[c]);
    if (norm.includes("sq ft") || norm.includes("sqft") || norm.includes("square ft")) {
      return c;
    }
  }

  let best = Math.max(nameCol + 1, 0);
  for (let r = headerRowIndex + 1; r < Math.min(rows.length, headerRowIndex + 5); r += 1) {
    const row = Array.isArray(rows?.[r]) ? rows[r] : [];
    const maxRowCol = Math.min(
      row.length - 1,
      nameCol + 8,
      Number.isFinite(maxSearchCol) ? maxSearchCol : row.length - 1
    );
    for (let c = nameCol + 1; c <= maxRowCol; c += 1) {
      const value = row[c];
      const numeric = parseNumberLikeText(value);
      if (numeric !== null || String(value || "").trim() === "") {
        best = Math.max(best, c);
      }
    }
  }
  return best;
}

function isStopRowLabel(cellNorm) {
  return ESTIMATE_STOP_ROW_HINTS.some((hint) => cellNorm.includes(hint));
}

function fillTemplateHeaderRows(rows, tokens) {
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c += 1) {
      const label = normalizeSpreadsheetLabel(row[c]);
      if (!label) continue;
      if (label.includes("name of property")) {
        while (row.length <= c + 1) row.push("");
        row[c + 1] = String(tokens.PROJECT_NAME || "");
      } else if (label.includes("date measured")) {
        while (row.length <= c + 1) row.push("");
        row[c + 1] = String(tokens.DATE_LOCAL || "");
      } else if (label.includes("location (city") || label === "location") {
        while (row.length <= c + 1) row.push("");
        if (!String(row[c + 1] || "").trim()) {
          row[c + 1] = String(tokens.PROJECT_NAME || "");
        }
      }
    }
  }
}

function applySectionRowsToSheetRows(rows, sectionItems) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const headers = [];

  for (let r = 0; r < rows.length; r += 1) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const nonEmpty = row.filter((cell) => String(cell || "").trim()).length;
    const rowHasSqftLabel = row.some((cell) => {
      const norm = normalizeSpreadsheetLabel(cell);
      return norm.includes("sq ft") || norm.includes("sqft") || norm.includes("square ft");
    });

    const rowSectionCandidates = [];
    for (let c = 0; c < row.length; c += 1) {
      const cellNorm = normalizeSpreadsheetLabel(row[c]);
      const sectionKey = getSectionKeyFromCell(cellNorm);
      if (!sectionKey) continue;
      if (!rowHasSqftLabel && nonEmpty > 4) continue;
      const duplicate = rowSectionCandidates.some((candidate) => candidate.key === sectionKey);
      if (duplicate) continue;
      rowSectionCandidates.push({
        key: sectionKey,
        headerRow: r,
        nameCol: c,
      });
    }
    rowSectionCandidates.sort((a, b) => a.nameCol - b.nameCol);
    for (let i = 0; i < rowSectionCandidates.length; i += 1) {
      const candidate = rowSectionCandidates[i];
      const nextNameCol = rowSectionCandidates[i + 1]?.nameCol;
      const maxSearchCol =
        typeof nextNameCol === "number" ? Math.max(candidate.nameCol + 1, nextNameCol - 1) : Number.POSITIVE_INFINITY;
      headers.push({
        ...candidate,
        sqftCol: detectSqftColumnForSection(rows, r, candidate.nameCol, maxSearchCol),
      });
    }
  }

  headers.sort((a, b) => a.headerRow - b.headerRow || a.nameCol - b.nameCol);

  for (let h = 0; h < headers.length; h += 1) {
    const header = headers[h];
    const items = Array.isArray(sectionItems?.[header.key]) ? sectionItems[header.key] : [];
    if (items.length === 0) continue;

    const nextHeader = headers.slice(h + 1).find((candidate) => candidate.headerRow > header.headerRow);
    const rowStart = header.headerRow + 1;
    let rowEnd = nextHeader ? nextHeader.headerRow : rows.length;

    for (let r = rowStart; r < rowEnd; r += 1) {
      const row = Array.isArray(rows[r]) ? rows[r] : [];
      const rowNorm = row.map((cell) => normalizeSpreadsheetLabel(cell));
      if (rowNorm.some(isStopRowLabel)) {
        rowEnd = r;
        break;
      }
    }

    let itemIdx = 0;
    for (let r = rowStart; r < rowEnd; r += 1) {
      if (itemIdx >= items.length) break;
      const row = Array.isArray(rows[r]) ? rows[r] : [];
      while (row.length <= header.sqftCol) row.push("");
      const nameValue = String(row[header.nameCol] || "").trim();
      const sqftValue = String(row[header.sqftCol] || "").trim();
      const rowNorm = row.map((cell) => normalizeSpreadsheetLabel(cell));
      if (rowNorm.some((cell) => cell.includes("total") || cell.includes("markup"))) continue;
      const nameFillable = !nameValue || /\{\{|\[\[/.test(nameValue);
      const sqftNumber = parseNumberLikeText(sqftValue);
      const sqftFillable =
        !sqftValue || /\{\{|\[\[/.test(sqftValue) || sqftNumber === 0;
      if (!nameFillable && !sqftFillable) continue;
      const item = items[itemIdx];
      row[header.nameCol] = item.name;
      row[header.sqftCol] = item.sqft.toLocaleString();
      itemIdx += 1;
    }
  }
}

function applyLabeledTotalsToSheetRows(rows, sectionItems) {
  const totals = {};
  for (const key of LAYER_KEYS) {
    const list = Array.isArray(sectionItems?.[key]) ? sectionItems[key] : [];
    totals[key] = list.reduce((sum, item) => sum + Math.max(0, Number(item?.sqft || 0)), 0);
  }

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c += 1) {
      const label = normalizeSpreadsheetLabel(row[c]);
      if (!label) continue;

      for (const key of LAYER_KEYS) {
        const aliases = ESTIMATE_TOTAL_LABEL_HINTS[key] || [];
        if (!aliases.some((alias) => label.includes(alias))) continue;
        let targetCol = Math.max(c + 1, 0);
        for (let look = c + 1; look < Math.min(row.length, c + 6); look += 1) {
          const v = String(row[look] || "").trim();
          if (!v || parseNumberLikeText(v) !== null || /\{\{|\[\[/.test(v)) {
            targetCol = look;
            break;
          }
        }
        while (row.length <= targetCol) row.push("");
        row[targetCol] = totals[key].toLocaleString();
      }
    }
  }
}

function fillEstimateWorkbookSheet(XLSX, sheet, tokens, sectionItems) {
  if (!sheet || !XLSX?.utils) return;
  const originalRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    blankrows: true,
    defval: "",
  });
  if (!Array.isArray(originalRows) || originalRows.length === 0) return;

  let rows = originalRows.map((row) => (Array.isArray(row) ? [...row] : []));
  const hasTemplatePlaceholders = spreadsheetRowsContainPlaceholders(rows);
  if (!hasTemplatePlaceholders) {
    rows = autoTokenizeSpreadsheetRows(rows);
  }

  rows = rows.map((row) =>
    row.map((cell) => applyEstimateTemplateText(String(cell ?? ""), tokens))
  );

  fillTemplateHeaderRows(rows, tokens);
  applySectionRowsToSheetRows(rows, sectionItems);
  applyLabeledTotalsToSheetRows(rows, sectionItems);

  XLSX.utils.sheet_add_aoa(sheet, rows, { origin: "A1" });
}

function buildEstimateSectionLineItems(layerFeatures) {
  const items = {
    plowable: [],
    sidewalks: [],
    turf: [],
    mulch: [],
  };

  for (const key of LAYER_KEYS) {
    let unnamedIndex = 1;
    for (const feature of layerFeatures?.[key] || []) {
      if (!isPolygonLike(feature)) continue;
      const sqft = Math.max(0, Math.round(featureSqft(feature)));
      if (!Number.isFinite(sqft) || sqft <= 0) continue;
      const rawName = String(feature?.properties?.name || "").trim();
      const name =
        rawName && rawName !== "(unnamed)"
          ? rawName
          : `${LAYER_META[key].name} ${unnamedIndex}`;
      items[key].push({ name, sqft });
      unnamedIndex += 1;
    }
    items[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  return items;
}

async function readEstimateTemplateUpload(file, templateKind) {
  const fallbackName = String(file?.name || "estimate-template.txt");
  if (!file) {
    throw new Error("No file selected.");
  }

  if (!isBinarySpreadsheetTemplateFile(file)) {
    const content = await file.text();
    return {
      name: fallbackName,
      mime: String(file.type || "text/plain"),
      content: String(content || ""),
      format: "text",
      binaryBase64: "",
      binaryExt: "",
      convertedFromSpreadsheet: false,
    };
  }

  const { XLSX, xlsxZahl } = await loadEstimateSpreadsheetReader();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const workbook = XLSX.read(bytes, {
    type: "array",
    dense: true,
    raw: false,
    cellFormula: false,
    numbers: xlsxZahl,
  });
  const selectedSheetName = pickEstimateTemplateSheetName(XLSX, workbook, templateKind);
  const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
  if (sheetNames.length === 0) {
    throw new Error("Spreadsheet has no sheets.");
  }
  let hasTemplatePlaceholders = false;
  for (const sheetName of sheetNames) {
    const sheet = workbook?.Sheets?.[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      blankrows: true,
      defval: "",
    });
    if (spreadsheetRowsContainPlaceholders(rows)) {
      hasTemplatePlaceholders = true;
      break;
    }
  }
  const extMatch = String(fallbackName).match(/\.([^.]+)$/u);
  const binaryExt = (extMatch?.[1] || "xlsx").toLowerCase();
  return {
    name: fallbackName,
    mime: String(file.type || "application/octet-stream"),
    content: "",
    format: "workbook",
    binaryBase64: uint8ArrayToBase64(bytes),
    binaryExt,
    convertedFromSpreadsheet: true,
    selectedSheetName,
    hasTemplatePlaceholders,
    sheetCount: sheetNames.length,
    templateKind: templateKind === "snow" ? "snow" : "landscaping",
  };
}

function setDrawPaintByIdPrefix(map, prefix, prop, value) {
  const layers = map?.getStyle?.()?.layers || [];
  for (const l of layers) {
    if (typeof l.id === "string" && l.id.startsWith(prefix) && map.getLayer(l.id)) {
      map.setPaintProperty(l.id, prop, value);
    }
  }
}

function countPolygonVertices(feature) {
  if (!isPolygonLike(feature)) return 0;
  const geometry = feature.geometry;
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
  let count = 0;
  for (const polyCoords of polygons) {
    const ring = Array.isArray(polyCoords?.[0]) ? polyCoords[0] : [];
    if (Array.isArray(ring) && ring.length > 1) count += Math.max(0, ring.length - 1);
  }
  return count;
}

function distanceMetersLngLat(aLng, aLat, bLng, bLat) {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const dLat = lat2 - lat1;
  const dLon = toRad(bLng) - toRad(aLng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export default function App() {
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const mapDivRef = useRef(null);

  // Keys (.env)
  const maptilerKey = import.meta.env.VITE_MAPTILER_KEY;
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
  const azureMapsKey = import.meta.env.VITE_AZURE_MAPS_KEY;
  const googleMapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const aiEnabled =
    String(import.meta.env.VITE_ENABLE_AI ?? "true").toLowerCase() !== "false";

  // Provider switcher
  const [baseMap, setBaseMap] = useState("maptiler"); // "maptiler" | "google" | "mapbox" | "azure"
  const [azureHybridLabels, setAzureHybridLabels] = useState(false);
  const [review3d, setReview3d] = useState(false);
  const [terrain3d, setTerrain3d] = useState(false);
  const [terrainExaggeration, setTerrainExaggeration] = useState(DEFAULT_TERRAIN_EXAGGERATION);
  const [objects3d, setObjects3d] = useState(false);
  const [objects3dOpacity, setObjects3dOpacity] = useState(DEFAULT_3D_OBJECT_OPACITY);
  const [workflowMode, setWorkflowMode] = useState(
    () => readStoredWorkflowMode() || WORKFLOW_MODE_LOCATION
  );
  const [saveInProgress, setSaveInProgress] = useState(false);
  const [lastManualSaveAt, setLastManualSaveAt] = useState("");
  const [savedProjectSignature, setSavedProjectSignature] = useState("");
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [versionCompareId, setVersionCompareId] = useState("");
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [activeSharedProjectMeta, setActiveSharedProjectMeta] = useState({
    id: "",
    lastEditedAt: "",
    savedBy: "",
  });
  const [remoteSharedUpdateNotice, setRemoteSharedUpdateNotice] = useState(null);
  const [showWorkflowPicker, setShowWorkflowPicker] = useState(
    () => !readStoredWorkflowMode()
  );
  const [showTrue3DViewer, setShowTrue3DViewer] = useState(false);
  const [true3DLoading, setTrue3DLoading] = useState(false);
  const [true3DStatus, setTrue3DStatus] = useState("");
  const [true3DEditMode, setTrue3DEditMode] = useState(false);
  const [true3DToolMode, setTrue3DToolMode] = useState("pan"); // "pan" | "edit"
  const [true3DSelectedFeatureId, setTrue3DSelectedFeatureId] = useState("");
  const true3DContainerRef = useRef(null);
  const true3DViewerRef = useRef(null);
  const true3DOverlayEntityIdsRef = useRef([]);
  const true3DEditEntityIdsRef = useRef([]);
  const true3DEventHandlerRef = useRef(null);
  const true3DSelectedFeatureIdRef = useRef("");
  const true3DDraggingRef = useRef(false);
  const pdfUploadPromptInputRef = useRef(null);
  const commandPaletteInputRef = useRef(null);

  // Project name
  const [projectName, setProjectName] = useState("");
  const [projectLibrary, setProjectLibrary] = useState(() => readStoredProjectLibrary());
  const [projectVersionHistory, setProjectVersionHistory] = useState(() =>
    readStoredProjectVersionHistory()
  );
  const [sharedProjectQueue, setSharedProjectQueue] = useState(() =>
    readStoredSharedProjectQueue()
  );
  const [sharedAuth, setSharedAuth] = useState(() => readStoredSharedAuth());
  const [sharedAuthChecking, setSharedAuthChecking] = useState(() =>
    !!readStoredSharedAuth().token
  );
  const [sharedLoginUsername, setSharedLoginUsername] = useState(
    () => readStoredSharedAuth().username || "admin"
  );
  const [sharedLoginPassword, setSharedLoginPassword] = useState("");
  const [sharedLoginSubmitting, setSharedLoginSubmitting] = useState(false);
  const [sharedProjectLibraryStatus, setSharedProjectLibraryStatus] = useState(() =>
    readStoredSharedAuth().token ? "connecting" : "locked"
  );
  const [sharedProjectLibrarySyncing, setSharedProjectLibrarySyncing] = useState(false);
  const [sharedProjectQueueSyncing, setSharedProjectQueueSyncing] = useState(false);
  const [securityAuditEvents, setSecurityAuditEvents] = useState([]);
  const [securityAuditSyncing, setSecurityAuditSyncing] = useState(false);
  const [showLegalNotes, setShowLegalNotes] = useState(false);
  const sharedAccessToken = String(sharedAuth?.token || "").trim();
  const sharedAccessAuthenticated = !!sharedAccessToken;
  const [appScreen, setAppScreen] = useState(APP_SCREEN_HOME); // "home" | "location" | "pdf"
  const [estimateTemplates, setEstimateTemplates] = useState(() =>
    readStoredEstimateTemplates()
  );
  const [propertyLookupProvider, setPropertyLookupProvider] = useState(() =>
    googleMapsKey
      ? PROPERTY_LOOKUP_PROVIDER_GOOGLE
      : PROPERTY_LOOKUP_PROVIDER_MAPTILER
  );
  const [propertyLookupQuery, setPropertyLookupQuery] = useState("");
  const [propertyLookupLoading, setPropertyLookupLoading] = useState(false);
  const [propertyLookupSuggestLoading, setPropertyLookupSuggestLoading] = useState(false);
  const [propertyLookupSuggestions, setPropertyLookupSuggestions] = useState([]);
  const [propertyLookupSuggestOpen, setPropertyLookupSuggestOpen] = useState(false);
  const [propertyLookupSuggestIndex, setPropertyLookupSuggestIndex] = useState(-1);
  const [drawingBoundary, setDrawingBoundary] = useState(false);
  const [turfEraseMode, setTurfEraseMode] = useState(false);
  const isWorkspaceScreen = appScreen !== APP_SCREEN_HOME;

  const [boundary, setBoundary] = useState(null);
  const [activeLayer, setActiveLayer] = useState("plowable");
  const [layerFeatures, setLayerFeatures] = useState({
    plowable: [],
    sidewalks: [],
    turf: [],
    mulch: [],
  });

  // Layer visibility + boundary mask controls
  const [layerVisible, setLayerVisible] = useState({
    plowable: true,
    sidewalks: true,
    turf: true,
    mulch: true,
  });
  const [lockNonActiveLayers, setLockNonActiveLayers] = useState(false);
  const [autosaveDraftAvailable, setAutosaveDraftAvailable] = useState(false);
  const [maskOutsideBoundary, setMaskOutsideBoundary] = useState(true);
  const [warnOutsideBoundary, setWarnOutsideBoundary] = useState(true);
  const [snapToEdges, setSnapToEdges] = useState(false);
  const [snapDistanceM, setSnapDistanceM] = useState(DEFAULT_SNAP_DISTANCE_M);
  const [applePencilMode, setApplePencilMode] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isCompactTouchUi, setIsCompactTouchUi] = useState(false);
  const [autoMeasuring, setAutoMeasuring] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState([]);
  const [measureResult, setMeasureResult] = useState(null);
  const [measurementType, setMeasurementType] = useState("lawn_area");
  const [knownDistanceFtInput, setKnownDistanceFtInput] = useState("20");
  const [knownDistancePixelsInput, setKnownDistancePixelsInput] = useState("100");
  const [pdfScaleInchesInput, setPdfScaleInchesInput] = useState("1");
  const [pdfScaleFeetPerInchInput, setPdfScaleFeetPerInchInput] = useState("20");
  const [pdfAnnotationTool, setPdfAnnotationTool] = useState("select"); // select | pen | marker | shape | text
  const [pdfAnnotationColor, setPdfAnnotationColor] = useState(PDF_ANNOT_DEFAULT_COLOR);
  const [pdfAnnotationWidth, setPdfAnnotationWidth] = useState(4);
  const [pdfAnnotationTextDraft, setPdfAnnotationTextDraft] = useState("Note");
  const [pdfAnnotations, setPdfAnnotations] = useState([]);
  const [measurementImageFile, setMeasurementImageFile] = useState(null);
  const [pdfConverting, setPdfConverting] = useState(false);
  const [planOverlay, setPlanOverlay] = useState(null);
  const [planOverlayEnabled, setPlanOverlayEnabled] = useState(false);
  const [planOverlayOpacity, setPlanOverlayOpacity] = useState(0.95);
  const [backendMeasurementResult, setBackendMeasurementResult] = useState(null);
  const [segmentationResult, setSegmentationResult] = useState(null);
  const [measurementHistory, setMeasurementHistory] = useState([]);
  const [backendSubmitting, setBackendSubmitting] = useState(false);
  const [backendCalibrating, setBackendCalibrating] = useState(false);
  const [capturingMapImage, setCapturingMapImage] = useState(false);
  const [segmentingImage, setSegmentingImage] = useState(false);
  const [trainingExporting, setTrainingExporting] = useState(false);

  // When editing/drawing, make outlines thinner so vertices are easy to grab
  const [isEditing, setIsEditing] = useState(false);

  // Draw mode indicator
  const [drawMode, setDrawMode] = useState("simple_select");

  // Toasts
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(1);
  const pushToast = useCallback((message, type = "info", ms = 3500) => {
    const id = toastIdRef.current++;
    setToasts((p) => [...p, { id, message, type }]);
    if (ms > 0) {
      setTimeout(() => {
        setToasts((p) => p.filter((t) => t.id !== id));
      }, ms);
    }
    return id;
  }, []);
  const closeToast = useCallback((id) => {
    setToasts((p) => p.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WORKFLOW_MODE_STORAGE_KEY, workflowMode);
    } catch {
      /* intentionally ignore localStorage errors */
    }
  }, [workflowMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        ESTIMATE_TEMPLATES_STORAGE_KEY,
        JSON.stringify(estimateTemplates)
      );
    } catch {
      /* intentionally ignore localStorage errors */
    }
  }, [estimateTemplates]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        PROJECT_LIBRARY_STORAGE_KEY,
        JSON.stringify((projectLibrary || []).slice(0, PROJECT_LIBRARY_MAX_ENTRIES))
      );
    } catch {
      /* intentionally ignore localStorage errors */
    }
  }, [projectLibrary]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        PROJECT_VERSION_HISTORY_STORAGE_KEY,
        JSON.stringify(projectVersionHistory || {})
      );
    } catch {
      /* intentionally ignore localStorage errors */
    }
  }, [projectVersionHistory]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        SHARED_PROJECT_QUEUE_STORAGE_KEY,
        JSON.stringify(sharedProjectQueue || [])
      );
    } catch {
      /* intentionally ignore localStorage errors */
    }
  }, [sharedProjectQueue]);

  useEffect(() => {
    setSharedAuthToken(sharedAccessToken);
  }, [sharedAccessToken]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (sharedAccessToken) {
        window.localStorage.setItem(
          SHARED_AUTH_STORAGE_KEY,
          JSON.stringify({
            token: sharedAccessToken,
            username: String(sharedAuth?.username || "admin").trim() || "admin",
            expiresAt: String(sharedAuth?.expiresAt || "").trim(),
          })
        );
      } else {
        window.localStorage.setItem(
          SHARED_AUTH_STORAGE_KEY,
          JSON.stringify({
            token: "",
            username: String(sharedAuth?.username || "admin").trim() || "admin",
            expiresAt: "",
          })
        );
      }
    } catch {
      /* intentionally ignore localStorage errors */
    }
  }, [sharedAccessToken, sharedAuth?.expiresAt, sharedAuth?.username]);

  useEffect(() => {
    let canceled = false;
    if (!sharedAccessToken) {
      setSharedAuthChecking(false);
      setSharedProjectLibraryStatus("locked");
      return () => {
        canceled = true;
      };
    }

    setSharedAuthChecking(true);
    setSharedProjectLibraryStatus((prev) =>
      prev === "connected" ? "connected" : "connecting"
    );

    (async () => {
      try {
        const session = await getSharedAccessSession();
        if (canceled) return;
        const username = String(session?.username || sharedAuth?.username || "admin").trim() || "admin";
        const expiresAt = String(session?.expires_at || sharedAuth?.expiresAt || "").trim();
        setSharedAuth((prev) => {
          const next = {
            token: sharedAccessToken,
            username,
            expiresAt,
          };
          if (
            String(prev?.token || "") === next.token &&
            String(prev?.username || "") === next.username &&
            String(prev?.expiresAt || "") === next.expiresAt
          ) {
            return prev;
          }
          return next;
        });
        setSharedLoginUsername(username);
        setSharedProjectLibraryStatus("connected");
      } catch (error) {
        if (canceled) return;
        if (isAuthError(error)) {
          setSharedAuth((prev) => ({
            token: "",
            username: String(prev?.username || sharedLoginUsername || "admin").trim() || "admin",
            expiresAt: "",
          }));
          setSharedProjectLibraryStatus("locked");
          pushToast("Shared session expired. Log in again to access shared files.", "warn", 5200);
        } else {
          setSharedProjectLibraryStatus("offline");
        }
      } finally {
        if (!canceled) setSharedAuthChecking(false);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [pushToast, sharedAccessToken, sharedAuth?.expiresAt, sharedAuth?.username, sharedLoginUsername]);

  const refreshSharedProjectLibrary = useCallback(
    async ({ quiet = true } = {}) => {
      if (!sharedAccessAuthenticated) {
        setSharedProjectLibraryStatus("locked");
        if (!quiet) {
          pushToast("Log in to access shared project files.", "warn", 4200);
        }
        return;
      }
      if (!quiet) setSharedProjectLibrarySyncing(true);
      try {
        const shared = await listSharedProjects(PROJECT_LIBRARY_MAX_ENTRIES);
        setProjectLibrary((prev) => mergeSharedProjectLibrarySummaries(prev, shared));
        setSharedProjectLibraryStatus("connected");
        if (!quiet) {
          pushToast("Shared project library refreshed.", "info", 3200);
        }
      } catch (error) {
        if (isAuthError(error)) {
          setSharedAuth((prev) => ({
            token: "",
            username: String(prev?.username || sharedLoginUsername || "admin").trim() || "admin",
            expiresAt: "",
          }));
          setSharedProjectLibraryStatus("locked");
          if (!quiet) {
            pushToast("Shared session expired. Log in again.", "warn", 5200);
          }
        } else {
          setSharedProjectLibraryStatus("offline");
        }
        if (!quiet) {
          pushToast(
            `Shared project sync failed: ${error?.message || "backend unavailable"}.`,
            "warn",
            5200
          );
        }
      } finally {
        if (!quiet) setSharedProjectLibrarySyncing(false);
      }
    },
    [pushToast, sharedAccessAuthenticated, sharedLoginUsername]
  );

  const refreshSecurityAuditEvents = useCallback(
    async ({ quiet = true } = {}) => {
      if (!sharedAccessAuthenticated) {
        setSecurityAuditEvents([]);
        if (!quiet) {
          pushToast("Log in to view security audit events.", "warn", 4200);
        }
        return;
      }
      setSecurityAuditSyncing(true);
      try {
        const events = await getSecurityAuditEvents(180);
        setSecurityAuditEvents(Array.isArray(events) ? events : []);
        if (!quiet) {
          pushToast("Security audit log refreshed.", "info", 3200);
        }
      } catch (error) {
        if (isAuthError(error)) {
          setSharedAuth((prev) => ({
            token: "",
            username: String(prev?.username || sharedLoginUsername || "admin").trim() || "admin",
            expiresAt: "",
          }));
          setSharedProjectLibraryStatus("locked");
          setSecurityAuditEvents([]);
          if (!quiet) {
            pushToast("Shared session expired. Log in again.", "warn", 5200);
          }
        } else if (!quiet) {
          pushToast(
            `Audit log refresh failed: ${error?.message || "backend unavailable"}.`,
            "warn",
            5200
          );
        }
      } finally {
        setSecurityAuditSyncing(false);
      }
    },
    [pushToast, sharedAccessAuthenticated, sharedLoginUsername]
  );

  const syncSharedProjectQueue = useCallback(
    async ({ quiet = true } = {}) => {
      if (sharedProjectQueueSyncingRef.current) return;
      const queue = Array.isArray(sharedProjectQueueRef.current)
        ? sharedProjectQueueRef.current
        : [];
      if (!queue.length) return;
      if (!sharedAccessAuthenticated) {
        setSharedProjectLibraryStatus("locked");
        if (!quiet) {
          pushToast("Log in to sync queued shared project updates.", "warn", 4500);
        }
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setSharedProjectLibraryStatus("offline");
        if (!quiet) {
          pushToast("Device is offline. Shared saves are queued.", "warn", 4200);
        }
        return;
      }

      sharedProjectQueueSyncingRef.current = true;
      if (!quiet) setSharedProjectQueueSyncing(true);
      let syncedCount = 0;
      let remaining = [...queue];
      let lastError = null;

      try {
        for (const op of queue) {
          try {
            if (op.op === "delete") {
              await deleteSharedProject(op.id);
            } else {
              await saveSharedProject({
                id: op.id,
                projectName: op.projectName || "",
                savedAt: op.savedAt || null,
                polygonCount: Number(op.polygonCount || 0),
                hasBoundary: !!op.hasBoundary,
                payload: op.payload,
              });
            }
            syncedCount += 1;
            remaining.shift();
          } catch (error) {
            lastError = error;
            break;
          }
        }

        setSharedProjectQueue((latest) => {
          const latestQueue = Array.isArray(latest) ? latest : [];
          // Preserve any newly queued items that were added after this sync started.
          const lateQueued =
            latestQueue.length > queue.length ? latestQueue.slice(queue.length) : [];
          return [...remaining, ...lateQueued];
        });

        if (syncedCount > 0) {
          setSharedProjectLibraryStatus("connected");
          await refreshSharedProjectLibrary({ quiet: true });
          if (!quiet) {
            pushToast(
              `Synced ${syncedCount} queued shared project update${syncedCount === 1 ? "" : "s"}.`,
              "info",
              4500
            );
          }
        }

        if (lastError) {
          if (isAuthError(lastError)) {
            setSharedAuth((prev) => ({
              token: "",
              username: String(prev?.username || sharedLoginUsername || "admin").trim() || "admin",
              expiresAt: "",
            }));
            setSharedProjectLibraryStatus("locked");
          } else {
            setSharedProjectLibraryStatus("offline");
          }
          if (!quiet) {
            pushToast(
              `Shared sync paused: ${lastError?.message || "network unavailable"}.`,
              "warn",
              6000
            );
          }
        }
      } finally {
        sharedProjectQueueSyncingRef.current = false;
        if (!quiet) setSharedProjectQueueSyncing(false);
      }
    },
    [pushToast, refreshSharedProjectLibrary, sharedAccessAuthenticated, sharedLoginUsername]
  );

  useEffect(() => {
    if (!sharedAccessAuthenticated || sharedAuthChecking) return;
    refreshSharedProjectLibrary({ quiet: true });
  }, [refreshSharedProjectLibrary, sharedAccessAuthenticated, sharedAuthChecking]);

  useEffect(() => {
    if (!sharedAccessAuthenticated || sharedAuthChecking) return;
    if (!(sharedProjectQueue?.length > 0)) return;
    syncSharedProjectQueue({ quiet: true });
  }, [sharedProjectQueue, syncSharedProjectQueue, sharedAccessAuthenticated, sharedAuthChecking]);

  useEffect(() => {
    if (!sharedAccessAuthenticated || sharedAuthChecking) return;
    if (appScreen !== APP_SCREEN_HOME) return;
    refreshSharedProjectLibrary({ quiet: true });
    const timer = setInterval(() => {
      refreshSharedProjectLibrary({ quiet: true });
    }, 15000);
    return () => clearInterval(timer);
  }, [appScreen, refreshSharedProjectLibrary, sharedAccessAuthenticated, sharedAuthChecking]);

  useEffect(() => {
    if (!sharedAccessAuthenticated || sharedAuthChecking) return;
    if (appScreen === APP_SCREEN_HOME) return;
    const projectId = String(activeSharedProjectMeta?.id || "").trim();
    if (!projectId) return;
    let canceled = false;
    const pollForRemoteChanges = async () => {
      try {
        const shared = await listSharedProjects(PROJECT_LIBRARY_MAX_ENTRIES);
        if (canceled) return;
        const match = (Array.isArray(shared) ? shared : []).find(
          (entry) => String(entry?.id || "").trim() === projectId
        );
        if (!match) return;
        const remoteEditedAt = String(
          match?.last_edited_at || match?.lastEditedAt || match?.saved_at || match?.savedAt || ""
        ).trim();
        if (!remoteEditedAt) return;
        const localMeta = activeSharedProjectMetaRef.current || {};
        const localEditedAt = String(localMeta?.lastEditedAt || "").trim();
        if (localEditedAt && remoteEditedAt === localEditedAt) return;
        const remoteSavedBy = String(match?.saved_by || match?.savedBy || "").trim();
        const currentUser = String(sharedAuth?.username || "").trim();
        if (remoteSavedBy && currentUser && remoteSavedBy === currentUser) {
          setActiveSharedProjectMeta((prev) => ({
            ...prev,
            lastEditedAt: remoteEditedAt,
            savedBy: remoteSavedBy,
          }));
          return;
        }
        setRemoteSharedUpdateNotice({
          id: projectId,
          savedBy: remoteSavedBy || "another user",
          lastEditedAt: remoteEditedAt,
        });
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    };

    pollForRemoteChanges();
    const timer = setInterval(pollForRemoteChanges, 20000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [
    activeSharedProjectMeta?.id,
    appScreen,
    sharedAccessAuthenticated,
    sharedAuth?.username,
    sharedAuthChecking,
  ]);

  useEffect(() => {
    if (!sharedAccessAuthenticated) {
      setSecurityAuditEvents([]);
      setSecurityAuditSyncing(false);
      setRemoteSharedUpdateNotice(null);
    }
  }, [sharedAccessAuthenticated]);

  useEffect(() => {
    if (!sharedAccessAuthenticated || sharedAuthChecking) return;
    if (appScreen !== APP_SCREEN_HOME) return;
    refreshSecurityAuditEvents({ quiet: true });
    const timer = setInterval(() => {
      refreshSecurityAuditEvents({ quiet: true });
    }, 30000);
    return () => clearInterval(timer);
  }, [appScreen, refreshSecurityAuditEvents, sharedAccessAuthenticated, sharedAuthChecking]);

  useEffect(() => {
    if (!sharedAccessAuthenticated || sharedAuthChecking) return;
    const timer = setInterval(() => {
      if (sharedProjectQueueRef.current?.length) {
        syncSharedProjectQueue({ quiet: true });
      }
    }, 12000);
    return () => clearInterval(timer);
  }, [syncSharedProjectQueue, sharedAccessAuthenticated, sharedAuthChecking]);

  useEffect(() => {
    if (!sharedAccessAuthenticated || sharedAuthChecking) return;
    const onOnline = () => {
      syncSharedProjectQueue({ quiet: false });
      refreshSharedProjectLibrary({ quiet: true });
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
    };
  }, [refreshSharedProjectLibrary, syncSharedProjectQueue, sharedAccessAuthenticated, sharedAuthChecking]);

  const handleSharedLogin = useCallback(
    async (event) => {
      if (event?.preventDefault) event.preventDefault();
      const username = String(sharedLoginUsername || "").trim();
      const password = String(sharedLoginPassword || "");
      if (!username || !password) {
        pushToast("Enter username and password to access shared files.", "warn", 4200);
        return;
      }
      setSharedLoginSubmitting(true);
      setSharedProjectLibraryStatus("connecting");
      try {
        const response = await loginSharedAccess({ username, password });
        const token = String(response?.token || "").trim();
        if (!token) {
          throw new Error("Login response did not include a session token.");
        }
        const normalizedUsername =
          String(response?.username || username).trim() || "admin";
        const expiresAt = String(response?.expires_at || "").trim();
        setSharedAuth({
          token,
          username: normalizedUsername,
          expiresAt,
        });
        setSharedLoginUsername(normalizedUsername);
        setSharedLoginPassword("");
        setSharedProjectLibraryStatus("connecting");
        pushToast("Shared files unlocked.", "info", 3600);
      } catch (error) {
        setSharedProjectLibraryStatus("locked");
        pushToast(`Shared login failed: ${error?.message || "invalid credentials"}.`, "error", 6200);
      } finally {
        setSharedLoginSubmitting(false);
      }
    },
    [pushToast, sharedLoginPassword, sharedLoginUsername]
  );

  const handleSharedLogout = useCallback(async () => {
    if (sharedAccessAuthenticated) {
      try {
        await logoutSharedAccess();
      } catch {
        /* intentionally ignore non-critical auth/logout errors */
      }
    }
    setSharedAuth((prev) => ({
      token: "",
      username: String(prev?.username || sharedLoginUsername || "admin").trim() || "admin",
      expiresAt: "",
    }));
    setSharedProjectLibraryStatus("locked");
    setSecurityAuditEvents([]);
    pushToast("Logged out from shared files.", "info", 3600);
  }, [pushToast, sharedAccessAuthenticated, sharedLoginUsername]);

  useEffect(() => {
    if (
      propertyLookupProvider === PROPERTY_LOOKUP_PROVIDER_GOOGLE &&
      !googleMapsKey &&
      maptilerKey
    ) {
      setPropertyLookupProvider(PROPERTY_LOOKUP_PROVIDER_MAPTILER);
      return;
    }
    if (
      propertyLookupProvider === PROPERTY_LOOKUP_PROVIDER_MAPTILER &&
      !maptilerKey &&
      googleMapsKey
    ) {
      setPropertyLookupProvider(PROPERTY_LOOKUP_PROVIDER_GOOGLE);
    }
  }, [googleMapsKey, maptilerKey, propertyLookupProvider]);

  const setWorkflowModeAndPrepare = useCallback(
    (nextMode) => {
      const normalized =
        nextMode === WORKFLOW_MODE_PDF ? WORKFLOW_MODE_PDF : WORKFLOW_MODE_LOCATION;
      setWorkflowMode(normalized);
      if (normalized === WORKFLOW_MODE_PDF) {
        setReview3d(false);
        setTerrain3d(false);
        setObjects3d(false);
        pushToast("PDF mode selected. Upload a PDF/image in AI Measurement.", "info", 3200);
      } else {
        pushToast("Location mode selected. Load boundary by KML or address.", "info", 3200);
      }
    },
    [pushToast]
  );

  const openMeasurementScreen = useCallback(
    (nextMode) => {
      const normalized =
        nextMode === WORKFLOW_MODE_PDF ? WORKFLOW_MODE_PDF : WORKFLOW_MODE_LOCATION;
      setWorkflowModeAndPrepare(normalized);
      setShowWorkflowPicker(false);
      setAppScreen(
        normalized === WORKFLOW_MODE_PDF ? APP_SCREEN_PDF : APP_SCREEN_LOCATION
      );
      if (normalized === WORKFLOW_MODE_PDF && !measurementImageFile) {
        setTimeout(() => {
          try {
            pdfUploadPromptInputRef.current?.click?.();
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
        }, 80);
      }
    },
    [measurementImageFile, setWorkflowModeAndPrepare]
  );

  const pdfScaleDerivedFeet = useMemo(() => {
    const inches = Number(pdfScaleInchesInput);
    const feetPerInch = Number(pdfScaleFeetPerInchInput);
    if (!Number.isFinite(inches) || inches <= 0) return null;
    if (!Number.isFinite(feetPerInch) || feetPerInch <= 0) return null;
    return inches * feetPerInch;
  }, [pdfScaleFeetPerInchInput, pdfScaleInchesInput]);

  const applyPdfScaleToKnownFeet = useCallback(() => {
    const derivedFeet = pdfScaleDerivedFeet;
    const inches = Number(pdfScaleInchesInput);
    const feetPerInch = Number(pdfScaleFeetPerInchInput);
    if (!Number.isFinite(derivedFeet) || derivedFeet <= 0) {
      pushToast("Enter valid inches and feet-per-inch scale values first.", "warn");
      return;
    }
    setKnownDistanceFtInput(String(Number(derivedFeet.toFixed(4))));
    pushToast(
      `Known distance set to ${derivedFeet.toFixed(2)} ft (${inches.toFixed(2)} in at ${feetPerInch.toFixed(2)} ft/in).`,
      "info",
      5000
    );
  }, [pdfScaleDerivedFeet, pdfScaleInchesInput, pdfScaleFeetPerInchInput, pushToast]);

  const knownFeetPerPixel = useMemo(() => {
    const feet = Number(knownDistanceFtInput);
    const pixels = Number(knownDistancePixelsInput);
    if (!Number.isFinite(feet) || feet <= 0) return null;
    if (!Number.isFinite(pixels) || pixels <= 0) return null;
    return feet / pixels;
  }, [knownDistanceFtInput, knownDistancePixelsInput]);

  const displayedMeasureResult = useMemo(() => {
    if (!measureResult) return null;
    if (workflowMode === WORKFLOW_MODE_PDF && knownFeetPerPixel) {
      return {
        feet: measureResult.pixels * knownFeetPerPixel,
        pixels: measureResult.pixels,
        scaled: true,
      };
    }
    if (workflowMode === WORKFLOW_MODE_PDF) {
      return { feet: null, pixels: measureResult.pixels, scaled: false };
    }
    return { feet: measureResult.feet, pixels: measureResult.pixels, scaled: false };
  }, [knownFeetPerPixel, measureResult, workflowMode]);

  const effectiveBaseMap = useMemo(
    () => (workflowMode === WORKFLOW_MODE_PDF ? "none" : baseMap),
    [baseMap, workflowMode]
  );

  const applyCurrentMeasurementPixelsToCalibration = useCallback(() => {
    if (!measureResult || !Number.isFinite(Number(measureResult.pixels))) {
      pushToast("Make a 2-point measurement first.", "warn");
      return;
    }
    setKnownDistancePixelsInput(String(Number(measureResult.pixels).toFixed(2)));
    pushToast(
      `Calibration pixels set to ${Number(measureResult.pixels).toFixed(2)} px.`,
      "info",
      4500
    );
  }, [measureResult, pushToast]);

  const refreshPdfAnnotationsSource = useCallback((features = pdfAnnotationsRef.current) => {
    const map = mapRef.current;
    if (!map || !map.getSource(PDF_ANNOTATIONS_SOURCE_ID)) return;
    try {
      map.getSource(PDF_ANNOTATIONS_SOURCE_ID).setData(
        createPdfAnnotationFeatureCollection(features)
      );
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  const ensurePdfAnnotationLayers = useCallback(
    (map = mapRef.current) => {
      if (!map) return;
      if (!map.getSource(PDF_ANNOTATIONS_SOURCE_ID)) {
        map.addSource(PDF_ANNOTATIONS_SOURCE_ID, {
          type: "geojson",
          data: createPdfAnnotationFeatureCollection([]),
        });
      }

      if (!map.getLayer(PDF_ANNOT_FILL_LAYER_ID)) {
        map.addLayer({
          id: PDF_ANNOT_FILL_LAYER_ID,
          type: "fill",
          source: PDF_ANNOTATIONS_SOURCE_ID,
          filter: [
            "all",
            ["==", ["geometry-type"], "Polygon"],
            ["==", ["get", "kind"], "shape"],
          ],
          paint: {
            "fill-color": [
              "coalesce",
              ["get", "fillColor"],
              ["get", "color"],
              PDF_ANNOT_DEFAULT_COLOR,
            ],
            "fill-opacity": [
              "coalesce",
              ["to-number", ["get", "fillOpacity"]],
              0.2,
            ],
          },
        });
      }

      if (!map.getLayer(PDF_ANNOT_LINE_LAYER_ID)) {
        map.addLayer({
          id: PDF_ANNOT_LINE_LAYER_ID,
          type: "line",
          source: PDF_ANNOTATIONS_SOURCE_ID,
          filter: [
            "any",
            ["==", ["geometry-type"], "LineString"],
            ["==", ["geometry-type"], "Polygon"],
          ],
          paint: {
            "line-color": [
              "coalesce",
              ["get", "color"],
              PDF_ANNOT_DEFAULT_COLOR,
            ],
            "line-width": [
              "coalesce",
              ["to-number", ["get", "width"]],
              3,
            ],
            "line-opacity": [
              "coalesce",
              ["to-number", ["get", "opacity"]],
              1,
            ],
          },
        });
      }

      if (!map.getLayer(PDF_ANNOT_TEXT_LAYER_ID)) {
        map.addLayer({
          id: PDF_ANNOT_TEXT_LAYER_ID,
          type: "symbol",
          source: PDF_ANNOTATIONS_SOURCE_ID,
          filter: [
            "all",
            ["==", ["geometry-type"], "Point"],
            ["==", ["get", "kind"], "text"],
          ],
          layout: {
            "text-field": ["coalesce", ["get", "label"], ""],
            "text-size": 15,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-anchor": "top-left",
            "text-offset": [0.2, 0.2],
            "text-allow-overlap": true,
          },
          paint: {
            "text-color": [
              "coalesce",
              ["get", "color"],
              PDF_ANNOT_DEFAULT_COLOR,
            ],
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.2,
          },
        });
      }

      refreshPdfAnnotationsSource(pdfAnnotationsRef.current);
    },
    [refreshPdfAnnotationsSource]
  );

  const addPdfTextAnnotationAt = useCallback(
    (lngLat, explicitText = "") => {
      if (!lngLat) return;
      const label = String(explicitText || pdfAnnotationTextDraftRef.current || "").trim();
      if (!label) {
        pushToast("Type text first, then click on the PDF to place it.", "warn", 4200);
        return;
      }
      const color = normalizeHexColor(
        pdfAnnotationColorRef.current,
        PDF_ANNOT_DEFAULT_COLOR
      );
      const feature = {
        type: "Feature",
        id: `pdf-annot-text-${Date.now()}-${Math.round(Math.random() * 100000)}`,
        properties: {
          kind: "text",
          label,
          color,
          width: 1,
          opacity: 1,
          fillOpacity: 0,
          fillColor: color,
        },
        geometry: {
          type: "Point",
          coordinates: [Number(lngLat.lng), Number(lngLat.lat)],
        },
      };
      setPdfAnnotations((prev) => [...(Array.isArray(prev) ? prev : []), feature]);
      pushToast("Text placed on PDF.", "info", 2500);
    },
    [pushToast]
  );

  const clearPdfAnnotations = useCallback(() => {
    setPdfAnnotations([]);
    pushToast("Cleared all PDF annotations.", "info", 3500);
  }, [pushToast]);

  const removeLastPdfAnnotation = useCallback(() => {
    setPdfAnnotations((prev) => {
      if (!Array.isArray(prev) || prev.length === 0) return [];
      return prev.slice(0, -1);
    });
    pushToast("Removed last PDF annotation.", "info", 2500);
  }, [pushToast]);

  const activatePdfAnnotationTool = useCallback(
    (nextTool) => {
      const allowed = ["select", "pen", "marker", "shape", "text"];
      const tool = allowed.includes(nextTool) ? nextTool : "select";
      setPdfAnnotationTool(tool);
      if (tool !== "select" && measureModeRef.current) {
        setMeasureMode(false);
      }
      if (workflowMode !== WORKFLOW_MODE_PDF) return;
      const draw = drawRef.current;
      if (!draw) return;
      try {
        if (tool === "pen" || tool === "marker") {
          draw.changeMode("draw_line_string");
        } else if (tool === "shape") {
          draw.changeMode("draw_polygon");
        } else {
          draw.changeMode("simple_select");
        }
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    },
    [workflowMode]
  );

  // Confirm modal
  const [confirm, setConfirm] = useState(null);
  const askConfirm = useCallback(
    ({ title, message, confirmText, cancelText, danger, onConfirm }) => {
      setConfirm({
        open: true,
        title,
        message,
        confirmText,
        cancelText,
        danger,
        onConfirm,
      });
    },
    []
  );

  // Avoid stale activeLayer in draw events
  const activeLayerRef = useRef("plowable");
  useEffect(() => {
    activeLayerRef.current = activeLayer;
  }, [activeLayer]);
  const workflowModeRef = useRef(workflowMode);
  useEffect(() => {
    workflowModeRef.current = workflowMode;
  }, [workflowMode]);
  useEffect(() => {
    true3DSelectedFeatureIdRef.current = String(true3DSelectedFeatureId || "");
  }, [true3DSelectedFeatureId]);

  // Stable naming counters per layer
  const nameCountersRef = useRef({
    plowable: 0,
    sidewalks: 0,
    turf: 0,
    mulch: 0,
  });

  // Warn-once per feature id (no spam)
  const warnedOutsideRef = useRef(new Set());
  const suppressDrawSyncRef = useRef(false);
  const suppressDrawSyncRafRef = useRef(null);
  const suppressDrawSyncTimeoutRef = useRef(null);
  const pendingProjectFitRef = useRef(null);
  const measureModeRef = useRef(false);
  const drawingBoundaryRef = useRef(false);
  const turfEraseModeRef = useRef(false);
  const snapToEdgesRef = useRef(false);
  const snapDistanceRef = useRef(DEFAULT_SNAP_DISTANCE_M);
  const applePencilModeRef = useRef(false);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const historySuspendedRef = useRef(false);
  const historyPrevSignatureRef = useRef(layerFeaturesSignature(layerFeatures));
  const historyPrevFeaturesRef = useRef(cloneLayerFeatures(layerFeatures));
  const initialSaveBaselineSetRef = useRef(false);
  const propertyLookupAbortRef = useRef(null);
  const propertyLookupRequestRef = useRef(0);
  const sharedProjectQueueRef = useRef(sharedProjectQueue);
  const sharedProjectQueueSyncingRef = useRef(false);
  const activeSharedProjectMetaRef = useRef(activeSharedProjectMeta);
  const googleTileSessionRef = useRef(null);
  const googleTileSessionExpiryRef = useRef(0);
  const googleTileSessionPromiseRef = useRef(null);
  const baseMapRef = useRef(baseMap);
  const azureHybridLabelsRef = useRef(azureHybridLabels);
  const terrain3dRef = useRef(false);
  const terrainExaggerationRef = useRef(DEFAULT_TERRAIN_EXAGGERATION);
  const objects3dRef = useRef(false);
  const objects3dOpacityRef = useRef(DEFAULT_3D_OBJECT_OPACITY);
  const terrainWarnedRef = useRef(false);
  const planOverlayRef = useRef(null);
  const planOverlayEnabledRef = useRef(false);
  const planOverlayOpacityRef = useRef(0.95);
  const planOverlayObjectUrlRef = useRef(null);
  const pdfAnnotationToolRef = useRef(pdfAnnotationTool);
  const pdfAnnotationColorRef = useRef(pdfAnnotationColor);
  const pdfAnnotationWidthRef = useRef(pdfAnnotationWidth);
  const pdfAnnotationTextDraftRef = useRef(pdfAnnotationTextDraft);
  const pdfAnnotationsRef = useRef(pdfAnnotations);

  const layerFeaturesRef = useRef(layerFeatures);
  useEffect(() => {
    layerFeaturesRef.current = layerFeatures;
  }, [layerFeatures]);

  const layerVisibleRef = useRef(layerVisible);
  useEffect(() => {
    layerVisibleRef.current = layerVisible;
  }, [layerVisible]);

  useEffect(() => {
    sharedProjectQueueRef.current = Array.isArray(sharedProjectQueue)
      ? sharedProjectQueue
      : [];
  }, [sharedProjectQueue]);

  useEffect(() => {
    activeSharedProjectMetaRef.current = activeSharedProjectMeta || {
      id: "",
      lastEditedAt: "",
      savedBy: "",
    };
  }, [activeSharedProjectMeta]);

  useEffect(() => {
    baseMapRef.current = baseMap;
  }, [baseMap]);

  useEffect(() => {
    azureHybridLabelsRef.current = azureHybridLabels;
  }, [azureHybridLabels]);

  useEffect(() => {
    snapToEdgesRef.current = snapToEdges;
  }, [snapToEdges]);

  useEffect(() => {
    const parsed = Number(snapDistanceM);
    snapDistanceRef.current = Number.isFinite(parsed) ? Math.max(0.25, parsed) : DEFAULT_SNAP_DISTANCE_M;
  }, [snapDistanceM]);

  useEffect(() => {
    terrain3dRef.current = terrain3d;
  }, [terrain3d]);

  useEffect(() => {
    const parsed = Number(terrainExaggeration);
    terrainExaggerationRef.current = Number.isFinite(parsed)
      ? Math.max(0.6, Math.min(3.2, parsed))
      : DEFAULT_TERRAIN_EXAGGERATION;
  }, [terrainExaggeration]);

  useEffect(() => {
    objects3dRef.current = !!objects3d;
  }, [objects3d]);

  useEffect(() => {
    const parsed = Number(objects3dOpacity);
    objects3dOpacityRef.current = Number.isFinite(parsed)
      ? Math.max(0.12, Math.min(0.9, parsed))
      : DEFAULT_3D_OBJECT_OPACITY;
  }, [objects3dOpacity]);

  useEffect(() => {
    planOverlayRef.current = planOverlay;
  }, [planOverlay]);

  useEffect(() => {
    pdfAnnotationToolRef.current = pdfAnnotationTool;
  }, [pdfAnnotationTool]);

  useEffect(() => {
    pdfAnnotationColorRef.current = normalizeHexColor(
      pdfAnnotationColor,
      PDF_ANNOT_DEFAULT_COLOR
    );
  }, [pdfAnnotationColor]);

  useEffect(() => {
    const parsed = Number(pdfAnnotationWidth);
    pdfAnnotationWidthRef.current = Number.isFinite(parsed)
      ? Math.max(1, Math.min(30, parsed))
      : 4;
  }, [pdfAnnotationWidth]);

  useEffect(() => {
    pdfAnnotationTextDraftRef.current = String(pdfAnnotationTextDraft || "");
  }, [pdfAnnotationTextDraft]);

  useEffect(() => {
    pdfAnnotationsRef.current = pdfAnnotations;
  }, [pdfAnnotations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded?.()) return;
    ensurePdfAnnotationLayers(map);
    refreshPdfAnnotationsSource(pdfAnnotations);
  }, [ensurePdfAnnotationLayers, pdfAnnotations, refreshPdfAnnotationsSource]);

  useEffect(() => {
    if (workflowMode !== WORKFLOW_MODE_PDF && pdfAnnotationTool !== "select") {
      setPdfAnnotationTool("select");
    }
  }, [pdfAnnotationTool, workflowMode]);

  useEffect(() => {
    planOverlayEnabledRef.current = !!planOverlayEnabled;
  }, [planOverlayEnabled]);

  useEffect(() => {
    const parsed = Number(planOverlayOpacity);
    planOverlayOpacityRef.current = Number.isFinite(parsed)
      ? Math.max(0.15, Math.min(1, parsed))
      : 0.95;
  }, [planOverlayOpacity]);

  useEffect(() => {
    applePencilModeRef.current = applePencilMode;
  }, [applePencilMode]);

  useEffect(() => {
    return () => {
      const prevUrl = planOverlayObjectUrlRef.current;
      if (!prevUrl) return;
      try {
        URL.revokeObjectURL(prevUrl);
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      planOverlayObjectUrlRef.current = null;
    };
  }, []);

  const lockNonActiveLayersRef = useRef(lockNonActiveLayers);
  useEffect(() => {
    lockNonActiveLayersRef.current = lockNonActiveLayers;
  }, [lockNonActiveLayers]);
  useEffect(() => {
    measureModeRef.current = measureMode;
  }, [measureMode]);
  useEffect(() => {
    drawingBoundaryRef.current = drawingBoundary;
  }, [drawingBoundary]);
  useEffect(() => {
    turfEraseModeRef.current = turfEraseMode;
  }, [turfEraseMode]);
  useEffect(() => {
    return () => {
      try {
        propertyLookupAbortRef.current?.abort();
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      try {
        true3DEventHandlerRef.current?.destroy?.();
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      true3DEventHandlerRef.current = null;
      true3DEditEntityIdsRef.current = [];
      true3DOverlayEntityIdsRef.current = [];
      try {
        true3DViewerRef.current?.destroy?.();
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      true3DViewerRef.current = null;
    };
  }, []);

  // Canonical: reload Draw to show all currently visible layer features.
  const reloadDrawForActiveLayer = useCallback(
    (
      featuresByLayer = layerFeaturesRef.current,
      visibilityByLayer = layerVisibleRef.current
    ) => {
      const d = drawRef.current;
      if (!d) return;
      try {
        suppressDrawSyncRef.current = true;
        if (suppressDrawSyncRafRef.current) {
          cancelAnimationFrame(suppressDrawSyncRafRef.current);
          suppressDrawSyncRafRef.current = null;
        }
        if (suppressDrawSyncTimeoutRef.current) {
          clearTimeout(suppressDrawSyncTimeoutRef.current);
          suppressDrawSyncTimeoutRef.current = null;
        }
        d.deleteAll();
        const editableKeys = lockNonActiveLayersRef.current
          ? [activeLayerRef.current]
          : LAYER_KEYS;
        for (const k of editableKeys) {
          if (!visibilityByLayer?.[k]) continue;
          for (const f of featuresByLayer[k] || []) {
            try {
              d.add({
                ...f,
                properties: { ...(f.properties || {}), layer: k },
              });
            } catch {
              /* intentionally ignore non-critical map/draw errors */
            }
          }
        }
      } catch {
      /* intentionally ignore non-critical map/draw errors */
      } finally {
        // Draw can emit delayed create/delete events after programmatic mutations.
        // Keep suppression on briefly so layer switching can't clobber feature state.
        suppressDrawSyncRafRef.current = requestAnimationFrame(() => {
          suppressDrawSyncRafRef.current = null;
          suppressDrawSyncTimeoutRef.current = setTimeout(() => {
            suppressDrawSyncRef.current = false;
            suppressDrawSyncTimeoutRef.current = null;
          }, 180);
        });
      }
    },
    []
  );

  const updateUndoRedoFlags = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  const resetUndoRedoHistory = useCallback(
    (seed = layerFeaturesRef.current) => {
      undoStackRef.current = [];
      redoStackRef.current = [];
      historyPrevFeaturesRef.current = cloneLayerFeatures(seed);
      historyPrevSignatureRef.current = layerFeaturesSignature(seed);
      updateUndoRedoFlags();
    },
    [updateUndoRedoFlags]
  );

  useEffect(() => {
    const currentSig = layerFeaturesSignature(layerFeatures);
    if (historySuspendedRef.current) {
      historyPrevFeaturesRef.current = cloneLayerFeatures(layerFeatures);
      historyPrevSignatureRef.current = currentSig;
      return;
    }

    const prevSig = historyPrevSignatureRef.current;
    if (prevSig && currentSig && prevSig !== currentSig) {
      undoStackRef.current.push(cloneLayerFeatures(historyPrevFeaturesRef.current));
      if (undoStackRef.current.length > UNDO_REDO_MAX_DEPTH) {
        undoStackRef.current.shift();
      }
      redoStackRef.current = [];
      updateUndoRedoFlags();
    }
    historyPrevFeaturesRef.current = cloneLayerFeatures(layerFeatures);
    historyPrevSignatureRef.current = currentSig;
  }, [layerFeatures, updateUndoRedoFlags]);

  const undoLayerEdit = useCallback(() => {
    if (!undoStackRef.current.length) return;
    const previous = undoStackRef.current.pop();
    const current = cloneLayerFeatures(layerFeaturesRef.current);
    redoStackRef.current.push(current);
    if (redoStackRef.current.length > UNDO_REDO_MAX_DEPTH) {
      redoStackRef.current.shift();
    }
    historySuspendedRef.current = true;
    layerFeaturesRef.current = cloneLayerFeatures(previous);
    setLayerFeatures(previous);
    reloadDrawForActiveLayer(previous, layerVisibleRef.current);
    updateUndoRedoFlags();
    requestAnimationFrame(() => {
      historyPrevFeaturesRef.current = cloneLayerFeatures(previous);
      historyPrevSignatureRef.current = layerFeaturesSignature(previous);
      historySuspendedRef.current = false;
    });
  }, [reloadDrawForActiveLayer, updateUndoRedoFlags]);

  const redoLayerEdit = useCallback(() => {
    if (!redoStackRef.current.length) return;
    const next = redoStackRef.current.pop();
    const current = cloneLayerFeatures(layerFeaturesRef.current);
    undoStackRef.current.push(current);
    if (undoStackRef.current.length > UNDO_REDO_MAX_DEPTH) {
      undoStackRef.current.shift();
    }
    historySuspendedRef.current = true;
    layerFeaturesRef.current = cloneLayerFeatures(next);
    setLayerFeatures(next);
    reloadDrawForActiveLayer(next, layerVisibleRef.current);
    updateUndoRedoFlags();
    requestAnimationFrame(() => {
      historyPrevFeaturesRef.current = cloneLayerFeatures(next);
      historyPrevSignatureRef.current = layerFeaturesSignature(next);
      historySuspendedRef.current = false;
    });
  }, [reloadDrawForActiveLayer, updateUndoRedoFlags]);

  useEffect(() => {
    const coarse =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer:coarse)").matches;
    const update = () => {
      const narrow = typeof window !== "undefined" ? window.innerWidth <= 980 : false;
      setIsCompactTouchUi(Boolean(coarse || narrow));
    };
    update();
    if (coarse) {
      setApplePencilMode(true);
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const updateMeasureOverlay = useCallback((points) => {
    const map = mapRef.current;
    if (!map || !map.getSource(MEASURE_SOURCE_ID)) return;
    try {
      map.getSource(MEASURE_SOURCE_ID).setData(buildMeasureFeatureCollection(points));
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  const clearMeasure = useCallback(() => {
    setMeasurePoints([]);
    setMeasureResult(null);
    updateMeasureOverlay([]);
  }, [updateMeasureOverlay]);

  const toggleMeasureMode = useCallback(() => {
    setMeasureMode((prev) => {
      const next = !prev;
      if (next) {
        if (
          workflowModeRef.current === WORKFLOW_MODE_PDF &&
          pdfAnnotationToolRef.current !== "select"
        ) {
          setPdfAnnotationTool("select");
        }
        const d = drawRef.current;
        try {
          d?.changeMode?.("simple_select");
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
        setMeasurePoints([]);
        setMeasureResult(null);
        updateMeasureOverlay([]);
        pushToast(
          workflowModeRef.current === WORKFLOW_MODE_PDF
            ? "Measure mode on: click two points on the PDF."
            : "Measure mode on: click two points on the map.",
          "info"
        );
      } else {
        clearMeasure();
        pushToast("Measure mode off.", "info");
      }
      return next;
    });
  }, [clearMeasure, pushToast, updateMeasureOverlay]);

  const refreshMeasurementHistory = useCallback(async () => {
    if (!aiEnabled) {
      setMeasurementHistory([]);
      return;
    }
    try {
      const history = await getMeasurementHistory(10);
      setMeasurementHistory(history);
    } catch (error) {
      pushToast(`Failed to load history: ${error.message}`, "error", 5000);
    }
  }, [aiEnabled, pushToast]);

  const calibrateFromTwoPoints = useCallback(async () => {
    if (!aiEnabled) {
      pushToast("AI features are disabled in review mode.", "warn");
      return;
    }
    const map = mapRef.current;
    if (!map || measurePoints.length !== 2) {
      pushToast("Create a 2-point measurement first.", "warn");
      return;
    }

    setBackendCalibrating(true);
    try {
      const p1 = map.project(measurePoints[0]);
      const p2 = map.project(measurePoints[1]);
      const result = await calculatePixelDistance(
        { x: p1.x, y: p1.y },
        { x: p2.x, y: p2.y }
      );
      setKnownDistancePixelsInput(String(result.pixel_distance));
      pushToast(`Calibration updated to ${result.pixel_distance.toFixed(2)} px.`, "info");
    } catch (error) {
      pushToast(`Calibration failed: ${error.message}`, "error", 5000);
    } finally {
      setBackendCalibrating(false);
    }
  }, [aiEnabled, measurePoints, pushToast]);

  const applyMeasurementPolygonsToLayers = useCallback(
    (result, nextMeasurementType) => {
      const polygons = result?.polygons || [];
      if (!polygons.length) {
        pushToast("AI measurement returned no polygons to draw.", "warn", 5000);
        return;
      }

      const targetLayer = MEASUREMENT_TYPE_LAYER_MAP[nextMeasurementType] || activeLayerRef.current;
      const next = {
        plowable: [...(layerFeaturesRef.current.plowable || [])],
        sidewalks: [...(layerFeaturesRef.current.sidewalks || [])],
        turf: [...(layerFeaturesRef.current.turf || [])],
        mulch: [...(layerFeaturesRef.current.mulch || [])],
      };

      const stamp = Date.now();
      let added = 0;
      polygons.forEach((polygonPoints, idx) => {
        const ring = polygonPoints.map((pt) => [Number(pt.x), Number(pt.y)]);
        if (ring.length < 3) return;
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          ring.push([...first]);
        }

        const outside =
          boundary && isPolygonLike({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [ring] },
          })
            ? isOutsideBoundary(
                { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] } },
                boundary
              )
            : false;

        const feature = {
          type: "Feature",
          id: `ai-${targetLayer}-${stamp}-${idx + 1}`,
          properties: {
            name: `AI ${LAYER_META[targetLayer].name} ${idx + 1}`,
            layer: targetLayer,
            outside,
          },
          geometry: {
            type: "Polygon",
            coordinates: [ring],
          },
        };
        next[targetLayer].push(feature);
        added += 1;
      });

      if (!added) {
        pushToast("AI polygons were invalid and were not added.", "warn", 5000);
        return;
      }

      setLayerFeatures(next);
      setLayerVisible((prev) => ({ ...prev, [targetLayer]: true }));
      setActiveLayer(targetLayer);
      activeLayerRef.current = targetLayer;

      const nextVisible = { ...layerVisibleRef.current, [targetLayer]: true };
      reloadDrawForActiveLayer(next, nextVisible);
      requestAnimationFrame(() => {
        try {
          const map = mapRef.current;
          if (!map) return;
          const features = [];
          for (const key of LAYER_KEYS) {
            features.push(...(next[key] || []));
          }
          if (!features.length) return;
          const bbox = turf.bbox(turf.featureCollection(features));
          map.fitBounds(bbox, { padding: 50, duration: 650 });
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
      });

      pushToast(`Added ${added} AI polygon(s) to ${LAYER_META[targetLayer].name}.`, "info", 5000);
    },
    [boundary, pushToast, reloadDrawForActiveLayer]
  );

  const applyUploadedPlanOverlay = useCallback((imageFile, announce = true) => {
    if (!imageFile) return;
    const nextUrl = URL.createObjectURL(imageFile);
    const prevUrl = planOverlayObjectUrlRef.current;
    if (prevUrl) {
      try {
        URL.revokeObjectURL(prevUrl);
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    }
    planOverlayObjectUrlRef.current = nextUrl;
    const map = mapRef.current;
    const coords = map ? mapBoundsToImageSourceCoordinates(map) : null;
    setPlanOverlay({
      name: imageFile.name || "uploaded-plan",
      url: nextUrl,
      coordinates: coords,
    });
    setPlanOverlayEnabled(true);
    setReview3d(false);
    setTerrain3d(false);
    setObjects3d(false);
    if (announce) pushToast("Plan overlay loaded on map.", "info", 4500);
  }, [pushToast]);

  const clearUploadedPlanOverlay = useCallback((clearFile = false) => {
    setPlanOverlayEnabled(false);
    setPlanOverlay(null);
    const prevUrl = planOverlayObjectUrlRef.current;
    if (prevUrl) {
      try {
        URL.revokeObjectURL(prevUrl);
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      planOverlayObjectUrlRef.current = null;
    }
    if (clearFile) setMeasurementImageFile(null);
  }, []);

  const reanchorPlanOverlay = useCallback(() => {
    const map = mapRef.current;
    if (!map || !planOverlay?.url) return;
    const coords = mapBoundsToImageSourceCoordinates(map);
    if (!coords) return;
    setPlanOverlay((prev) => (prev?.url ? { ...prev, coordinates: coords } : prev));
    pushToast("Plan overlay re-anchored to current view.", "info", 3500);
  }, [planOverlay, pushToast]);

  const handleMeasurementMediaUpload = useCallback(async (e) => {
    const file = e.target.files?.[0] || null;
    e.target.value = "";
    if (!file) {
      setMeasurementImageFile(null);
      clearUploadedPlanOverlay(false);
      return;
    }
    if (workflowModeRef.current !== WORKFLOW_MODE_PDF || appScreen !== APP_SCREEN_PDF) {
      setWorkflowMode(WORKFLOW_MODE_PDF);
      setAppScreen(APP_SCREEN_PDF);
      setShowWorkflowPicker(false);
      setReview3d(false);
      setTerrain3d(false);
      setObjects3d(false);
    }
    if (!isPdfFile(file)) {
      setMeasurementImageFile(file);
      applyUploadedPlanOverlay(file, false);
      pushToast("Image loaded in PDF/Image measuring page.", "info", 4200);
      return;
    }

    setPdfConverting(true);
    try {
      const convertedImage = await renderPdfPageToImageFile(file, { pageNumber: 1, maxDimension: 2400 });
      setMeasurementImageFile(convertedImage);
      applyUploadedPlanOverlay(convertedImage, false);
      pushToast(`PDF converted to image (page 1): ${convertedImage.name}`, "info", 5500);
    } catch (error) {
      console.error("PDF conversion failed:", error);
      setMeasurementImageFile(null);
      clearUploadedPlanOverlay(false);
      pushToast(`PDF conversion failed: ${error?.message || "could not render page 1."}`, "error", 6500);
    } finally {
      setPdfConverting(false);
    }
  }, [appScreen, applyUploadedPlanOverlay, clearUploadedPlanOverlay, pushToast]);

  const runBackendMeasurement = useCallback(async () => {
    if (!aiEnabled) {
      pushToast("AI features are disabled in review mode.", "warn");
      return;
    }
    if (workflowMode === WORKFLOW_MODE_PDF) {
      pushToast("PDF mode is manual-only. Switch to Measure Location for AI/CV.", "warn");
      return;
    }
    if (pdfConverting) {
      pushToast("PDF is still converting. Please wait.", "warn");
      return;
    }
    const knownDistanceFt = Number(knownDistanceFtInput);
    const knownDistancePixels = Number(knownDistancePixelsInput);
    if (!Number.isFinite(knownDistanceFt) || knownDistanceFt <= 0) {
      pushToast("Known distance (ft) must be greater than 0.", "warn");
      return;
    }
    if (!Number.isFinite(knownDistancePixels) || knownDistancePixels <= 0) {
      pushToast("Known distance (pixels) must be greater than 0.", "warn");
      return;
    }

    setBackendSubmitting(true);
    try {
      let result;
      if (boundary?.geometry) {
        result = await measureGeoJson({
          geometry: boundary.geometry,
          measurementType,
          knownDistanceFt,
          knownDistancePixels,
        });
      } else {
        let imageFile = measurementImageFile;
        if (!imageFile) {
          const map = mapRef.current;
          if (!map) {
            pushToast("Load your KML boundary first or upload an image/PDF.", "warn");
            setBackendSubmitting(false);
            return;
          }
          setCapturingMapImage(true);
          const blob = await captureMapImageBlob(map);
          imageFile = new File([blob], "property-map-capture.png", { type: "image/png" });
        }

        result = await uploadMeasurement({
          imageFile,
          measurementType,
          knownDistanceFt,
          knownDistancePixels,
        });
      }
      setBackendMeasurementResult(result);
      if (boundary?.geometry) {
        applyMeasurementPolygonsToLayers(result, measurementType);
      }
      await refreshMeasurementHistory();
      pushToast("Measurement completed and saved to history.", "info");
    } catch (error) {
      pushToast(`Measurement failed: ${error.message}`, "error", 5000);
    } finally {
      setCapturingMapImage(false);
      setBackendSubmitting(false);
    }
  }, [
    aiEnabled,
    boundary,
    pdfConverting,
    knownDistanceFtInput,
    knownDistancePixelsInput,
    measurementImageFile,
    measurementType,
    applyMeasurementPolygonsToLayers,
    pushToast,
    refreshMeasurementHistory,
    workflowMode,
  ]);

  const runSegmentationMeasurement = useCallback(async (classKeys = LAYER_KEYS) => {
    if (!aiEnabled) {
      pushToast("AI features are disabled in review mode.", "warn");
      return;
    }
    if (workflowMode === WORKFLOW_MODE_PDF) {
      pushToast("PDF mode is manual-only. Switch to Measure Location for AI/CV.", "warn");
      return;
    }
    if (pdfConverting) {
      pushToast("PDF is still converting. Please wait.", "warn");
      return;
    }
    const requestedClassKeys = (Array.isArray(classKeys) && classKeys.length ? classKeys : LAYER_KEYS)
      .filter((k, idx, arr) => LAYER_KEYS.includes(k) && arr.indexOf(k) === idx);
    if (!requestedClassKeys.length) {
      pushToast("No valid segmentation class selected.", "warn");
      return;
    }
    const map = mapRef.current;
    if (!map) {
      pushToast("Map is not ready yet.", "warn");
      return;
    }

    setSegmentingImage(true);
    try {
      const boundaryFeature = boundary ? to2DFeature(boundary) : null;
      const usingBoundaryCapture = !!boundaryFeature;
      let imageFile = null;

      if (usingBoundaryCapture) {
        const blob = await captureMapImageBlob(map);
        imageFile = new File([blob], "kml-map-segmentation.png", { type: "image/png" });
      } else {
        imageFile = measurementImageFile;
        if (!imageFile) {
          pushToast("Upload an image/PDF or load a KML boundary first.", "warn");
          setSegmentingImage(false);
          return;
        }
      }

      const imageBitmap = await createImageBitmap(imageFile);
      const imageWidth = imageBitmap.width || 1;
      const imageHeight = imageBitmap.height || 1;
      imageBitmap.close?.();

      const result = await segmentMeasurementUpload({
        imageFile,
        useModel: true,
        minAreaPx: 10,
        boundaryGeojson: boundaryFeature?.geometry || null,
      });
      setSegmentationResult(result);

      const layerByClass = {
        plowable: "plowable",
        sidewalks: "sidewalks",
        turf: "turf",
        mulch: "mulch",
      };
      const isSegmentationFeature = (f) => {
        const source = String(f?.properties?.source || "").toLowerCase();
        const id = String(f?.id || "").toLowerCase();
        const name = String(f?.properties?.name || "").toLowerCase();
        return (
          source.includes("segmentation") ||
          id.startsWith("seg-") ||
          id.startsWith("cv-seg-") ||
          name.startsWith("seg ")
        );
      };
      const next = {
        plowable: [...(layerFeaturesRef.current.plowable || [])],
        sidewalks: [...(layerFeaturesRef.current.sidewalks || [])],
        turf: [...(layerFeaturesRef.current.turf || [])],
        mulch: [...(layerFeaturesRef.current.mulch || [])],
      };
      for (const key of requestedClassKeys) {
        next[key] = next[key].filter((f) => !isSegmentationFeature(f));
      }
      const existingLayerPolys = {
        plowable: (next.plowable || []).map((f) => to2DFeature(f)).filter((f) => isPolygonLike(f)),
        sidewalks: (next.sidewalks || []).map((f) => to2DFeature(f)).filter((f) => isPolygonLike(f)),
        turf: (next.turf || []).map((f) => to2DFeature(f)).filter((f) => isPolygonLike(f)),
        mulch: (next.mulch || []).map((f) => to2DFeature(f)).filter((f) => isPolygonLike(f)),
      };

      const safeIntersect = (a, b) => {
        if (!a || !b || !isPolygonLike(a) || !isPolygonLike(b)) return null;
        try {
          const out = turf.intersect(a, b);
          if (out && isPolygonLike(out)) return out;
        } catch {
          try {
            const out = turf.intersect(turf.featureCollection([a, b]));
            if (out && isPolygonLike(out)) return out;
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
        }
        return null;
      };

      const safeDifference = (a, b, { strict = false } = {}) => {
        if (!a || !isPolygonLike(a)) return null;
        if (!b || !isPolygonLike(b)) return a;
        try {
          const out = turf.difference(a, b);
          if (out && isPolygonLike(out)) return out;
        } catch {
          try {
            const out = turf.difference(turf.featureCollection([a, b]));
            if (out && isPolygonLike(out)) return out;
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
        }
        return strict ? null : a;
      };

      const mergeFeatures = (features) => {
        if (!features.length) return null;
        if (features.length === 1) return features[0];
        try {
          const combined = turf.combine(turf.featureCollection(features));
          return combined?.features?.[0] || features[0];
        } catch {
          return features[0];
        }
      };

      const toPolygonFeatures = (feature) => {
        if (!feature || !isPolygonLike(feature)) return [];
        if (feature.geometry.type === "Polygon") return [feature];
        if (feature.geometry.type !== "MultiPolygon") return [];
        const props = { ...(feature.properties || {}) };
        return (feature.geometry.coordinates || []).map((coords, idx) => ({
          type: "Feature",
          id: feature.id ? `${feature.id}-part-${idx + 1}` : undefined,
          properties: props,
          geometry: { type: "Polygon", coordinates: coords },
        }));
      };

      const enforceNoOverlapForSeg = (segByLayer, existingByLayer) => {
        const out = {
          plowable: [],
          sidewalks: [],
          turf: [],
          mulch: [],
        };
        const blockers = [];
        for (const key of LAYER_KEYS) {
          for (const f of existingByLayer[key] || []) {
            if (f && isPolygonLike(f)) blockers.push(f);
          }
        }
        const priority = ["sidewalks", "mulch", "turf", "plowable"];
        for (const layerKey of priority) {
          for (const raw of segByLayer[layerKey] || []) {
            let candidates = toPolygonFeatures(raw);
            if (!candidates.length) continue;

            // Keep candidates clipped to boundary before overlap subtraction.
            const clippedCandidates = [];
            for (const c of candidates) {
              const clipped = boundaryFeature ? safeIntersect(c, boundaryFeature) : c;
              if (!clipped || !isPolygonLike(clipped)) continue;
              clippedCandidates.push(...toPolygonFeatures(clipped));
            }
            candidates = clippedCandidates;
            if (!candidates.length) continue;

            for (const blocker of blockers) {
              const nextCandidates = [];
              for (const candidate of candidates) {
                const diff = safeDifference(candidate, blocker, { strict: true });
                if (!diff || !isPolygonLike(diff)) {
                  // Keep only when we can confidently prove no overlap.
                  let disjoint = false;
                  try {
                    disjoint = turf.booleanDisjoint(candidate, blocker);
                  } catch {
                    disjoint = false;
                  }
                  if (disjoint) nextCandidates.push(candidate);
                  continue;
                }
                nextCandidates.push(...toPolygonFeatures(diff));
              }
              candidates = nextCandidates;
              if (!candidates.length) break;
            }

            for (const candidate of candidates) {
              let areaSqm = 0;
              try {
                areaSqm = turf.area(candidate);
              } catch {
                areaSqm = 1;
              }
              if (Number.isFinite(areaSqm) && areaSqm < 0.6) continue;
              out[layerKey].push(candidate);
              blockers.push(candidate);
            }
          }
        }
        return out;
      };

      const canvas = map.getCanvas();
      const unprojectWidth = canvas.clientWidth || canvas.width || 1;
      const unprojectHeight = canvas.clientHeight || canvas.height || 1;
      const stamp = Date.now();
      let added = 0;
      const detectedByLayer = {
        plowable: [],
        sidewalks: [],
        turf: [],
        mulch: [],
      };
      const newSegByLayer = {
        plowable: [],
        sidewalks: [],
        turf: [],
        mulch: [],
      };

      for (const classKey of requestedClassKeys) {
        const targetLayer = layerByClass[classKey];
        const polys = result?.[classKey]?.polygons || [];
        for (let i = 0; i < polys.length; i += 1) {
          const ring = [];
          for (const pt of polys[i]) {
            const sx = (Number(pt.x) / imageWidth) * unprojectWidth;
            const sy = (Number(pt.y) / imageHeight) * unprojectHeight;
            const lngLat = map.unproject([sx, sy]);
            ring.push([lngLat.lng, lngLat.lat]);
          }
          if (ring.length < 3) continue;
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push([...first]);
          }
          const rawFeature = {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [ring] },
            properties: {},
          };
          const clipped = boundaryFeature ? safeIntersect(rawFeature, boundaryFeature) : rawFeature;
          if (!clipped || !isPolygonLike(clipped)) continue;
          detectedByLayer[targetLayer].push(clipped);
        }
      }

      let plowableGeom = mergeFeatures(detectedByLayer.plowable);
      let sidewalksGeom = mergeFeatures(detectedByLayer.sidewalks);
      let turfGeom = mergeFeatures(detectedByLayer.turf);
      let mulchGeom = mergeFeatures(detectedByLayer.mulch);

      // Remove buildings using basemap vector footprints when available.
      const buildingPolys = [];
      if (map.getSource("streets")) {
        let buildingFeatures = [];
        try {
          buildingFeatures = map.querySourceFeatures("streets", { sourceLayer: "building" }) || [];
        } catch {
          buildingFeatures = [];
        }
        const seen = new Set();
        for (const f of buildingFeatures) {
          if (!isPolygonLike(f)) continue;
          const key =
            `${f.id != null ? String(f.id) : ""}|` +
            JSON.stringify(f.geometry?.coordinates?.[0]?.[0] || []);
          if (seen.has(key)) continue;
          seen.add(key);
          const clipped = boundaryFeature
            ? safeIntersect(to2DFeature({
                type: "Feature",
                geometry: f.geometry,
                properties: f.properties || {},
              }), boundaryFeature)
            : to2DFeature({
                type: "Feature",
                geometry: f.geometry,
                properties: f.properties || {},
              });
          if (!clipped || !isPolygonLike(clipped)) continue;
          if (featureSqft(clipped) < 30) continue;
          buildingPolys.push(clipped);
        }
      }
      const buildingsGeom = mergeFeatures(buildingPolys);
      if (buildingsGeom) {
        plowableGeom = safeDifference(plowableGeom, buildingsGeom);
        sidewalksGeom = safeDifference(sidewalksGeom, buildingsGeom);
        turfGeom = safeDifference(turfGeom, buildingsGeom);
        mulchGeom = safeDifference(mulchGeom, buildingsGeom);
      }

      // Enforce no-overlap priority: sidewalks > mulch > turf > plowable
      if (sidewalksGeom) {
        mulchGeom = safeDifference(mulchGeom, sidewalksGeom);
        turfGeom = safeDifference(turfGeom, sidewalksGeom);
        plowableGeom = safeDifference(plowableGeom, sidewalksGeom);
      }
      if (mulchGeom) {
        turfGeom = safeDifference(turfGeom, mulchGeom);
        plowableGeom = safeDifference(plowableGeom, mulchGeom);
      }
      if (turfGeom) {
        plowableGeom = safeDifference(plowableGeom, turfGeom);
      }

      const pushGeometryToLayer = (layerKey, featureGeom) => {
        if (!featureGeom || !isPolygonLike(featureGeom)) return;
        const clippedRoot = boundaryFeature ? safeIntersect(featureGeom, boundaryFeature) : featureGeom;
        if (!clippedRoot || !isPolygonLike(clippedRoot)) return;
        const existingSameLayer = combinePolygonFeatures(existingLayerPolys[layerKey] || []);
        const nonOverlapping = existingSameLayer
          ? subtractFeatureAllowEmpty(clippedRoot, existingSameLayer)
          : clippedRoot;
        if (!nonOverlapping || !isPolygonLike(nonOverlapping)) return;
        const asPolygons =
          nonOverlapping.geometry.type === "Polygon"
            ? [nonOverlapping.geometry.coordinates]
            : nonOverlapping.geometry.coordinates;
        for (let i = 0; i < asPolygons.length; i += 1) {
          const geom = { type: "Polygon", coordinates: asPolygons[i] };
          const candidate = { type: "Feature", geometry: geom, properties: {} };
          const clipped = boundaryFeature ? safeIntersect(candidate, boundaryFeature) : candidate;
          if (!clipped || !isPolygonLike(clipped)) continue;
          const outside = boundaryFeature ? isOutsideBoundary(clipped, boundaryFeature) : false;
          const finalGeom = clipped.geometry;
          newSegByLayer[layerKey].push({
            type: "Feature",
            id: `seg-${layerKey}-${stamp}-${i + 1}`,
            properties: {
              name: `Seg ${LAYER_META[layerKey].name} ${i + 1}`,
              layer: layerKey,
              source: "segmentation",
              outside: !!outside,
            },
            geometry: finalGeom,
          });
          existingLayerPolys[layerKey].push({
            type: "Feature",
            geometry: finalGeom,
            properties: {},
          });
        }
      };

      if (requestedClassKeys.includes("plowable")) pushGeometryToLayer("plowable", plowableGeom);
      if (requestedClassKeys.includes("sidewalks")) pushGeometryToLayer("sidewalks", sidewalksGeom);
      if (requestedClassKeys.includes("turf")) pushGeometryToLayer("turf", turfGeom);
      if (requestedClassKeys.includes("mulch")) pushGeometryToLayer("mulch", mulchGeom);

      const resolvedSegByLayer = enforceNoOverlapForSeg(newSegByLayer, next);
      for (const key of LAYER_KEYS) {
        next[key].push(...(resolvedSegByLayer[key] || []));
      }
      added =
        (resolvedSegByLayer.plowable?.length || 0) +
        (resolvedSegByLayer.sidewalks?.length || 0) +
        (resolvedSegByLayer.turf?.length || 0) +
        (resolvedSegByLayer.mulch?.length || 0);

      if (!added) {
        pushToast("Segmentation finished but no polygons survived clipping/size filters.", "warn", 5000);
        return;
      }

      setLayerFeatures(next);
      setLayerVisible((prev) => {
        const nextVisible = { ...prev };
        for (const key of requestedClassKeys) nextVisible[key] = true;
        return nextVisible;
      });
      const nextActiveLayer = requestedClassKeys.includes("plowable")
        ? "plowable"
        : requestedClassKeys[0];
      setActiveLayer(nextActiveLayer);
      activeLayerRef.current = nextActiveLayer;
      try {
        const d = drawRef.current;
        if (d) {
          d.deleteAll();
          for (const key of LAYER_KEYS) {
            for (const f of next[key] || []) {
              d.add({
                ...f,
                properties: { ...(f.properties || {}), layer: key },
              });
            }
          }
        }
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      const classLabel = requestedClassKeys
        .map((k) => LAYER_META[k]?.name || k)
        .join(", ");
      pushToast(`Segmentation added ${added} polygons (${classLabel}).`, "info", 5000);
    } catch (error) {
      pushToast(`Segmentation failed: ${error.message}`, "error", 6000);
    } finally {
      setSegmentingImage(false);
    }
  }, [aiEnabled, boundary, measurementImageFile, pdfConverting, pushToast, workflowMode]);

  const ensureGoogleTileSession = useCallback(async (forceRefresh = false) => {
    if (!googleMapsKey) {
      throw new Error("Google Maps key is missing.");
    }
    const now = Date.now();
    if (
      !forceRefresh &&
      googleTileSessionRef.current &&
      now < googleTileSessionExpiryRef.current - 60_000
    ) {
      return googleTileSessionRef.current;
    }
    if (!forceRefresh && googleTileSessionPromiseRef.current) {
      return googleTileSessionPromiseRef.current;
    }

    const pending = (async () => {
      const endpoint =
        `https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(googleMapsKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mapType: "satellite",
          language: "en-US",
          region: "US",
        }),
      });
      if (!response.ok) {
        let detail = "";
        try {
          const body = await response.text();
          detail = String(body || "").slice(0, 220);
        } catch {
          detail = "";
        }
        throw new Error(
          `Google tiles session failed (${response.status})${detail ? `: ${detail}` : "."}`
        );
      }
      const data = await response.json();
      const session = String(data?.session || data?.sessionToken || "").trim();
      if (!session) {
        throw new Error("Google tiles session token was empty.");
      }
      const expiryMs = Date.parse(String(data?.expiry || ""));
      googleTileSessionRef.current = session;
      googleTileSessionExpiryRef.current =
        Number.isFinite(expiryMs) && expiryMs > now
          ? expiryMs
          : now + 90 * 60 * 1000;
      return session;
    })();

    googleTileSessionPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      if (googleTileSessionPromiseRef.current === pending) {
        googleTileSessionPromiseRef.current = null;
      }
    }
  }, [googleMapsKey]);

  const ensureGoogleBasemapLayer = useCallback(async (map, forceRefresh = false) => {
    if (!map || !map.isStyleLoaded?.() || !googleMapsKey) return false;
    const session = await ensureGoogleTileSession(forceRefresh);
    const tileUrl =
      `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}` +
      `?session=${encodeURIComponent(session)}` +
      `&key=${encodeURIComponent(googleMapsKey)}`;

    const existingSource = map.getSource("google_sat");
    if (!existingSource) {
      map.addSource("google_sat", {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
        maxzoom: 22,
        attribution: "© Google",
      });
    } else if (typeof existingSource.setTiles === "function") {
      existingSource.setTiles([tileUrl]);
    }

    if (!map.getLayer("bm-google")) {
      map.addLayer(
        {
          id: "bm-google",
          type: "raster",
          source: "google_sat",
          layout: { visibility: "none" },
        },
        map.getLayer("3d-buildings") ? "3d-buildings" : undefined
      );
    }
    return true;
  }, [ensureGoogleTileSession, googleMapsKey]);

  // Basemap layer visibility toggler
  const applyBaseMapVisibility = useCallback((map, which, azureLabelsOn) => {
    if (!map) return;
    if (!map.isStyleLoaded()) return;

    const safeSet = (id, on) => {
      if (!map.getLayer(id)) return;
      try {
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    };

    safeSet("bm-empty", which === "none");
    safeSet("bm-maptiler", which === "maptiler");
    safeSet("bm-mapbox", which === "mapbox");
    safeSet("bm-azure", which === "azure");
    safeSet("bm-azure-hybrid", which === "azure" && !!azureLabelsOn);
    safeSet("bm-google", which === "google");
    safeSet("3d-buildings", which !== "none");

    try {
      if (which === "azure") {
        map.setMaxZoom(19);
        if (map.getZoom() > 19) map.jumpTo({ zoom: 19 });
      } else {
        map.setMaxZoom(22);
      }
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  const applyPlanOverlayMode = useCallback((map, enabled, overlay, opacityInput) => {
    if (!map || !map.isStyleLoaded()) return;
    const opacity = Math.max(0.15, Math.min(1, Number(opacityInput) || 0.95));
    const hasOverlay = !!overlay?.url;
    const source = map.getSource(PLAN_OVERLAY_SOURCE_ID);

    if (!enabled || !hasOverlay) {
      if (map.getLayer(PLAN_OVERLAY_LAYER_ID)) {
        try {
          map.setLayoutProperty(PLAN_OVERLAY_LAYER_ID, "visibility", "none");
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
      }
      return;
    }

    const coords = Array.isArray(overlay?.coordinates) && overlay.coordinates.length === 4
      ? overlay.coordinates
      : mapBoundsToImageSourceCoordinates(map);
    if (!coords) return;

    try {
      if (!source) {
        map.addSource(PLAN_OVERLAY_SOURCE_ID, {
          type: "image",
          url: overlay.url,
          coordinates: coords,
        });
      } else if (typeof source.updateImage === "function") {
        source.updateImage({
          url: overlay.url,
          coordinates: coords,
        });
      }

      if (!map.getLayer(PLAN_OVERLAY_LAYER_ID)) {
        map.addLayer(
          {
            id: PLAN_OVERLAY_LAYER_ID,
            type: "raster",
            source: PLAN_OVERLAY_SOURCE_ID,
            paint: {
              "raster-opacity": opacity,
              "raster-resampling": "linear",
            },
          },
          map.getLayer("3d-buildings") ? "3d-buildings" : undefined
        );
      } else {
        map.setPaintProperty(PLAN_OVERLAY_LAYER_ID, "raster-opacity", opacity);
      }
      map.setLayoutProperty(PLAN_OVERLAY_LAYER_ID, "visibility", "visible");
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  const applyObject3dMode = useCallback((map, enabled, opacityInput) => {
    if (!map || !map.isStyleLoaded()) return;
    const opacity = Math.max(0.12, Math.min(0.9, Number(opacityInput) || DEFAULT_3D_OBJECT_OPACITY));
    const treeOpacity = Math.max(0.1, Math.min(0.72, opacity * 0.72));

    try {
      if (map.getSource("streets") && !map.getLayer("3d-trees")) {
        map.addLayer(
          {
            id: "3d-trees",
            type: "fill-extrusion",
            source: "streets",
            "source-layer": "landcover",
            minzoom: 13,
            filter: [
              "in",
              ["get", "class"],
              ["literal", ["forest", "wood", "park", "grass", "meadow", "scrub", "cemetery"]],
            ],
            paint: {
              "fill-extrusion-color": [
                "match",
                ["get", "class"],
                "forest",
                "#476f39",
                "wood",
                "#4f7b41",
                "park",
                "#659a53",
                "grass",
                "#84b967",
                "meadow",
                "#94c873",
                "scrub",
                "#6d8f54",
                "#6d8f54",
              ],
              "fill-extrusion-height": [
                "interpolate",
                ["linear"],
                ["zoom"],
                13,
                0,
                15,
                [
                  "match",
                  ["get", "class"],
                  "forest",
                  16,
                  "wood",
                  14,
                  "park",
                  7,
                  "grass",
                  3,
                  "meadow",
                  4,
                  "scrub",
                  6,
                  4,
                ],
                18,
                [
                  "match",
                  ["get", "class"],
                  "forest",
                  22,
                  "wood",
                  20,
                  "park",
                  10,
                  "grass",
                  4,
                  "meadow",
                  5,
                  "scrub",
                  8,
                  5,
                ],
              ],
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": treeOpacity,
            },
            layout: { visibility: "none" },
          },
          map.getLayer("3d-buildings") ? "3d-buildings" : undefined
        );
      }

      const visibility = enabled ? "visible" : "none";
      if (map.getLayer("3d-buildings")) {
        map.setLayoutProperty("3d-buildings", "visibility", visibility);
        map.setPaintProperty("3d-buildings", "fill-extrusion-opacity", opacity);
        map.setPaintProperty("3d-buildings", "fill-extrusion-color", "#d9e4ef");
      }
      if (map.getLayer("3d-trees")) {
        map.setLayoutProperty("3d-trees", "visibility", visibility);
        map.setPaintProperty("3d-trees", "fill-extrusion-opacity", treeOpacity);
      }
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  const applyTerrainMode = useCallback(
    (map, enabled, exaggeration) => {
      if (!map || !map.isStyleLoaded()) return;
      const ex = Math.max(0.6, Math.min(3.2, Number(exaggeration) || DEFAULT_TERRAIN_EXAGGERATION));
      const canTerrain = typeof map.setTerrain === "function";

      try {
        const ensureTerrainInfra = () => {
          if (!map.getSource("mt_terrain_dem")) {
            map.addSource("mt_terrain_dem", {
              type: "raster-dem",
              tiles: [
                `https://api.maptiler.com/tiles/terrain-rgb-v2/{z}/{x}/{y}.webp?key=${maptilerKey}`,
              ],
              tileSize: 256,
              maxzoom: 14,
              attribution: "© MapTiler terrain data",
            });
          }
          if (!map.getLayer("terrain-hillshade")) {
            map.addLayer(
              {
                id: "terrain-hillshade",
                type: "hillshade",
                source: "mt_terrain_dem",
                layout: { visibility: "none" },
                paint: {
                  "hillshade-exaggeration": 0.45,
                  "hillshade-highlight-color": "#9db2c4",
                  "hillshade-shadow-color": "#374554",
                  "hillshade-accent-color": "#5d7084",
                },
              },
              map.getLayer("3d-buildings") ? "3d-buildings" : undefined
            );
          }
          if (!map.getLayer("terrain-sky")) {
            map.addLayer({
              id: "terrain-sky",
              type: "sky",
              layout: { visibility: "none" },
              paint: {
                "sky-type": "atmosphere",
                "sky-atmosphere-sun-intensity": 12,
              },
            });
          }
        };

        if (enabled) {
          ensureTerrainInfra();
          const hasDem = !!map.getSource("mt_terrain_dem");
          if (!hasDem || !canTerrain) {
            throw new Error("terrain source unsupported");
          }
          map.setTerrain({ source: "mt_terrain_dem", exaggeration: ex });
          if (map.getLayer("terrain-hillshade")) {
            map.setLayoutProperty("terrain-hillshade", "visibility", "visible");
          }
          if (map.getLayer("terrain-sky")) {
            map.setLayoutProperty("terrain-sky", "visibility", "visible");
          }
          terrainWarnedRef.current = false;
          return;
        }

        if (canTerrain) map.setTerrain(null);
        if (map.getLayer("terrain-hillshade")) {
          map.setLayoutProperty("terrain-hillshade", "visibility", "none");
        }
        if (map.getLayer("terrain-sky")) {
          map.setLayoutProperty("terrain-sky", "visibility", "none");
        }
      } catch (error) {
        if (!terrainWarnedRef.current) {
          terrainWarnedRef.current = true;
          pushToast(
            `Terrain 3D unavailable here (${error?.message || "render error"}).`,
            "warn",
            5000
          );
        }
        try {
          if (canTerrain) map.setTerrain(null);
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
      }
    },
    [maptilerKey, pushToast]
  );

  // Always-visible outlines for ALL polygons (white halo + colored stroke)
  // Insert BELOW vertex layers so dots stay on top
  // Make outlines thinner while editing/drawing
  const refreshPolygonOutlines = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!map.isStyleLoaded()) return;

    const allFeatures = [];

    for (const k of LAYER_KEYS) {
      if (!layerVisible[k]) continue;

      for (const f of layerFeatures[k] || []) {
        const outside =
          boundary && isPolygonLike(f) ? isOutsideBoundary(f, boundary) : false;

        allFeatures.push({
          ...f,
          properties: {
            ...(f.properties || {}),
            layer: k,
            outside,
          },
        });
      }
    }

    const fc = { type: "FeatureCollection", features: allFeatures };

    const srcId = "polys-src";
    const fillId = "polys-fill";
    const haloId = "polys-outline-halo";
    const lineId = "polys-outline-line";

    const beforeId = getDrawVertexLayerId(map) || undefined;

    const haloW = isEditing ? 3 : 9;
    const lineW = isEditing ? 1.75 : 6;

    // Build match expression from LAYER_COLORS (keeps single source of truth)
    const lineMatch = ["match", ["get", "layer"]];
    for (const k of LAYER_KEYS) {
      lineMatch.push(k, LAYER_COLORS[k].line);
    }
    lineMatch.push("#ff00ff");

    const lineColorExpr = [
      "case",
      ["boolean", ["get", "outside"], false],
      "#ff0000",
      lineMatch,
    ];

    const fillMatch = ["match", ["get", "layer"]];
    for (const k of LAYER_KEYS) {
      fillMatch.push(k, LAYER_COLORS[k].fill);
    }
    fillMatch.push("#00ffff");

    const fillOpacity = isEditing ? 0.12 : 0.18;

    if (!map.getSource(srcId)) {
      map.addSource(srcId, { type: "geojson", data: fc });

      map.addLayer(
        {
          id: fillId,
          type: "fill",
          source: srcId,
          paint: {
            "fill-color": fillMatch,
            "fill-opacity": fillOpacity,
          },
        },
        beforeId
      );

      map.addLayer(
        {
          id: haloId,
          type: "line",
          source: srcId,
          paint: {
            "line-color": "#ffffff",
            "line-width": haloW,
            "line-opacity": 0.95,
          },
        },
        beforeId
      );

      map.addLayer(
        {
          id: lineId,
          type: "line",
          source: srcId,
          paint: {
            "line-color": lineColorExpr,
            "line-width": lineW,
            "line-opacity": 1,
          },
        },
        beforeId
      );
    } else {
      map.getSource(srcId).setData(fc);
      try {
        if (map.getLayer(fillId)) map.setPaintProperty(fillId, "fill-color", fillMatch);
        if (map.getLayer(fillId)) map.setPaintProperty(fillId, "fill-opacity", fillOpacity);
        if (map.getLayer(haloId)) map.setPaintProperty(haloId, "line-width", haloW);
        if (map.getLayer(lineId)) map.setPaintProperty(lineId, "line-width", lineW);
        if (map.getLayer(lineId)) map.setPaintProperty(lineId, "line-color", lineColorExpr);
      } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    }

    // Enforce ordering (Draw may reorder on mode changes)
    try {
      const drawBefore = getDrawVertexLayerId(map);
      if (drawBefore) {
        if (map.getLayer(fillId)) map.moveLayer(fillId, drawBefore);
        if (map.getLayer(haloId)) map.moveLayer(haloId, drawBefore);
        if (map.getLayer(lineId)) map.moveLayer(lineId, drawBefore);
      }
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, [
    boundary,
    isEditing,
    layerFeatures,
    layerVisible,
  ]);

  // rAF throttle outlines refresh
  const refreshPolygonOutlinesRaf = useRafThrottle(refreshPolygonOutlines);

  const ensureDrawBorderLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    try {
      const beforeId = getDrawVertexLayerId(map) || undefined;
      const width = isEditing ? 2 : 6;

      const drawLayerExpr = ["coalesce", ["get", "user_layer"], ["get", "layer"]];
      const drawOutsideExpr = ["coalesce", ["get", "user_outside"], ["get", "outside"]];

      const lineMatch = ["match", drawLayerExpr];
      for (const k of LAYER_KEYS) {
        lineMatch.push(k, LAYER_COLORS[k].line);
      }
      lineMatch.push("#ffffff");

      const lineColorExpr = [
        "case",
        ["boolean", drawOutsideExpr, false],
        "#ff0000",
        lineMatch,
      ];

      const ensureOne = (id, source) => {
        if (!map.getSource(source)) return;

        if (!map.getLayer(id)) {
          map.addLayer(
            {
              id,
              type: "line",
              source,
              filter: ["==", "$type", "Polygon"],
              layout: {
                "line-cap": "round",
                "line-join": "round",
              },
              paint: {
                "line-color": lineColorExpr,
                "line-width": width,
                "line-opacity": 1,
              },
            },
            beforeId
          );
        } else {
          map.setPaintProperty(id, "line-color", lineColorExpr);
          map.setPaintProperty(id, "line-width", width);
          map.setPaintProperty(id, "line-opacity", 1);
          if (beforeId) map.moveLayer(id, beforeId);
        }
      };

      ensureOne("draw-border-cold", "mapbox-gl-draw-cold");
      ensureOne("draw-border-hot", "mapbox-gl-draw-hot");
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, [isEditing]);

  const refreshDrawStrokeWidths = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    try {
      const polygonStrokeW = isEditing ? 1.5 : 2;
      const polygonFillOpacity = 0;
      setDrawPaintByIdPrefix(
        map,
        "gl-draw-lines",
        "line-width",
        polygonStrokeW
      );
      setDrawPaintByIdPrefix(
        map,
        "gl-draw-lines",
        "line-opacity",
        0.2
      );
      setDrawPaintByIdPrefix(
        map,
        "gl-draw-lines",
        "line-dasharray",
        ["literal", [1, 0]]
      );
      setDrawPaintByIdPrefix(
        map,
        "gl-draw-polygon-fill",
        "fill-opacity",
        polygonFillOpacity
      );
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, [isEditing]);

  const getSnapTransportLines = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("streets")) return [];
    let raw = [];
    try {
      raw = map.querySourceFeatures("streets", { sourceLayer: "transportation" }) || [];
    } catch {
      raw = [];
    }

    const roadLikeClasses = new Set([
      "motorway",
      "trunk",
      "primary",
      "secondary",
      "tertiary",
      "residential",
      "service",
      "unclassified",
      "road",
      "living_street",
      "track",
      "path",
      "footway",
      "pedestrian",
      "sidewalk",
    ]);
    const seen = new Set();
    const lines = [];
    for (const feature of raw) {
      const type = feature?.geometry?.type;
      if (type !== "LineString" && type !== "MultiLineString") continue;
      const cls = String(
        feature?.properties?.class || feature?.properties?.subclass || feature?.properties?.type || ""
      ).toLowerCase();
      if (cls && !roadLikeClasses.has(cls)) continue;
      const key =
        `${feature?.id != null ? String(feature.id) : ""}|` +
        JSON.stringify(feature?.geometry?.coordinates?.[0] || []);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(
        to2DFeature({
          type: "Feature",
          properties: feature?.properties || {},
          geometry: feature.geometry,
        })
      );
    }
    return lines;
  }, []);

  const snapPolygonFeatureToEdges = useCallback(
    (feature) => {
      if (!snapToEdgesRef.current || !isPolygonLike(feature)) return feature;
      const transportLines = getSnapTransportLines();
      if (!transportLines.length) return feature;

      const snapLimitM = Math.max(0.25, Number(snapDistanceRef.current) || DEFAULT_SNAP_DISTANCE_M);
      const snapCoordinate = (coord) => {
        if (!Array.isArray(coord) || coord.length < 2) return coord;
        const point = turf.point([Number(coord[0]), Number(coord[1])]);
        let bestDist = Number.POSITIVE_INFINITY;
        let bestCoord = null;
        for (const line of transportLines) {
          try {
            const dist = turf.pointToLineDistance(point, line, { units: "meters" });
            if (!Number.isFinite(dist) || dist > snapLimitM || dist >= bestDist) continue;
            const nearest = turf.nearestPointOnLine(line, point, { units: "meters" });
            const snappedCoord = nearest?.geometry?.coordinates;
            if (!Array.isArray(snappedCoord) || snappedCoord.length < 2) continue;
            bestDist = dist;
            bestCoord = [Number(snappedCoord[0]), Number(snappedCoord[1])];
          } catch {
            /* ignore per-segment snap failures */
          }
        }
        return bestCoord || coord;
      };

      const snapRing = (ring) => {
        if (!Array.isArray(ring) || ring.length < 3) return ring;
        const openRing = [...ring];
        const first = openRing[0];
        const last = openRing[openRing.length - 1];
        if (Array.isArray(first) && Array.isArray(last) && first[0] === last[0] && first[1] === last[1]) {
          openRing.pop();
        }
        const snapped = openRing.map((coord) => snapCoordinate(coord));
        if (snapped.length >= 3) snapped.push([...snapped[0]]);
        return snapped;
      };

      const geom = feature.geometry;
      if (!geom) return feature;
      if (geom.type === "Polygon") {
        return {
          ...feature,
          geometry: {
            ...geom,
            coordinates: (geom.coordinates || []).map((ring) => snapRing(ring)),
          },
        };
      }
      if (geom.type === "MultiPolygon") {
        return {
          ...feature,
          geometry: {
            ...geom,
            coordinates: (geom.coordinates || []).map((poly) =>
              (poly || []).map((ring) => snapRing(ring))
            ),
          },
        };
      }
      return feature;
    },
    [getSnapTransportLines]
  );

  // Sync from Draw -> React state (active layer only)
  const syncFromDraw = useCallback(
    (draw, forcedLayerKey = null) => {
      const fallbackLayer = forcedLayerKey || activeLayerRef.current;
      const fc = draw.getAll();
      const incoming = fc.features || [];

      setLayerFeatures((prev) => {
        const next = {
          plowable: [...(prev.plowable || [])],
          sidewalks: [...(prev.sidewalks || [])],
          turf: [...(prev.turf || [])],
          mulch: [...(prev.mulch || [])],
        };

        const prevAllById = new Map();
        for (const k of LAYER_KEYS) {
          for (const f of prev[k] || []) {
            prevAllById.set(f.id, { layer: k, feature: f });
          }
        }

        const nextCounters = { ...nameCountersRef.current };
        let anyWarned = false;

        const normalizeIncoming = (f, layerKey) => {
          const snapped = snapPolygonFeatureToEdges(f);
          const old = prevAllById.get(f.id)?.feature;

          // only autogenerate if missing in both new+old
          let name = f.properties?.name || old?.properties?.name || "";
          if (!name) {
            nextCounters[layerKey] = (nextCounters[layerKey] || 0) + 1;
            name = `${LAYER_META[layerKey].name} ${nextCounters[layerKey]}`;
          }

          const outside =
            boundary && isPolygonLike(snapped) ? isOutsideBoundary(snapped, boundary) : false;

          // warn-once per feature id (non-blocking)
          if (warnOutsideBoundary && outside && f.id && !warnedOutsideRef.current.has(f.id)) {
            warnedOutsideRef.current.add(f.id);
            anyWarned = true;
          }

          // Keep Draw feature props in sync
          try {
            if (f.id) {
              draw.setFeatureProperty(f.id, "layer", layerKey);
              draw.setFeatureProperty(f.id, "name", name);
              draw.setFeatureProperty(f.id, "outside", outside);
            }
          } catch {
      /* intentionally ignore non-critical map/draw errors */
    }

          return {
            ...snapped,
            properties: {
              ...(snapped.properties || {}),
              ...(old?.properties || {}),
              name,
              layer: layerKey,
              outside,
            },
          };
        };

        const mergedById = new Map();
        for (const f of incoming) {
          const oldLoc = prevAllById.get(f.id);
          const layerKey =
            (f.properties?.layer && LAYER_KEYS.includes(f.properties.layer)
              ? f.properties.layer
              : (oldLoc?.layer || fallbackLayer));
          mergedById.set(f.id, { layerKey, feature: normalizeIncoming(f, layerKey) });
        }

        // Upsert incoming features into their target layer.
        for (const [id, payload] of mergedById.entries()) {
          const { layerKey, feature } = payload;
          const oldLoc = prevAllById.get(id);

          if (oldLoc && oldLoc.layer !== layerKey) {
            next[oldLoc.layer] = next[oldLoc.layer].filter((x) => x.id !== id);
          }

          const idx = next[layerKey].findIndex((x) => x.id === id);
          if (idx >= 0) next[layerKey][idx] = feature;
          else next[layerKey].push(feature);
        }

        nameCountersRef.current = nextCounters;

        if (anyWarned) {
          pushToast(
            "One or more polygons extend outside the boundary (red outline).",
            "warn",
            5000
          );
        }

        return next;
      });
    },
    [boundary, pushToast, snapPolygonFeatureToEdges, warnOutsideBoundary]
  );

  // Rename feature (active layer)
  const renameFeature = useCallback((featureId, newName) => {
    const layerKey = activeLayerRef.current;

    setLayerFeatures((prev) => {
      const updated = (prev[layerKey] || []).map((f) =>
        f.id === featureId
          ? { ...f, properties: { ...(f.properties || {}), name: newName } }
          : f
      );
      return { ...prev, [layerKey]: updated };
    });

    const d = drawRef.current;
    if (d) {
      try {
        d.setFeatureProperty(featureId, "name", newName);
      } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    }
  }, []);

  // Zoom to feature
  const zoomToFeature = useCallback((feature) => {
    const map = mapRef.current;
    if (!map) return;
    const bbox = turf.bbox(feature);
    map.fitBounds(bbox, { padding: 60, duration: 500 });
  }, []);

  const fitMapToProject = useCallback((nextBoundary, nextLayers) => {
    const map = mapRef.current;
    if (!map) return;

    try {
      if (nextBoundary && isPolygonLike(nextBoundary)) {
        map.fitBounds(turf.bbox(nextBoundary), { padding: 50, duration: 650 });
        return;
      }

      const features = [];
      for (const k of LAYER_KEYS) {
        for (const f of nextLayers?.[k] || []) {
          if (isPolygonLike(f)) features.push(f);
        }
      }
      if (!features.length) return;

      map.fitBounds(turf.bbox(turf.featureCollection(features)), {
        padding: 50,
        duration: 650,
      });
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  // Delete feature (active layer)
  const deleteFeature = useCallback((featureId) => {
    const layerKey = activeLayerRef.current;
    const d = drawRef.current;
    if (d) d.delete(featureId);

    setLayerFeatures((prev) => {
      const updated = (prev[layerKey] || []).filter((f) => f.id !== featureId);
      return { ...prev, [layerKey]: updated };
    });
  }, []);

  const switchActiveLayer = useCallback(
    (nextLayer) => {
      if (!nextLayer || nextLayer === activeLayerRef.current) return;

      requestAnimationFrame(() => {
        setActiveLayer(nextLayer);
      });
    },
    []
  );

  const cycleActiveLayer = useCallback(() => {
    const idx = LAYER_KEYS.indexOf(activeLayerRef.current);
    const next = LAYER_KEYS[(idx + 1) % LAYER_KEYS.length];
    switchActiveLayer(next);
  }, [switchActiveLayer]);

  const switchToPanMode = useCallback(() => {
    const draw = drawRef.current;
    drawingBoundaryRef.current = false;
    turfEraseModeRef.current = false;
    setDrawingBoundary(false);
    setTurfEraseMode(false);
    if (!draw) return;
    try {
      draw.changeMode("simple_select");
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  const switchToDrawMode = useCallback(() => {
    const draw = drawRef.current;
    drawingBoundaryRef.current = false;
    turfEraseModeRef.current = false;
    setDrawingBoundary(false);
    setTurfEraseMode(false);
    if (!draw) return;
    try {
      draw.changeMode("draw_polygon");
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  const deleteSelectedFeatures = useCallback(() => {
    const d = drawRef.current;
    if (!d) return;
    const selectedIds = d.getSelectedIds?.() || [];
    if (!selectedIds.length) return;

    try {
      for (const id of selectedIds) d.delete(id);
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }

    setLayerFeatures((prev) => {
      const ids = new Set(selectedIds);
      return {
        plowable: (prev.plowable || []).filter((f) => !ids.has(f.id)),
        sidewalks: (prev.sidewalks || []).filter((f) => !ids.has(f.id)),
        turf: (prev.turf || []).filter((f) => !ids.has(f.id)),
        mulch: (prev.mulch || []).filter((f) => !ids.has(f.id)),
      };
    });

    pushToast(`Deleted ${selectedIds.length} selected polygon(s).`, "info", 2500);
  }, [pushToast]);

  // Clip everything to boundary (forces Draw refresh)
  const clipAllPolygonsToBoundary = useCallback(() => {
    if (!boundary) {
      pushToast("Load a property boundary first.", "warn");
      return;
    }

    askConfirm({
      title: "Clip all polygons to boundary",
      message:
        "This will trim polygons to the boundary and may remove shapes that fall entirely outside. Continue?",
      confirmText: "Clip",
      cancelText: "Cancel",
      danger: true,
      onConfirm: () => {
        const activeKey = activeLayerRef.current;
        const draw = drawRef.current;

        setLayerFeatures((prev) => {
          const next = { ...prev };

          let changedCount = 0;
          let removedCount = 0;

          for (const layerKey of LAYER_KEYS) {
            const arr = prev[layerKey] || [];
            const out = [];

            for (const f of arr) {
              const isPoly = isPolygonLike(f);
              if (!isPoly) {
                out.push(f);
                continue;
              }

              let inter = null;

              // Try both Turf intersect signatures (depends on Turf version)
              try {
                inter = turf.intersect(f, boundary);
              } catch {
                try {
                  inter = turf.intersect(turf.featureCollection([f, boundary]));
                } catch {
                  inter = null;
                }
              }

              if (!inter) {
                removedCount += 1;
                continue;
              }

              out.push({
                ...inter,
                id: f.id,
                properties: { ...(f.properties || {}), ...(inter.properties || {}) },
              });

              try {
                const before = turf.area(f);
                const after = turf.area(inter);
                if (Math.abs(before - after) > 0.05) changedCount += 1;
              } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
            }

            next[layerKey] = out;
          }

          // Refresh Draw immediately (no setTimeout hacks) via direct call
          try {
            if (draw) {
              draw.deleteAll();
              for (const feat of next[activeKey] || []) {
                try {
                  draw.add(feat);
                } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
              }
            }
          } catch {
      /* intentionally ignore non-critical map/draw errors */
    }

          pushToast(
            `Clip complete. Changed: ${changedCount} • Removed: ${removedCount}`,
            "info",
            5000
          );

          return next;
        });

        setConfirm(null);
      },
    });
  }, [askConfirm, boundary, pushToast]);

  const buildLayerSnapshot = useCallback(() => {
    const snapshot = {
      plowable: [...(layerFeaturesRef.current.plowable || [])],
      sidewalks: [...(layerFeaturesRef.current.sidewalks || [])],
      turf: [...(layerFeaturesRef.current.turf || [])],
      mulch: [...(layerFeaturesRef.current.mulch || [])],
    };

    // Capture latest Draw state at save-time so just-drawn polygons are persisted.
    const d = drawRef.current;
    if (d && !suppressDrawSyncRef.current) {
      try {
        const incoming = d.getAll()?.features || [];
        const prevAllById = new Map();
        for (const k of LAYER_KEYS) {
          for (const f of snapshot[k] || []) {
            prevAllById.set(f.id, { layer: k, feature: f });
          }
        }

        for (const f of incoming) {
          const oldLoc = prevAllById.get(f.id);
          const layerKey =
            (f.properties?.layer && LAYER_KEYS.includes(f.properties.layer)
              ? f.properties.layer
              : (oldLoc?.layer || activeLayerRef.current));

          const merged = {
            ...f,
            properties: {
              ...(oldLoc?.feature?.properties || {}),
              ...(f.properties || {}),
              layer: layerKey,
            },
          };

          if (oldLoc && oldLoc.layer !== layerKey) {
            snapshot[oldLoc.layer] = snapshot[oldLoc.layer].filter((x) => x.id !== f.id);
          }

          const idx = snapshot[layerKey].findIndex((x) => x.id === f.id);
          if (idx >= 0) snapshot[layerKey][idx] = merged;
          else snapshot[layerKey].push(merged);
        }
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    }
    return snapshot;
  }, []);

  const buildProjectPayload = useCallback(() => {
    const snapshot = buildLayerSnapshot();
    return {
      version: PROJECT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      projectName: (projectName || "").trim(),
      boundary,
      layerFeatures: snapshot,
      activeLayer,
      layerVisible,
      lockNonActiveLayers,
      maskOutsideBoundary,
      warnOutsideBoundary,
      baseMap,
      azureHybridLabels,
      review3d,
      terrain3d,
      terrainExaggeration,
      objects3d: ENABLE_OBJECTS_3D ? objects3d : false,
      objects3dOpacity,
      workflowMode,
      pdfAnnotations: (pdfAnnotationsRef.current || []).map((feature, idx) =>
        normalizePdfAnnotationFeature(feature, idx)
      ).filter(Boolean),
      pdfAnnotationColor: normalizeHexColor(pdfAnnotationColor, PDF_ANNOT_DEFAULT_COLOR),
      pdfAnnotationWidth: Number(pdfAnnotationWidthRef.current || 4),
      pdfAnnotationTextDraft: String(pdfAnnotationTextDraft || ""),
      nameCounters: nameCountersRef.current,
    };
  }, [
    activeLayer,
    azureHybridLabels,
    baseMap,
    boundary,
    buildLayerSnapshot,
    layerVisible,
    lockNonActiveLayers,
    maskOutsideBoundary,
    projectName,
    review3d,
    terrain3d,
    terrainExaggeration,
    objects3d,
    objects3dOpacity,
    workflowMode,
    pdfAnnotationColor,
    pdfAnnotationTextDraft,
    warnOutsideBoundary,
  ]);

  const currentProjectLibraryId = useMemo(
    () => buildProjectLibraryId(projectName || "Untitled Project"),
    [projectName]
  );

  const markProjectSavedBaseline = useCallback((payload, savedAtOverride = "") => {
    const signature = buildProjectPayloadSignature(payload);
    if (signature) {
      setSavedProjectSignature(signature);
    }
    const ts = String(savedAtOverride || payload?.savedAt || new Date().toISOString()).trim();
    if (ts) {
      setLastManualSaveAt(ts);
    }
  }, []);

  const appendProjectVersionSnapshot = useCallback(
    (projectId, payload, { source = "local", savedBy = "" } = {}) => {
      const targetId = String(projectId || "").trim();
      if (!targetId || !isValidProjectPayload(payload)) return;
      const savedAt = String(payload?.savedAt || new Date().toISOString()).trim();
      const signature = buildProjectPayloadSignature(payload);
      const nextVersion = {
        id: `${savedAt}-${Math.random().toString(36).slice(2, 8)}`,
        savedAt,
        source: String(source || "local").trim() || "local",
        savedBy: String(savedBy || "").trim(),
        polygonCount: countProjectPayloadPolygons(payload),
        hasBoundary: !!payload?.boundary,
        signature,
        payload,
      };
      setProjectVersionHistory((prev) => {
        const prevMap = prev && typeof prev === "object" ? prev : {};
        const existing = Array.isArray(prevMap[targetId]) ? prevMap[targetId] : [];
        if (existing.length && existing[0]?.signature && existing[0].signature === signature) {
          return prevMap;
        }
        return {
          ...prevMap,
          [targetId]: [nextVersion, ...existing].slice(0, PROJECT_VERSION_HISTORY_MAX_PER_PROJECT),
        };
      });
    },
    []
  );

  // Save/load project
  const saveProject = useCallback(async ({ downloadFile = true, forceOverwrite = false } = {}) => {
    setSaveInProgress(true);
    const payload = buildProjectPayload();
    const localEntry = buildProjectLibraryEntryFromPayload(payload);
    const projectIdForHistory = String(localEntry?.id || currentProjectLibraryId || "").trim();
    const baseLastEditedAt =
      activeSharedProjectMetaRef.current?.id &&
      activeSharedProjectMetaRef.current?.id === localEntry?.id
        ? String(activeSharedProjectMetaRef.current?.lastEditedAt || "").trim()
        : String(
            (projectLibrary || []).find((entry) => entry?.id === localEntry?.id)?.lastEditedAt ||
              ""
          ).trim();

    setLayerFeatures(payload.layerFeatures);
    setProjectLibrary((prev) => upsertProjectLibraryEntries(prev, payload));
    if (projectIdForHistory) {
      appendProjectVersionSnapshot(projectIdForHistory, payload, {
        source: "local",
        savedBy: String(sharedAuth?.username || "").trim(),
      });
    }
    markProjectSavedBaseline(payload, payload.savedAt);
    setRemoteSharedUpdateNotice(null);

    if (downloadFile) {
      const fname = `${safeFilename(payload.projectName)}.json`;
      downloadJson(fname, payload);
    }
    if (!sharedAccessAuthenticated) {
      pushToast(
        downloadFile
          ? "Project saved (JSON). Log in on Home to sync this project to shared files."
          : "Project saved locally in this browser. Log in on Home to sync to shared files.",
        "info",
        5200
      );
      setSaveInProgress(false);
      return;
    }
    try {
      if (localEntry?.id) {
        const sharedSummary = await saveSharedProject({
          id: localEntry.id,
          projectName: localEntry.projectName,
          savedAt: localEntry.savedAt,
          polygonCount: localEntry.polygonCount,
          hasBoundary: localEntry.hasBoundary,
          baseLastEditedAt,
          forceOverwrite,
          payload,
        });
        const sharedSavedAt = String(
          sharedSummary?.last_edited_at || sharedSummary?.saved_at || payload.savedAt || ""
        ).trim();
        setSharedProjectQueue((prev) =>
          (Array.isArray(prev) ? prev : []).filter(
            (op) => String(op?.id) !== String(localEntry.id)
          )
        );
        setSharedProjectLibraryStatus("connected");
        setActiveSharedProjectMeta({
          id: String(sharedSummary?.id || localEntry.id || "").trim(),
          lastEditedAt: sharedSavedAt,
          savedBy: String(
            sharedSummary?.saved_by || sharedSummary?.savedBy || sharedAuth?.username || ""
          ).trim(),
        });
        if (sharedSavedAt) {
          markProjectSavedBaseline(
            {
              ...payload,
              savedAt: sharedSavedAt,
            },
            sharedSavedAt
          );
        }
        if (projectIdForHistory) {
          appendProjectVersionSnapshot(
            projectIdForHistory,
            {
              ...payload,
              savedAt: sharedSavedAt || payload.savedAt,
            },
            {
              source: "shared",
              savedBy: String(
                sharedSummary?.saved_by || sharedSummary?.savedBy || sharedAuth?.username || ""
              ).trim(),
            }
          );
        }
        refreshSharedProjectLibrary({ quiet: true });
        pushToast(
          forceOverwrite
            ? "Shared conflict resolved: your version overwrote the remote project."
            : downloadFile
            ? "Project saved (JSON) and synced to shared Home projects."
            : "Project synced to shared Home projects (no JSON download).",
          "info",
          4600
        );
        setSaveInProgress(false);
        return;
      }
    } catch (error) {
      const conflict =
        Number(error?.status) === 409
          ? error?.payload?.detail?.conflict || error?.payload?.conflict || null
          : null;
      if (conflict && localEntry?.id && !forceOverwrite) {
        const who = String(conflict?.saved_by || conflict?.savedBy || "another user").trim();
        const when = String(conflict?.last_edited_at || conflict?.lastEditedAt || "").trim();
        if (when) {
          setRemoteSharedUpdateNotice({
            id: String(conflict?.id || localEntry.id || "").trim(),
            savedBy: who,
            lastEditedAt: when,
          });
        }
        askConfirm({
          title: "Shared Save Conflict",
          message: `${localEntry.projectName || "This project"} was updated by ${who || "another user"} at ${
            when ? new Date(when).toLocaleString() : "an unknown time"
          }. Overwrite shared version with your local edits?`,
          confirmText: "Overwrite Shared",
          cancelText: "Keep Local",
          danger: true,
          onConfirm: async () => {
            setConfirm(null);
            await saveProject({ downloadFile: false, forceOverwrite: true });
          },
        });
        pushToast("Shared conflict detected. Review and choose overwrite if needed.", "warn", 6500);
        setSaveInProgress(false);
        return;
      }

      if (isAuthError(error)) {
        setSharedAuth((prev) => ({
          token: "",
          username: String(prev?.username || sharedLoginUsername || "admin").trim() || "admin",
          expiresAt: "",
        }));
        setSharedProjectLibraryStatus("locked");
      } else {
        setSharedProjectLibraryStatus("offline");
      }
      if (localEntry?.id) {
        setSharedProjectQueue((prev) =>
          upsertSharedQueueOperation(prev, {
            op: "upsert",
            id: localEntry.id,
            projectName: localEntry.projectName,
            savedAt: localEntry.savedAt,
            polygonCount: localEntry.polygonCount,
            hasBoundary: localEntry.hasBoundary,
            payload,
          })
        );
      }
      pushToast(
        `${downloadFile ? "Project saved locally" : "Project saved locally in browser"} and queued for sync: ${error?.message || "backend unavailable"}.`,
        "warn",
        6200
      );
      setSaveInProgress(false);
      return;
    }
    pushToast(
      downloadFile
        ? "Project saved (JSON) and added to Home recent projects."
        : "Project saved in browser and added to Home recent projects.",
      "info"
    );
    setSaveInProgress(false);
  }, [
    appendProjectVersionSnapshot,
    askConfirm,
    buildProjectPayload,
    currentProjectLibraryId,
    markProjectSavedBaseline,
    projectLibrary,
    pushToast,
    refreshSharedProjectLibrary,
    sharedAccessAuthenticated,
    sharedAuth?.username,
    sharedLoginUsername,
  ]);

  const normalizeFeature = useCallback((layerKey, f) => {
    // ensure properties exist and carry correct layer + outside
    const props = { ...(f.properties || {}) };
    props.layer = layerKey;

    if (!props.name) {
      const nextCounters = { ...nameCountersRef.current };
      nextCounters[layerKey] = (nextCounters[layerKey] || 0) + 1;
      nameCountersRef.current = nextCounters;
      props.name = `${LAYER_META[layerKey].name} ${nextCounters[layerKey]}`;
    }

    const outside =
      boundary && isPolygonLike(f) ? isOutsideBoundary(f, boundary) : false;
    props.outside = outside;

    return { ...f, properties: props };
  }, [boundary]);

  const applyProjectPayload = useCallback(
    (
      data,
      {
        fallbackProjectName = "",
        successToast = "Project loaded.",
        switchToWorkspace = true,
        markAutosaveAvailable = false,
        storeInLibrary = true,
        sharedMeta = null,
      } = {}
    ) => {
      if (!isValidProjectPayload(data)) {
        throw new Error("Invalid project schema");
      }

      const resolvedProjectName =
        String(data.projectName || fallbackProjectName || "").trim() || "Untitled Project";
      const resolvedWorkflowMode =
        data.workflowMode === WORKFLOW_MODE_PDF
          ? WORKFLOW_MODE_PDF
          : WORKFLOW_MODE_LOCATION;
      const loadedPdfAnnotations = Array.isArray(data.pdfAnnotations)
        ? data.pdfAnnotations
            .map((feature, idx) => normalizePdfAnnotationFeature(feature, idx))
            .filter(Boolean)
        : [];
      setProjectName(resolvedProjectName);
      setWorkflowMode(resolvedWorkflowMode);
      setPdfAnnotations(loadedPdfAnnotations);
      setPdfAnnotationColor(
        normalizeHexColor(data.pdfAnnotationColor, PDF_ANNOT_DEFAULT_COLOR)
      );
      setPdfAnnotationWidth(
        Number.isFinite(Number(data.pdfAnnotationWidth))
          ? Math.max(1, Math.min(30, Number(data.pdfAnnotationWidth)))
          : 4
      );
      setPdfAnnotationTextDraft(
        typeof data.pdfAnnotationTextDraft === "string"
          ? data.pdfAnnotationTextDraft
          : "Note"
      );
      setBoundary(to2DFeature(data.boundary || null));

      if (data.nameCounters && typeof data.nameCounters === "object") {
        nameCountersRef.current = {
          ...nameCountersRef.current,
          ...data.nameCounters,
        };
      }

      const incomingLayers =
        data.layerFeatures || {
          plowable: [],
          sidewalks: [],
          turf: [],
          mulch: [],
        };
      const normalized = {};
      for (const k of LAYER_KEYS) {
        normalized[k] = (incomingLayers[k] || []).map((f) => normalizeFeature(k, f));
      }

      setLayerFeatures(normalized);
      setActiveLayer(data.activeLayer || "plowable");
      setLayerVisible(normalizeLayerVisibility(data.layerVisible));
      if (typeof data.lockNonActiveLayers === "boolean")
        setLockNonActiveLayers(data.lockNonActiveLayers);
      if (typeof data.maskOutsideBoundary === "boolean")
        setMaskOutsideBoundary(data.maskOutsideBoundary);
      if (typeof data.warnOutsideBoundary === "boolean")
        setWarnOutsideBoundary(data.warnOutsideBoundary);

      if (data.baseMap) {
        const nextBaseMap = resolveBaseMapChoice(
          data.baseMap,
          !!mapboxToken,
          !!azureMapsKey,
          !!googleMapsKey
        );
        setBaseMap(nextBaseMap);
        if (nextBaseMap !== data.baseMap) {
          pushToast(
            `Saved basemap "${data.baseMap}" is unavailable. Switched to "${nextBaseMap}".`,
            "warn",
            5000
          );
        }
      }
      if (typeof data.azureHybridLabels === "boolean")
        setAzureHybridLabels(data.azureHybridLabels);
      if (typeof data.review3d === "boolean") setReview3d(data.review3d);
      if (ENABLE_TRUE_TERRAIN && typeof data.terrain3d === "boolean") {
        setTerrain3d(data.terrain3d);
      } else {
        setTerrain3d(false);
      }
      if (ENABLE_TRUE_TERRAIN && Number.isFinite(Number(data.terrainExaggeration))) {
        setTerrainExaggeration(
          Math.max(0.6, Math.min(3.2, Number(data.terrainExaggeration)))
        );
      } else {
        setTerrainExaggeration(DEFAULT_TERRAIN_EXAGGERATION);
      }
      if (ENABLE_OBJECTS_3D && typeof data.objects3d === "boolean") {
        setObjects3d(data.objects3d);
      } else {
        setObjects3d(false);
      }
      if (ENABLE_OBJECTS_3D && Number.isFinite(Number(data.objects3dOpacity))) {
        setObjects3dOpacity(
          Math.max(0.12, Math.min(0.9, Number(data.objects3dOpacity)))
        );
      } else {
        setObjects3dOpacity(DEFAULT_3D_OBJECT_OPACITY);
      }

      warnedOutsideRef.current = new Set();
      const nextActive = data.activeLayer || "plowable";
      activeLayerRef.current = nextActive;
      reloadDrawForActiveLayer(normalized, data.layerVisible || layerVisibleRef.current);
      requestAnimationFrame(() => {
        fitMapToProject(data.boundary || null, normalized);
      });
      setTimeout(() => {
        const map = mapRef.current;
        if (!map) return;
        if (map.isStyleLoaded()) {
          fitMapToProject(data.boundary || null, normalized);
          return;
        }
        pendingProjectFitRef.current = {
          boundary: data.boundary || null,
          layers: normalized,
        };
      }, 150);
      resetUndoRedoHistory(normalized);

      const payloadForLibrary = {
        ...data,
        projectName: resolvedProjectName,
        boundary: to2DFeature(data.boundary || null),
        layerFeatures: normalized,
        savedAt: String(data.savedAt || new Date().toISOString()),
      };
      if (storeInLibrary) {
        setProjectLibrary((prev) =>
          upsertProjectLibraryEntries(prev, payloadForLibrary, resolvedProjectName)
        );
      }

      const nextSharedMeta = {
        id: String(
          sharedMeta?.id || data?.id || buildProjectLibraryId(resolvedProjectName)
        ).trim(),
        lastEditedAt: String(
          sharedMeta?.lastEditedAt ||
            data?.lastEditedAt ||
            data?.last_edited_at ||
            payloadForLibrary.savedAt ||
            ""
        ).trim(),
        savedBy: String(
          sharedMeta?.savedBy || data?.savedBy || data?.saved_by || ""
        ).trim(),
      };
      setActiveSharedProjectMeta(nextSharedMeta);
      setRemoteSharedUpdateNotice(null);
      markProjectSavedBaseline(
        payloadForLibrary,
        nextSharedMeta.lastEditedAt || payloadForLibrary.savedAt
      );

      if (markAutosaveAvailable) setAutosaveDraftAvailable(true);
      if (switchToWorkspace) {
        setAppScreen(
          resolvedWorkflowMode === WORKFLOW_MODE_PDF
            ? APP_SCREEN_PDF
            : APP_SCREEN_LOCATION
        );
      }
      if (successToast) pushToast(successToast, "info");
    },
    [
      azureMapsKey,
      fitMapToProject,
      googleMapsKey,
      mapboxToken,
      normalizeFeature,
      pushToast,
      reloadDrawForActiveLayer,
      resetUndoRedoHistory,
      markProjectSavedBaseline,
    ]
  );

  const startNewProject = useCallback(
    (mode = WORKFLOW_MODE_LOCATION, announce = true) => {
      const normalizedMode =
        mode === WORKFLOW_MODE_PDF ? WORKFLOW_MODE_PDF : WORKFLOW_MODE_LOCATION;
      const empty = { plowable: [], sidewalks: [], turf: [], mulch: [] };
      setProjectName("");
      setWorkflowMode(normalizedMode);
      setBoundary(null);
      setLayerFeatures(empty);
      setActiveLayer("plowable");
      activeLayerRef.current = "plowable";
      warnedOutsideRef.current = new Set();
      setTrue3DSelectedFeatureId("");
      setMeasurePoints([]);
      setMeasureResult(null);
      setBackendMeasurementResult(null);
      setSegmentationResult(null);
      setPropertyLookupQuery("");
      setPropertyLookupSuggestions([]);
      setPropertyLookupSuggestOpen(false);
      setPropertyLookupSuggestIndex(-1);
      setPdfAnnotations([]);
      setPdfAnnotationTool("select");
      clearUploadedPlanOverlay(true);
      setActiveSharedProjectMeta({ id: "", lastEditedAt: "", savedBy: "" });
      setRemoteSharedUpdateNotice(null);
      setSavedProjectSignature("");
      setLastManualSaveAt("");
      initialSaveBaselineSetRef.current = false;
      reloadDrawForActiveLayer(empty, layerVisibleRef.current);
      resetUndoRedoHistory(empty);
      setAppScreen(
        normalizedMode === WORKFLOW_MODE_PDF ? APP_SCREEN_PDF : APP_SCREEN_LOCATION
      );
      if (normalizedMode === WORKFLOW_MODE_PDF) {
        setTimeout(() => {
          try {
            pdfUploadPromptInputRef.current?.click?.();
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
        }, 120);
      }
      if (announce) {
        pushToast(
          normalizedMode === WORKFLOW_MODE_PDF
            ? "Started a new PDF/Image measuring page."
            : "Started a new location measuring page.",
          "info"
        );
      }
    },
    [clearUploadedPlanOverlay, pushToast, reloadDrawForActiveLayer, resetUndoRedoHistory]
  );

  const loadProjectFile = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (isTrainingExportMetadataPayload(data)) {
          pushToast(
            "This JSON is a training export metadata file, not a project file. Use Save Project (JSON) to create a loadable project file.",
            "warn",
            8000
          );
          e.target.value = "";
          return;
        }
        if (!isValidProjectPayload(data)) {
          throw new Error("Invalid project schema");
        }
        applyProjectPayload(data, {
          fallbackProjectName: file.name.replace(/\.json$/i, ""),
          successToast: "Project loaded.",
          switchToWorkspace: true,
          markAutosaveAvailable: false,
          storeInLibrary: true,
        });
        e.target.value = "";
      } catch (err) {
        console.error("Failed to load project:", err);
        pushToast("That project file could not be loaded.", "error", 6000);
      }
    },
    [applyProjectPayload, pushToast]
  );

  const restoreAutosave = useCallback(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) {
        pushToast("No autosave draft found.", "warn");
        return;
      }
      const data = JSON.parse(raw);
      if (!isValidProjectPayload(data)) {
        pushToast("Autosave draft is invalid.", "error");
        return;
      }
      applyProjectPayload(data, {
        fallbackProjectName: "Recovered Project",
        successToast: "Autosave draft restored.",
        switchToWorkspace: true,
        markAutosaveAvailable: true,
        storeInLibrary: true,
      });
    } catch {
      pushToast("Failed to restore autosave draft.", "error", 5000);
    }
  }, [applyProjectPayload, pushToast]);

  const clearAutosave = useCallback(() => {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
      setAutosaveDraftAvailable(false);
      pushToast("Autosave draft cleared.", "info");
    } catch {
      pushToast("Could not clear autosave draft.", "error");
    }
  }, [pushToast]);

  const restoreVersionSnapshot = useCallback(
    (versionId) => {
      const targetId = String(currentProjectLibraryId || "").trim();
      const versionsForProject =
        targetId && Array.isArray(projectVersionHistory?.[targetId])
          ? projectVersionHistory[targetId]
          : [];
      const target = versionsForProject.find(
        (version) => String(version?.id || "") === String(versionId || "")
      );
      if (!target?.payload || !isValidProjectPayload(target.payload)) {
        pushToast("That snapshot is unavailable or invalid.", "error", 5200);
        return;
      }
      applyProjectPayload(target.payload, {
        fallbackProjectName: projectName || "Recovered Project",
        successToast: "Version restored from history.",
        switchToWorkspace: true,
        markAutosaveAvailable: true,
        storeInLibrary: true,
      });
      setVersionCompareId(String(target.id || ""));
      setShowVersionHistory(false);
    },
    [
      applyProjectPayload,
      currentProjectLibraryId,
      projectName,
      projectVersionHistory,
      pushToast,
    ]
  );

  const clearCurrentProjectVersionHistory = useCallback(() => {
    const targetId = String(currentProjectLibraryId || "").trim();
    if (!targetId) {
      pushToast("No project selected for version history clear.", "warn", 3200);
      return;
    }
    const versionsForProject = Array.isArray(projectVersionHistory?.[targetId])
      ? projectVersionHistory[targetId]
      : [];
    if (!versionsForProject.length) {
      pushToast("No saved snapshots exist for this project.", "info", 2800);
      return;
    }
    askConfirm({
      title: "Clear Version History",
      message:
        "Remove all saved snapshots for this project? Current map data stays unchanged.",
      confirmText: "Clear History",
      cancelText: "Cancel",
      danger: true,
      onConfirm: () => {
        setProjectVersionHistory((prev) => {
          const next = { ...(prev && typeof prev === "object" ? prev : {}) };
          delete next[targetId];
          return next;
        });
        setVersionCompareId("");
        setShowVersionHistory(false);
        setConfirm(null);
        pushToast("Version history cleared for this project.", "info", 3500);
      },
    });
  }, [
    askConfirm,
    currentProjectLibraryId,
    projectVersionHistory,
    pushToast,
  ]);

  const removeProjectFromLibrary = useCallback(
    async (id) => {
      setProjectLibrary((prev) => (prev || []).filter((entry) => entry?.id !== id));
      if (!sharedAccessAuthenticated) {
        pushToast("Removed from this device. Log in to remove it from shared files too.", "info", 4300);
        return;
      }
      try {
        await deleteSharedProject(id);
        setSharedProjectQueue((prev) =>
          (Array.isArray(prev) ? prev : []).filter(
            (op) => String(op?.id) !== String(id)
          )
        );
        setSharedProjectLibraryStatus("connected");
        pushToast("Removed project from shared Home library.", "info", 3500);
      } catch (error) {
        if (isAuthError(error)) {
          setSharedAuth((prev) => ({
            token: "",
            username: String(prev?.username || sharedLoginUsername || "admin").trim() || "admin",
            expiresAt: "",
          }));
          setSharedProjectLibraryStatus("locked");
        } else {
          setSharedProjectLibraryStatus("offline");
        }
        setSharedProjectQueue((prev) =>
          upsertSharedQueueOperation(prev, {
            op: "delete",
            id: String(id || ""),
          })
        );
        pushToast(
          `Removed locally and queued for sync: ${error?.message || "backend unavailable"}.`,
          "warn",
          5200
        );
      }
    },
    [pushToast, sharedAccessAuthenticated, sharedLoginUsername]
  );

  const loadProjectFromLibrary = useCallback(
    async (id) => {
      if (!sharedAccessAuthenticated) {
        pushToast("Log in on Home to view and open projects.", "warn", 4200);
        return;
      }
      const entry = (projectLibrary || []).find((item) => item?.id === id);
      if (entry?.payload && isValidProjectPayload(entry.payload)) {
        try {
          applyProjectPayload(entry.payload, {
            fallbackProjectName: entry.projectName || "Saved Project",
            successToast: `Loaded "${entry.projectName || "Saved Project"}".`,
            switchToWorkspace: true,
            markAutosaveAvailable: false,
            storeInLibrary: true,
            sharedMeta: {
              id: String(entry.id || "").trim(),
              lastEditedAt: String(entry.lastEditedAt || entry.savedAt || "").trim(),
              savedBy: String(entry.savedBy || "").trim(),
            },
          });
          return;
        } catch {
          pushToast("Could not load that saved project.", "error", 5000);
          return;
        }
      }

      try {
        const remoteProject = await getSharedProject(id);
        if (!isValidProjectPayload(remoteProject?.payload)) {
          pushToast(
            "That shared project payload is invalid. Re-save it from a working browser.",
            "error",
            6000
          );
          return;
        }
        setSharedProjectLibraryStatus("connected");
        applyProjectPayload(remoteProject.payload, {
          fallbackProjectName: remoteProject.project_name || entry?.projectName || "Saved Project",
          successToast: `Loaded "${remoteProject.project_name || entry?.projectName || "Saved Project"}".`,
          switchToWorkspace: true,
          markAutosaveAvailable: false,
          storeInLibrary: true,
          sharedMeta: {
            id: String(remoteProject.id || entry?.id || "").trim(),
            lastEditedAt: String(
              remoteProject.last_edited_at || remoteProject.saved_at || ""
            ).trim(),
            savedBy: String(remoteProject.saved_by || "").trim(),
          },
        });
        setProjectLibrary((prev) =>
          upsertProjectLibraryEntries(
            prev,
            remoteProject.payload,
            remoteProject.project_name || "Saved Project",
            {
              savedBy: String(remoteProject.saved_by || "").trim(),
              lastEditedAt: String(
                remoteProject.last_edited_at || remoteProject.saved_at || ""
              ).trim(),
            }
          )
        );
      } catch (error) {
        if (isAuthError(error)) {
          setSharedAuth((prev) => ({
            token: "",
            username: String(prev?.username || sharedLoginUsername || "admin").trim() || "admin",
            expiresAt: "",
          }));
          setSharedProjectLibraryStatus("locked");
        } else {
          setSharedProjectLibraryStatus("offline");
        }
        pushToast(
          "Could not load that shared project. Check backend server and try refresh.",
          "error",
          5500
        );
      }
    },
    [applyProjectPayload, projectLibrary, pushToast, sharedAccessAuthenticated, sharedLoginUsername]
  );

  const hasCurrentProjectData = useMemo(() => {
    if (boundary && isPolygonLike(boundary)) return true;
    for (const key of LAYER_KEYS) {
      if ((layerFeatures[key] || []).length > 0) return true;
    }
    if ((pdfAnnotations || []).length > 0) return true;
    return !!String(projectName || "").trim();
  }, [boundary, layerFeatures, pdfAnnotations, projectName]);

  const currentProjectSignature = useMemo(
    () => buildProjectPayloadSignature(buildProjectPayload()),
    [buildProjectPayload]
  );

  useEffect(() => {
    if (initialSaveBaselineSetRef.current) return;
    if (!currentProjectSignature) return;
    setSavedProjectSignature(currentProjectSignature);
    initialSaveBaselineSetRef.current = true;
  }, [currentProjectSignature]);

  const hasUnsavedChanges = useMemo(() => {
    if (!savedProjectSignature) return !!hasCurrentProjectData;
    return savedProjectSignature !== currentProjectSignature;
  }, [currentProjectSignature, hasCurrentProjectData, savedProjectSignature]);

  const saveStatusLabel = useMemo(() => {
    if (saveInProgress) return "Saving...";
    if (hasUnsavedChanges) return "Unsaved changes";
    if (lastManualSaveAt) {
      return `Saved ${new Date(lastManualSaveAt).toLocaleTimeString()}`;
    }
    return "Saved";
  }, [hasUnsavedChanges, lastManualSaveAt, saveInProgress]);

  const visibleProjectLibrary = useMemo(() => {
    const entries = Array.isArray(projectLibrary) ? projectLibrary : [];
    if (!sharedAccessAuthenticated) return [];
    return entries;
  }, [projectLibrary, sharedAccessAuthenticated]);

  const currentProjectVersions = useMemo(() => {
    const all = projectVersionHistory && typeof projectVersionHistory === "object"
      ? projectVersionHistory
      : {};
    const byId = Array.isArray(all[currentProjectLibraryId]) ? all[currentProjectLibraryId] : [];
    return byId;
  }, [currentProjectLibraryId, projectVersionHistory]);

  const selectedVersionForCompare = useMemo(
    () =>
      (currentProjectVersions || []).find(
        (version) => String(version?.id || "") === String(versionCompareId || "")
      ) || null,
    [currentProjectVersions, versionCompareId]
  );

  const currentProjectMetrics = useMemo(
    () => summarizePayloadMetrics(buildProjectPayload()),
    [buildProjectPayload]
  );

  const selectedVersionMetrics = useMemo(
    () => summarizePayloadMetrics(selectedVersionForCompare?.payload || null),
    [selectedVersionForCompare]
  );

  const activeOperations = useMemo(() => {
    const ops = [];
    if (saveInProgress) {
      ops.push({ id: "save", label: "Saving project", detail: "Writing local/shared project files." });
    }
    if (propertyLookupLoading) {
      ops.push({
        id: "lookup",
        label: "Property lookup",
        detail: "Searching address and boundary.",
        canCancel: true,
      });
    }
    if (propertyLookupSuggestLoading) {
      ops.push({ id: "suggestions", label: "Address suggestions", detail: "Loading autocomplete." });
    }
    if (backendSubmitting) {
      ops.push({ id: "ai-measure", label: "AI takeoff", detail: "Computing measurements." });
    }
    if (segmentingImage) {
      ops.push({ id: "segment", label: "CV segmentation", detail: "Generating polygons by class." });
    }
    if (capturingMapImage) {
      ops.push({ id: "capture", label: "Capturing map image", detail: "Preparing backend input image." });
    }
    if (trainingExporting) {
      ops.push({ id: "training-export", label: "Training export", detail: "Building correction sample ZIP." });
    }
    if (pdfConverting) {
      ops.push({ id: "pdf-convert", label: "PDF convert", detail: "Rendering page image for markup." });
    }
    if (sharedProjectQueueSyncing) {
      ops.push({ id: "shared-sync", label: "Shared sync", detail: "Uploading queued shared updates." });
    }
    if (sharedProjectLibrarySyncing) {
      ops.push({ id: "library-refresh", label: "Refreshing shared library", detail: "Fetching latest project list." });
    }
    return ops;
  }, [
    backendSubmitting,
    capturingMapImage,
    pdfConverting,
    propertyLookupLoading,
    propertyLookupSuggestLoading,
    saveInProgress,
    segmentingImage,
    sharedProjectLibrarySyncing,
    sharedProjectQueueSyncing,
    trainingExporting,
  ]);

  const sharedStatusUi = useMemo(() => {
    if (sharedAuthChecking || sharedProjectLibraryStatus === "connecting") {
      return {
        label: "Shared: connecting",
        border: "1px solid rgba(150,190,255,0.6)",
        background: "rgba(70,110,180,0.22)",
      };
    }
    if (sharedProjectLibraryStatus === "connected") {
      return {
        label: "Shared: connected",
        border: "1px solid rgba(89,226,143,0.55)",
        background: "rgba(28,162,92,0.20)",
      };
    }
    if (sharedProjectLibraryStatus === "locked" || !sharedAccessAuthenticated) {
      return {
        label: "Shared: login required",
        border: "1px solid rgba(255,214,102,0.55)",
        background: "rgba(164,130,32,0.24)",
      };
    }
    return {
      label: "Shared: offline",
      border: "1px solid rgba(255,180,80,0.55)",
      background: "rgba(198,116,42,0.22)",
    };
  }, [
    sharedAccessAuthenticated,
    sharedAuthChecking,
    sharedProjectLibraryStatus,
  ]);

  const openTrue3DViewer = useCallback(() => {
    setShowTrue3DViewer(true);
  }, []);

  const closeTrue3DViewer = useCallback(() => {
    setShowTrue3DViewer(false);
    setTrue3DLoading(false);
    setTrue3DStatus("");
    setTrue3DEditMode(false);
    setTrue3DToolMode("pan");
    setTrue3DSelectedFeatureId("");
    true3DDraggingRef.current = false;
    const viewer = true3DViewerRef.current;
    const eventHandler = true3DEventHandlerRef.current;
    if (eventHandler) {
      try {
        eventHandler.destroy();
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      true3DEventHandlerRef.current = null;
    }
    true3DEditEntityIdsRef.current = [];
    true3DOverlayEntityIdsRef.current = [];
    if (viewer) {
      try {
        viewer.destroy();
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      true3DViewerRef.current = null;
    }
  }, []);

  const clearTrue3DEntitiesByIds = useCallback((viewer, idListRef) => {
    if (!viewer || !idListRef?.current) return;
    const ids = idListRef.current;
    for (const id of ids) {
      try {
        const entity = viewer.entities.getById(id);
        if (entity) viewer.entities.remove(entity);
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    }
    idListRef.current = [];
  }, []);

  const updateRingVertex = useCallback((ring, vertexIdx, lng, lat) => {
    if (!Array.isArray(ring) || ring.length < 4) return;
    const idx = Math.max(0, Math.min(ring.length - 1, Number(vertexIdx) || 0));
    const next = [Number(lng), Number(lat)];
    ring[idx] = next;
    if (idx === 0 || idx === ring.length - 1) {
      ring[0] = next;
      ring[ring.length - 1] = next;
    }
  }, []);

  const apply3DVertexMove = useCallback((meta, lng, lat) => {
    if (!meta || !Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const layerKey = String(meta.layerKey || "");
    const featureId = String(meta.featureId || "");
    if (!LAYER_KEYS.includes(layerKey) || !featureId) return;

    const currentLayer = layerFeaturesRef.current[layerKey] || [];
    const nextLayer = currentLayer.map((f) => to2DFeature(f));
    const target = nextLayer.find((f) => String(f?.id || "") === featureId);
    if (!target || !target.geometry) return;
    if (target.geometry.type === "Polygon") {
      const ring = Array.isArray(target.geometry.coordinates?.[0])
        ? target.geometry.coordinates[0]
        : null;
      if (!ring) return;
      updateRingVertex(ring, meta.vertexIdx, lng, lat);
    } else if (target.geometry.type === "MultiPolygon") {
      const polyIdx = Math.max(0, Number(meta.polyIdx) || 0);
      const ring = Array.isArray(target.geometry.coordinates?.[polyIdx]?.[0])
        ? target.geometry.coordinates[polyIdx][0]
        : null;
      if (!ring) return;
      updateRingVertex(ring, meta.vertexIdx, lng, lat);
    } else {
      return;
    }

    const nextFeatures = {
      ...layerFeaturesRef.current,
      [layerKey]: nextLayer,
    };
    layerFeaturesRef.current = nextFeatures;
    setLayerFeatures(nextFeatures);
    reloadDrawForActiveLayer(nextFeatures, layerVisibleRef.current);
  }, [reloadDrawForActiveLayer, updateRingVertex]);

  const zoomTrue3D = useCallback((factor = 0.5) => {
    const viewer = true3DViewerRef.current;
    if (!viewer || !Number.isFinite(factor) || factor <= 0) return;
    try {
      const cam = viewer.camera;
      const h = Number(cam.positionCartographic?.height || 1200);
      const next = Math.max(5, Math.min(20_000_000, h * factor));
      cam.moveForward(h - next);
      viewer.scene.requestRender?.();
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, []);

  const renderTrue3DOverlays = useCallback((viewer, Cesium) => {
    if (!viewer || !Cesium) return;
    clearTrue3DEntitiesByIds(viewer, true3DOverlayEntityIdsRef);

    const overlayIds = [];
    if (boundary && isPolygonLike(boundary)) {
      try {
        addCesiumPolygonEntities(viewer, Cesium, "takeoff-boundary", boundary, {
          material: Cesium.Color.CYAN.withAlpha(0.14),
          outlineColor: Cesium.Color.CYAN.withAlpha(0.95),
          clampToGround: true,
          outlineWidth: 3,
          collectEntityIds: overlayIds,
        });
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    }

    try {
      const layerOrder = ["plowable", "sidewalks", "turf", "mulch"];
      const layerAlpha = {
        plowable: 0.26,
        sidewalks: 0.3,
        turf: 0.24,
        mulch: 0.3,
      };
      const selectedFeatureId = String(true3DSelectedFeatureIdRef.current || "");
      for (const key of layerOrder) {
        const fillHex = LAYER_COLORS[key]?.fill || "#00ffff";
        const lineHex = LAYER_COLORS[key]?.line || fillHex;
        const fillColor = Cesium.Color.fromCssColorString(fillHex).withAlpha(
          layerAlpha[key] ?? 0.26
        );
        const lineColor = Cesium.Color.fromCssColorString(lineHex).withAlpha(0.95);
        for (const feature of layerFeaturesRef.current[key] || []) {
          const featureId = String(feature?.id || "");
          const isSelected = key === activeLayerRef.current && featureId === selectedFeatureId;
          const beforeCount = overlayIds.length;
          addCesiumPolygonEntities(viewer, Cesium, `takeoff-${key}`, feature, {
            material: isSelected ? lineColor.withAlpha(0.32) : fillColor,
            outlineColor: isSelected
              ? Cesium.Color.WHITE.withAlpha(1)
              : lineColor,
            clampToGround: true,
            outlineWidth: isSelected ? 4 : key === "sidewalks" ? 2.4 : 2,
            collectEntityIds: overlayIds,
          });
          if (featureId) {
            for (let i = beforeCount; i < overlayIds.length; i += 1) {
              const id = overlayIds[i];
              const ent = viewer.entities.getById(id);
              if (!ent) continue;
              ent.__takeoffFeatureMeta = {
                layerKey: key,
                featureId,
              };
            }
          }
        }
      }
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }

    true3DOverlayEntityIdsRef.current = overlayIds;
  }, [boundary, clearTrue3DEntitiesByIds]);

  const rebuildTrue3DEditHandles = useCallback((viewer, Cesium) => {
    if (!viewer || !Cesium) return;
    clearTrue3DEntitiesByIds(viewer, true3DEditEntityIdsRef);
    if (true3DEventHandlerRef.current) {
      try {
        true3DEventHandlerRef.current.destroy();
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      true3DEventHandlerRef.current = null;
    }
    const layerKey = activeLayerRef.current;
    const selectedFeatureId = String(true3DSelectedFeatureIdRef.current || "");
    const showHandles = true3DEditMode && !!selectedFeatureId;
    const lineHex = LAYER_COLORS[layerKey]?.line || "#22ccff";
    const handleColor = Cesium.Color.fromCssColorString(lineHex);
    const handleFillIdle = Cesium.Color.WHITE.withAlpha(0.98);
    const handleFillHover = handleColor.withAlpha(0.95);
    const handleFillActive = Cesium.Color.fromCssColorString("#ffe066").withAlpha(0.99);
    const features = layerFeaturesRef.current[layerKey] || [];
    const ids = [];
    if (showHandles) {
      for (const feature of features) {
        if (String(feature?.id || "") !== selectedFeatureId) continue;
        if (!isPolygonLike(feature)) continue;
        const geometry = feature.geometry;
        const polygons =
          geometry.type === "Polygon"
            ? [geometry.coordinates]
            : geometry.type === "MultiPolygon"
            ? geometry.coordinates
            : [];
        polygons.forEach((polyCoords, polyIdx) => {
          const ring = Array.isArray(polyCoords?.[0]) ? polyCoords[0] : [];
          if (!Array.isArray(ring) || ring.length < 4) return;
          for (let vertexIdx = 0; vertexIdx < ring.length - 1; vertexIdx += 1) {
            const pt = ring[vertexIdx];
            if (!Array.isArray(pt) || pt.length < 2) continue;
            const id = `edit-${layerKey}-${feature.id}-${polyIdx}-${vertexIdx}-${Date.now()}`;
            const entity = viewer.entities.add({
              id,
              position: Cesium.Cartesian3.fromDegrees(Number(pt[0]), Number(pt[1]), 0),
              point: {
                pixelSize: true3DToolMode === "edit" ? 16 : 14,
                color: handleFillIdle,
                outlineColor: handleColor.withAlpha(0.98),
                outlineWidth: true3DToolMode === "edit" ? 3.2 : 2.8,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            });
            entity.__takeoffEditMeta = {
              layerKey,
              featureId: String(feature.id),
              polyIdx,
              vertexIdx,
            };
            ids.push(id);
          }
        });
      }
    }
    true3DEditEntityIdsRef.current = ids;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    let dragging = null;
    let hovered = null;

    const setCameraEnabled = (enabled) => {
      const scc = viewer.scene.screenSpaceCameraController;
      scc.enableRotate = enabled;
      scc.enableTranslate = enabled;
      scc.enableTilt = enabled;
      scc.enableZoom = enabled;
      scc.enableLook = enabled;
    };

    const setHandleVisual = (entity, mode) => {
      if (!entity?.point) return;
      if (mode === "active") {
        entity.point.color = handleFillActive;
        entity.point.pixelSize = 22;
        entity.point.outlineWidth = 3.8;
      } else if (mode === "hover") {
        entity.point.color = handleFillHover;
        entity.point.pixelSize = true3DToolMode === "edit" ? 19 : 16;
        entity.point.outlineWidth = 3.4;
      } else {
        entity.point.color = handleFillIdle;
        entity.point.pixelSize = true3DToolMode === "edit" ? 16 : 14;
        entity.point.outlineWidth = true3DToolMode === "edit" ? 3.2 : 2.8;
      }
    };

    const getLonLatFromScreen = (position) => {
      if (!position) return null;
      let cartesian = null;
      try {
        if (viewer.scene.pickPositionSupported) {
          cartesian = viewer.scene.pickPosition(position);
        }
      } catch {
        cartesian = null;
      }
      if (!cartesian) {
        try {
          const ray = viewer.camera.getPickRay(position);
          if (ray) cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        } catch {
          cartesian = null;
        }
      }
      if (!cartesian) {
        cartesian = viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid);
      }
      if (!cartesian) return null;
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      if (!carto) return null;
      return {
        lng: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
      };
    };

    const pickTakeoffEntity = (position) => {
      if (!position) return null;
      try {
        const picks = viewer.scene.drillPick(position, 12) || [];
        const hit = picks.find((p) => p?.id?.__takeoffEditMeta || p?.id?.__takeoffFeatureMeta);
        if (hit?.id) return hit.id;
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      try {
        const picked = viewer.scene.pick(position);
        return picked?.id || null;
      } catch {
        return null;
      }
    };

    const getRingByMeta = (meta) => {
      const layerKeyFromMeta = String(meta?.layerKey || "");
      const featureIdFromMeta = String(meta?.featureId || "");
      const feature = (layerFeaturesRef.current[layerKeyFromMeta] || []).find(
        (f) => String(f?.id || "") === featureIdFromMeta
      );
      if (!feature || !feature.geometry) return null;
      if (feature.geometry.type === "Polygon") {
        return Array.isArray(feature.geometry.coordinates?.[0])
          ? feature.geometry.coordinates[0]
          : null;
      }
      if (feature.geometry.type === "MultiPolygon") {
        const polyIdx = Math.max(0, Number(meta?.polyIdx) || 0);
        return Array.isArray(feature.geometry.coordinates?.[polyIdx]?.[0])
          ? feature.geometry.coordinates[polyIdx][0]
          : null;
      }
      return null;
    };

    const syncHandlePositionsFromGeometry = (featureId) => {
      const targetId = String(featureId || "");
      if (!targetId) return;
      for (const id of true3DEditEntityIdsRef.current || []) {
        const ent = viewer.entities.getById(id);
        const meta = ent?.__takeoffEditMeta;
        if (!ent || !meta) continue;
        if (String(meta.featureId || "") !== targetId) continue;
        const ring = getRingByMeta(meta);
        const vertexIdx = Math.max(0, Number(meta.vertexIdx) || 0);
        const pt = Array.isArray(ring?.[vertexIdx]) ? ring[vertexIdx] : null;
        if (!pt || !Number.isFinite(Number(pt[0])) || !Number.isFinite(Number(pt[1]))) continue;
        ent.position = Cesium.Cartesian3.fromDegrees(Number(pt[0]), Number(pt[1]), 0);
      }
      viewer.scene.requestRender?.();
    };

    const clearHover = () => {
      if (!hovered || hovered === dragging?.entity) return;
      setHandleVisual(hovered, "idle");
      hovered = null;
    };

    const finishDrag = (commit) => {
      if (!dragging) return;
      setCameraEnabled(true);
      if (Number.isFinite(dragging.lastLng) && Number.isFinite(dragging.lastLat) && commit) {
        apply3DVertexMove(dragging.meta, dragging.lastLng, dragging.lastLat);
      }
      true3DDraggingRef.current = false;
      historySuspendedRef.current = false;
      if (commit && dragging?.beforeFeatures) {
        const afterSignature = layerFeaturesSignature(layerFeaturesRef.current);
        if (afterSignature && afterSignature !== dragging.beforeSignature) {
          undoStackRef.current.push(cloneLayerFeatures(dragging.beforeFeatures));
          if (undoStackRef.current.length > UNDO_REDO_MAX_DEPTH) undoStackRef.current.shift();
          redoStackRef.current = [];
          updateUndoRedoFlags();
        }
      }
      historyPrevFeaturesRef.current = cloneLayerFeatures(layerFeaturesRef.current);
      historyPrevSignatureRef.current = layerFeaturesSignature(layerFeaturesRef.current);
      renderTrue3DOverlays(viewer, Cesium);
      syncHandlePositionsFromGeometry(dragging.meta?.featureId);
      setHandleVisual(dragging.entity, "idle");
      dragging = null;
      viewer.canvas.style.cursor = "default";
      viewer.scene.requestRender?.();
    };

    handler.setInputAction((click) => {
      if (true3DToolMode !== "edit") return;
      const ent = pickTakeoffEntity(click.position);
      if (!ent?.__takeoffEditMeta) return;
      dragging = {
        entity: ent,
        meta: ent.__takeoffEditMeta,
      };
      dragging.beforeFeatures = cloneLayerFeatures(layerFeaturesRef.current);
      dragging.beforeSignature = layerFeaturesSignature(layerFeaturesRef.current);
      true3DDraggingRef.current = true;
      historySuspendedRef.current = true;
      try {
        const now = Cesium.JulianDate.now?.();
        const pos = ent.position?.getValue?.(now);
        const carto = pos ? Cesium.Cartographic.fromCartesian(pos) : null;
        if (carto) {
          dragging.startLng = Cesium.Math.toDegrees(carto.longitude);
          dragging.startLat = Cesium.Math.toDegrees(carto.latitude);
          dragging.lastLng = dragging.startLng;
          dragging.lastLat = dragging.startLat;
        }
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      if (hovered && hovered !== ent) setHandleVisual(hovered, "idle");
      hovered = null;
      setHandleVisual(ent, "active");
      setCameraEnabled(false);
      viewer.canvas.style.cursor = "grabbing";
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((click) => {
      if (dragging) return;
      const ent = pickTakeoffEntity(click.position);
      if (ent?.__takeoffEditMeta) {
        const meta = ent.__takeoffEditMeta;
        if (meta?.layerKey && meta?.featureId) {
          if (String(meta.layerKey) !== activeLayerRef.current) {
            setActiveLayer(String(meta.layerKey));
          }
          setTrue3DSelectedFeatureId(String(meta.featureId));
        }
        return;
      }
      const featureMeta = ent?.__takeoffFeatureMeta;
      if (!featureMeta?.featureId || !featureMeta?.layerKey) return;
      const pickedLayer = String(featureMeta.layerKey);
      const pickedFeatureId = String(featureMeta.featureId);
      if (pickedLayer !== activeLayerRef.current) setActiveLayer(pickedLayer);
      setTrue3DSelectedFeatureId(pickedFeatureId);
      viewer.scene.requestRender?.();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((move) => {
      if (dragging) {
        const next = getLonLatFromScreen(move.endPosition);
        if (!next) return;
        if (Number.isFinite(dragging.lastLng) && Number.isFinite(dragging.lastLat)) {
          const jumpM = distanceMetersLngLat(
            dragging.lastLng,
            dragging.lastLat,
            next.lng,
            next.lat
          );
          // Ignore outlier picks from 3D tiles/buildings that can detach handles.
          if (jumpM > 120) return;
        }
        dragging.entity.position = Cesium.Cartesian3.fromDegrees(next.lng, next.lat, 0);
        dragging.lastLng = next.lng;
        dragging.lastLat = next.lat;
        apply3DVertexMove(dragging.meta, next.lng, next.lat);
        renderTrue3DOverlays(viewer, Cesium);
        syncHandlePositionsFromGeometry(dragging.meta?.featureId);
        viewer.scene.requestRender?.();
        return;
      }
      if (true3DToolMode !== "edit") {
        clearHover();
        viewer.canvas.style.cursor = "default";
        return;
      }
      const ent = pickTakeoffEntity(move.endPosition);
      if (ent?.__takeoffEditMeta) {
        if (hovered && hovered !== ent) setHandleVisual(hovered, "idle");
        hovered = ent;
        setHandleVisual(ent, "hover");
        viewer.canvas.style.cursor = "grab";
      } else {
        clearHover();
        viewer.canvas.style.cursor = "default";
      }
      viewer.scene.requestRender?.();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction(() => {
      finishDrag(true);
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    handler.setInputAction(() => {
      finishDrag(true);
    }, Cesium.ScreenSpaceEventType.PINCH_END);

    handler.setInputAction(() => {
      finishDrag(false);
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

    // Prevent default Cesium double-click zoom while selecting/editing.
    handler.setInputAction(() => {}, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    true3DEventHandlerRef.current = handler;
  }, [
    apply3DVertexMove,
    clearTrue3DEntitiesByIds,
    renderTrue3DOverlays,
    updateUndoRedoFlags,
    true3DEditMode,
    true3DToolMode,
    setActiveLayer,
  ]);

  const true3DActiveVertexCount = useMemo(() => {
    const selectedId = String(true3DSelectedFeatureId || "");
    if (!selectedId) return 0;
    const features = layerFeatures[activeLayer] || [];
    const feature = features.find((f) => String(f?.id || "") === selectedId);
    return feature ? countPolygonVertices(feature) : 0;
  }, [activeLayer, layerFeatures, true3DSelectedFeatureId]);

  useEffect(() => {
    const selectedId = String(true3DSelectedFeatureId || "");
    if (!selectedId) return;
    const exists = (layerFeatures[activeLayer] || []).some(
      (f) => String(f?.id || "") === selectedId
    );
    if (!exists) setTrue3DSelectedFeatureId("");
  }, [activeLayer, layerFeatures, true3DSelectedFeatureId]);

  const getCurrentCenterLatLng = useCallback(() => {
    let lat = null;
    let lng = null;

    try {
      const map = mapRef.current;
      const center = map?.getCenter?.();
      if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
        lat = Number(center.lat);
        lng = Number(center.lng);
      }
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }

    if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && boundary && isPolygonLike(boundary)) {
      try {
        const c = turf.centroid(boundary);
        const coords = c?.geometry?.coordinates || [];
        if (Array.isArray(coords) && coords.length >= 2) {
          lng = Number(coords[0]);
          lat = Number(coords[1]);
        }
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat: Number(lat), lng: Number(lng) };
  }, [boundary]);

  useEffect(() => {
    if (!showTrue3DViewer) return;
    let cancelled = false;

    const init = async () => {
      const center = getCurrentCenterLatLng();
      if (!center) {
        pushToast("Map center unavailable. Pan/zoom map first, then try 3D viewer.", "warn", 5000);
        setShowTrue3DViewer(false);
        return;
      }
      setTrue3DLoading(true);
      setTrue3DStatus("Loading 3D engine...");
      try {
        const Cesium = await loadCesiumGlobal();
        if (cancelled) return;
        const mountNode = true3DContainerRef.current;
        if (!mountNode) {
          throw new Error("3D container is unavailable.");
        }

        if (true3DViewerRef.current) {
          try {
            true3DViewerRef.current.destroy();
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
          true3DViewerRef.current = null;
        }

        const viewer = new Cesium.Viewer(mountNode, {
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          infoBox: false,
          selectionIndicator: false,
          fullscreenButton: false,
          skyAtmosphere: false,
          shadows: false,
          terrainShadows: Cesium.ShadowMode.DISABLED,
          orderIndependentTranslucency: false,
          requestRenderMode: true,
          showRenderLoopErrors: false,
        });
        true3DViewerRef.current = viewer;
        try {
          if (viewer.cesiumWidget) viewer.cesiumWidget.showRenderLoopErrors = false;
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }

        // Disable Cesium's built-in double-click zoom so selecting polygons
        // never triggers a sudden camera jump on desktop/iPad.
        try {
          viewer.cesiumWidget?.screenSpaceEventHandler?.removeInputAction?.(
            Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
          );
          viewer.screenSpaceEventHandler?.removeInputAction?.(
            Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
          );
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
        viewer.scene.globe.depthTestAgainstTerrain = false;
        try {
          const scc = viewer.scene?.screenSpaceCameraController;
          if (scc) {
            scc.zoomEventTypes = [
              Cesium.CameraEventType.WHEEL,
              Cesium.CameraEventType.PINCH,
              Cesium.CameraEventType.RIGHT_DRAG,
            ];
            scc.enableZoom = true;
            scc.enableTranslate = true;
            scc.enableTilt = true;
            scc.enableLook = true;
            scc.enableRotate = true;
            scc.enableCollisionDetection = false;
            scc.minimumZoomDistance = 1;
            scc.maximumZoomDistance = 20_000_000;
          }
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
        // Safari stability: avoid Cesium dynamic-lighting code path that can crash
        // with "setDynamicLighting is not a function" on some builds/devices.
        try {
          if (viewer.scene?.globe) {
            viewer.scene.globe.enableLighting = false;
            viewer.scene.globe.dynamicAtmosphereLighting = false;
            viewer.scene.globe.dynamicAtmosphereLightingFromSun = false;
          }
          viewer.scene.fog.enabled = false;
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }

        try {
          viewer.scene.renderError.addEventListener((_scene, error) => {
            const msg = String(error?.message || error || "");
            pushToast(
              `3D render error. Falling back to simpler mode: ${msg.slice(0, 120)}`,
              "warn",
              7000
            );
            try {
              if (viewer.scene?.globe) {
                viewer.scene.globe.enableLighting = false;
                viewer.scene.globe.dynamicAtmosphereLighting = false;
                viewer.scene.globe.dynamicAtmosphereLightingFromSun = false;
              }
              viewer.scene.fog.enabled = false;
              viewer.scene.requestRender?.();
            } catch {
              /* intentionally ignore non-critical map/draw errors */
            }
          });
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }

        let usingGoogleTiles = false;
        if (googleMapsKey && typeof Cesium.createGooglePhotorealistic3DTileset === "function") {
          try {
            Cesium.GoogleMaps.defaultApiKey = googleMapsKey;
            setTrue3DStatus("Loading Google photorealistic 3D tiles...");
            const tileset = await Cesium.createGooglePhotorealistic3DTileset();
            if (!cancelled) {
              viewer.scene.primitives.add(tileset);
              usingGoogleTiles = true;
              setTrue3DStatus("Google photorealistic 3D loaded.");
            }
          } catch {
            usingGoogleTiles = false;
          }
        }

        if (!usingGoogleTiles) {
          setTrue3DStatus("Using Cesium fallback 3D (terrain/buildings).");
          try {
            if (typeof Cesium.createWorldTerrainAsync === "function") {
              viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
            }
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
          try {
            if (typeof Cesium.createOsmBuildingsAsync === "function") {
              const osmBuildings = await Cesium.createOsmBuildingsAsync();
              viewer.scene.primitives.add(osmBuildings);
            }
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
        }

        renderTrue3DOverlays(viewer, Cesium);
        rebuildTrue3DEditHandles(viewer, Cesium);

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(center.lng, center.lat, 1200),
          orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-55),
            roll: 0,
          },
          duration: 1.4,
        });
      } catch (error) {
        pushToast(`3D viewer failed: ${error.message}`, "error", 7000);
        setShowTrue3DViewer(false);
      } finally {
        if (!cancelled) {
          setTrue3DLoading(false);
        }
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [
    getCurrentCenterLatLng,
    googleMapsKey,
    pushToast,
    rebuildTrue3DEditHandles,
    renderTrue3DOverlays,
    showTrue3DViewer,
  ]);

  useEffect(() => {
    if (!showTrue3DViewer) return;
    if (true3DDraggingRef.current) return;
    const viewer = true3DViewerRef.current;
    const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;
    renderTrue3DOverlays(viewer, Cesium);
    rebuildTrue3DEditHandles(viewer, Cesium);
  }, [
    activeLayer,
    boundary,
    layerFeatures,
    renderTrue3DOverlays,
    rebuildTrue3DEditHandles,
    showTrue3DViewer,
    true3DEditMode,
    true3DSelectedFeatureId,
  ]);

  // Upload boundary
  const inferBoundaryFromVectorPoint = useCallback((center) => {
    const map = mapRef.current;
    if (!map || !Array.isArray(center) || center.length < 2) return null;
    const point = turf.point([Number(center[0]), Number(center[1])]);
    const preferredLanduse = new Set([
      "residential",
      "commercial",
      "industrial",
      "retail",
      "institutional",
      "service",
    ]);
    const candidates = [];
    const seen = new Set();

    const collect = (sourceLayer) => {
      let feats = [];
      try {
        feats = map.querySourceFeatures("streets", { sourceLayer }) || [];
      } catch {
        feats = [];
      }
      for (const f of feats) {
        if (!isPolygonLike(f)) continue;
        const candidate = to2DFeature({
          type: "Feature",
          geometry: f.geometry,
          properties: f.properties || {},
        });
        const key =
          JSON.stringify(candidate.geometry?.coordinates?.[0]?.[0] || []) +
          String(candidate.properties?.class || candidate.properties?.subclass || "");
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          if (!turf.booleanPointInPolygon(point, candidate)) continue;
        } catch {
          continue;
        }

        let sqm = 0;
        try {
          sqm = turf.area(candidate);
        } catch {
          sqm = 0;
        }
        if (!Number.isFinite(sqm) || sqm < 150 || sqm > 250000) continue;

        const cls = String(
          candidate.properties?.class ||
            candidate.properties?.subclass ||
            candidate.properties?.type ||
            ""
        ).toLowerCase();
        const priority = preferredLanduse.has(cls) ? 0 : 1;
        candidates.push({
          feature: candidate,
          sqm,
          priority,
          cls,
        });
      }
    };

    collect("landuse");
    collect("landcover");
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.priority - b.priority || a.sqm - b.sqm);
    return {
      ...candidates[0].feature,
      properties: {
        ...(candidates[0].feature.properties || {}),
        lookup_source: "vector",
      },
    };
  }, []);

  const fetchGoogleGeocodeFeatures = useCallback(async (query, signal) => {
    const q = String(query || "").trim();
    if (!q || !googleMapsKey) return [];
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(q)}` +
      `&key=${encodeURIComponent(googleMapsKey)}` +
      `&region=us`;
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Google geocode failed (${response.status}).`);
    }
    const data = await response.json();
    const status = String(data?.status || "");
    if (status === "ZERO_RESULTS") return [];
    if (status !== "OK") {
      throw new Error(`Google geocode error: ${status || "UNKNOWN"}.`);
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    return results
      .map((r) => normalizeGoogleLookupFeature(r, q))
      .filter((feature) => !!feature);
  }, [googleMapsKey]);

  const fetchGooglePlaceFeatureById = useCallback(async (placeId, signal) => {
    const id = String(placeId || "").trim();
    if (!id || !googleMapsKey) return null;
    const url =
      `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}` +
      `?languageCode=en&regionCode=US`;
    const response = await fetch(url, {
      method: "GET",
      signal,
      headers: {
        "X-Goog-Api-Key": googleMapsKey,
        "X-Goog-FieldMask":
          "id,name,displayName,formattedAddress,location,viewport,types",
      },
    });
    if (!response.ok) {
      throw new Error(`Google place details failed (${response.status}).`);
    }
    const data = await response.json();
    return normalizeGoogleLookupFeature(data);
  }, [googleMapsKey]);

  const fetchGoogleAutocompleteFeatures = useCallback(async (query, signal) => {
    const q = String(query || "").trim();
    if (!q || !googleMapsKey) return [];

    try {
      const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleMapsKey,
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types",
        },
        body: JSON.stringify({
          input: q,
          languageCode: "en",
          regionCode: "US",
          includedRegionCodes: ["us"],
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
        const mapped = suggestions
          .map((item) => normalizeGoogleAutocompleteSuggestion(item))
          .filter((feature) => !!feature);
        if (mapped.length) return mapped;
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }

    // Fallback if Places Autocomplete is unavailable for this key/project.
    return fetchGoogleGeocodeFeatures(q, signal);
  }, [fetchGoogleGeocodeFeatures, googleMapsKey]);

  const getLookupFeatureLabel = useCallback((feature, fallback = "") => {
    return String(
      feature?.place_name ||
        feature?.formatted_address ||
        feature?.text ||
        feature?.display_name ||
        fallback ||
        ""
    ).trim();
  }, []);

  const pickBestLookupFeature = useCallback((features, queryText) => {
    if (!Array.isArray(features) || !features.length) return null;
    const q = String(queryText || "").trim().toLowerCase();
    if (!q) return features[0] || null;

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < features.length; i += 1) {
      const f = features[i];
      const label = String(f?.place_name || f?.text || "").toLowerCase();
      const text = String(f?.text || "").toLowerCase();
      const placeType = String(
        Array.isArray(f?.place_type) && f.place_type.length ? f.place_type[0] : ""
      ).toLowerCase();
      const category = String(f?.properties?.category || "").toLowerCase();

      let score = 0;
      if (placeType === "poi" || category.includes(q)) score += 120;
      if (label === q || text === q) score += 90;
      if (text.startsWith(q)) score += 60;
      if (label.startsWith(q)) score += 45;
      if (label.includes(q)) score += 25;
      if (placeType === "address") score += 12;
      if (placeType === "street") score += 8;
      if (placeType === "place") score += 6;
      score -= i * 0.25;

      if (score > bestScore) {
        best = f;
        bestScore = score;
      }
    }
    return best || features[0] || null;
  }, []);

  const resolveGoogleLookupFeature = useCallback(async (queryText, featureOverride, signal) => {
    if (featureOverride) {
      const hasCenter =
        Array.isArray(featureOverride.center) && featureOverride.center.length >= 2;
      if (hasCenter) return featureOverride;
      const placeId = String(featureOverride?.properties?.google_place_id || "").trim();
      if (placeId) {
        try {
          const detailed = await fetchGooglePlaceFeatureById(placeId, signal);
          if (detailed) return detailed;
        } catch {
          // Continue into geocode fallback.
        }
      }
    }

    const geocodeQuery = String(
      queryText || getLookupFeatureLabel(featureOverride, "")
    ).trim();
    if (!geocodeQuery) return null;
    const features = await fetchGoogleGeocodeFeatures(geocodeQuery, signal);
    return pickBestLookupFeature(features, geocodeQuery);
  }, [
    fetchGoogleGeocodeFeatures,
    fetchGooglePlaceFeatureById,
    getLookupFeatureLabel,
    pickBestLookupFeature,
  ]);

  const applyLookupFeature = useCallback(async (top, queryText) => {
    if (!top) return;
    const center = Array.isArray(top.center) && top.center.length >= 2
      ? [Number(top.center[0]), Number(top.center[1])]
      : (Array.isArray(top.geometry?.coordinates) && top.geometry.coordinates.length >= 2
        ? [Number(top.geometry.coordinates[0]), Number(top.geometry.coordinates[1])]
        : null);

    const map = mapRef.current;
    if (map && center) {
      map.flyTo({ center, zoom: 18, duration: 900 });
    }

    await new Promise((resolve) => setTimeout(resolve, 900));

    let nextBoundary = center ? inferBoundaryFromVectorPoint(center) : null;
    let boundarySource = "vector landuse";

    if (!nextBoundary && Array.isArray(top.bbox) && top.bbox.length === 4) {
      try {
        nextBoundary = to2DFeature(turf.bboxPolygon(top.bbox));
        boundarySource = "geocoder bbox";
      } catch {
        nextBoundary = null;
      }
    }

    if (nextBoundary && isPolygonLike(nextBoundary)) {
      setBoundary(nextBoundary);
      setDrawingBoundary(false);
      drawingBoundaryRef.current = false;
      if (!projectName.trim()) {
        setProjectName(getLookupFeatureLabel(top, queryText).slice(0, 100));
      }
      pushToast(
        `Property found. Boundary loaded from ${boundarySource}; verify before takeoff.`,
        "info",
        6000
      );
    } else {
      pushToast(
        "Address found, but exact boundary could not be inferred. Upload KML for best accuracy.",
        "warn",
        7000
      );
    }
  }, [getLookupFeatureLabel, inferBoundaryFromVectorPoint, projectName, pushToast]);

  const lookupPropertyByAddress = useCallback(async (featureOverride = null) => {
    const q = propertyLookupQuery.trim();
    if (!featureOverride && !q) {
      pushToast("Enter a property address to search.", "warn");
      return;
    }
    const usingGoogle = propertyLookupProvider === PROPERTY_LOOKUP_PROVIDER_GOOGLE;
    if (!featureOverride && usingGoogle && !googleMapsKey) {
      pushToast("Google Maps key is missing; Google lookup is unavailable.", "error", 6000);
      return;
    }
    if (!featureOverride && !usingGoogle && !maptilerKey) {
      pushToast("MapTiler key is missing; address lookup is unavailable.", "error", 6000);
      return;
    }

    // Stop suggestion traffic while doing a hard lookup.
    propertyLookupRequestRef.current += 1;
    try {
      propertyLookupAbortRef.current?.abort();
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    setPropertyLookupSuggestOpen(false);
    setPropertyLookupSuggestLoading(false);
    setPropertyLookupSuggestions([]);
    setPropertyLookupSuggestIndex(-1);

    setPropertyLookupLoading(true);
    try {
      let top = featureOverride;
      if (usingGoogle) {
        top = await resolveGoogleLookupFeature(q, featureOverride);
      } else if (!top) {
        const url =
          `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json` +
          `?key=${encodeURIComponent(maptilerKey)}&limit=8` +
          `&fuzzyMatch=true&autocomplete=true&types=poi,address,street,place`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Lookup request failed (${response.status}).`);
        }
        const data = await response.json();
        const features = Array.isArray(data?.features) ? data.features : [];
        top = pickBestLookupFeature(features, q);
      }
      if (!top) {
        pushToast("No matching property found for that address.", "warn", 5000);
        return;
      }
      await applyLookupFeature(top, q);
    } catch (error) {
      pushToast(`Property lookup failed: ${error.message}`, "error", 6000);
    } finally {
      setPropertyLookupLoading(false);
    }
  }, [
    applyLookupFeature,
    googleMapsKey,
    maptilerKey,
    pickBestLookupFeature,
    propertyLookupProvider,
    propertyLookupQuery,
    pushToast,
    resolveGoogleLookupFeature,
  ]);

  const cancelPropertyLookup = useCallback(() => {
    propertyLookupRequestRef.current += 1;
    try {
      propertyLookupAbortRef.current?.abort();
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    setPropertyLookupLoading(false);
    setPropertyLookupSuggestLoading(false);
    setPropertyLookupSuggestOpen(false);
    setPropertyLookupSuggestIndex(-1);
    pushToast("Property lookup cancelled.", "info", 2600);
  }, [pushToast]);

  const cancelOperationById = useCallback(
    (operationId) => {
      if (String(operationId) === "lookup") {
        cancelPropertyLookup();
      }
    },
    [cancelPropertyLookup]
  );

  useEffect(() => {
    const q = propertyLookupQuery.trim();
    const usingGoogle = propertyLookupProvider === PROPERTY_LOOKUP_PROVIDER_GOOGLE;
    propertyLookupRequestRef.current += 1;
    const requestId = propertyLookupRequestRef.current;
    try {
      propertyLookupAbortRef.current?.abort();
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }

    if (
      propertyLookupLoading ||
      q.length < 3 ||
      (usingGoogle && !googleMapsKey) ||
      (!usingGoogle && !maptilerKey)
    ) {
      setPropertyLookupSuggestLoading(false);
      setPropertyLookupSuggestions([]);
      setPropertyLookupSuggestOpen(false);
      setPropertyLookupSuggestIndex(-1);
      return undefined;
    }

    const controller = new AbortController();
    propertyLookupAbortRef.current = controller;
    const timer = setTimeout(async () => {
      setPropertyLookupSuggestLoading(true);
      try {
        let features = [];
        if (usingGoogle) {
          features = await fetchGoogleAutocompleteFeatures(q, controller.signal);
        } else {
          const url =
            `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json` +
            `?key=${encodeURIComponent(maptilerKey)}` +
            `&autocomplete=true&fuzzyMatch=true&limit=8&types=poi,address,street,place`;
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error(`Suggestion request failed (${response.status}).`);
          const data = await response.json();
          features = Array.isArray(data?.features) ? data.features : [];
        }
        if (propertyLookupRequestRef.current !== requestId) return;
        setPropertyLookupSuggestions(features);
        setPropertyLookupSuggestOpen(features.length > 0);
        setPropertyLookupSuggestIndex(features.length > 0 ? 0 : -1);
      } catch (error) {
        if (error?.name === "AbortError") return;
        if (propertyLookupRequestRef.current !== requestId) return;
        setPropertyLookupSuggestions([]);
        setPropertyLookupSuggestOpen(false);
        setPropertyLookupSuggestIndex(-1);
      } finally {
        if (propertyLookupRequestRef.current === requestId) {
          setPropertyLookupSuggestLoading(false);
        }
      }
    }, 260);

    return () => {
      clearTimeout(timer);
      try {
        controller.abort();
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    };
  }, [
    fetchGoogleAutocompleteFeatures,
    googleMapsKey,
    maptilerKey,
    propertyLookupLoading,
    propertyLookupProvider,
    propertyLookupQuery,
  ]);

  const toggleBoundaryDraw = useCallback(() => {
    const draw = drawRef.current;
    if (!draw) {
      pushToast("Map is not ready yet.", "warn");
      return;
    }

    if (drawingBoundaryRef.current) {
      drawingBoundaryRef.current = false;
      setDrawingBoundary(false);
      try {
        draw.changeMode("simple_select");
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      pushToast("Boundary draw cancelled.", "info");
      return;
    }

    if (turfEraseModeRef.current) {
      turfEraseModeRef.current = false;
      setTurfEraseMode(false);
    }
    drawingBoundaryRef.current = true;
    setDrawingBoundary(true);
    try {
      draw.changeMode("draw_polygon");
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    pushToast("Draw boundary polygon, then double-click to finish.", "info", 5000);
  }, [pushToast]);

  const toggleTurfErase = useCallback(() => {
    const draw = drawRef.current;
    if (!draw) {
      pushToast("Map is not ready yet.", "warn");
      return;
    }
    if ((layerFeaturesRef.current.turf || []).length === 0 && !turfEraseModeRef.current) {
      pushToast("No turf polygons to erase yet.", "warn");
      return;
    }

    if (turfEraseModeRef.current) {
      turfEraseModeRef.current = false;
      setTurfEraseMode(false);
      try {
        draw.changeMode("simple_select");
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      pushToast("Turf erase cancelled.", "info");
      return;
    }

    if (drawingBoundaryRef.current) {
      drawingBoundaryRef.current = false;
      setDrawingBoundary(false);
    }
    turfEraseModeRef.current = true;
    setTurfEraseMode(true);
    setActiveLayer("turf");
    activeLayerRef.current = "turf";
    try {
      draw.changeMode("draw_polygon");
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    pushToast("Draw erase polygon over turf, then double-click to apply.", "info", 5500);
  }, [pushToast]);

  const cleanupTurfQuick = useCallback(() => {
    if (!boundary || !isPolygonLike(boundary)) {
      pushToast("Load/draw a boundary first.", "warn");
      return;
    }

    const boundaryFeature = to2DFeature(boundary);
    const turfPolys = (layerFeaturesRef.current.turf || [])
      .map((f) => to2DFeature(f))
      .filter((f) => isPolygonLike(f));
    if (!turfPolys.length) {
      pushToast("No turf polygons to clean.", "warn");
      return;
    }

    let turfGeom = combinePolygonFeatures(turfPolys);
    turfGeom = safeIntersectFeature(turfGeom, boundaryFeature);
    if (!turfGeom) {
      const nextEmpty = { ...layerFeaturesRef.current, turf: [] };
      layerFeaturesRef.current = nextEmpty;
      setLayerFeatures(nextEmpty);
      reloadDrawForActiveLayer(nextEmpty, layerVisibleRef.current);
      pushToast("Turf cleanup removed all turf outside boundary.", "info", 5000);
      return;
    }

    const map = mapRef.current;
    const buildingPolys = [];
    if (map && map.getSource("streets")) {
      let buildingFeatures = [];
      try {
        buildingFeatures = map.querySourceFeatures("streets", { sourceLayer: "building" }) || [];
      } catch {
        buildingFeatures = [];
      }
      const seen = new Set();
      for (const f of buildingFeatures) {
        if (!isPolygonLike(f)) continue;
        const key =
          `${f.id != null ? String(f.id) : ""}|` +
          JSON.stringify(f.geometry?.coordinates?.[0]?.[0] || []);
        if (seen.has(key)) continue;
        seen.add(key);
        const clipped = safeIntersectFeature(to2DFeature({
          type: "Feature",
          geometry: f.geometry,
          properties: f.properties || {},
        }), boundaryFeature);
        if (!clipped || !isPolygonLike(clipped)) continue;
        if (featureSqft(clipped) < 20) continue;
        buildingPolys.push(clipped);
      }
    }

    const buildingGeom = combinePolygonFeatures(buildingPolys);
    if (buildingGeom) {
      turfGeom = subtractFeatureAllowEmpty(turfGeom, buildingGeom);
    }

    const plowableGeom = combinePolygonFeatures(
      (layerFeaturesRef.current.plowable || [])
        .map((f) => to2DFeature(f))
        .filter((f) => isPolygonLike(f))
    );
    if (plowableGeom) {
      turfGeom = subtractFeatureAllowEmpty(turfGeom, plowableGeom);
    }

    const sidewalksGeom = combinePolygonFeatures(
      (layerFeaturesRef.current.sidewalks || [])
        .map((f) => to2DFeature(f))
        .filter((f) => isPolygonLike(f))
    );
    if (sidewalksGeom) {
      turfGeom = subtractFeatureAllowEmpty(turfGeom, sidewalksGeom);
    }

    const MIN_TURF_PATCH_SQFT = 60;
    const cleanedTurf = polygonFeatureParts(turfGeom)
      .filter((f) => featureSqft(f) >= MIN_TURF_PATCH_SQFT)
      .map((f, idx) =>
        normalizeFeature("turf", {
          ...to2DFeature(f),
          id: `turf-clean-${Date.now()}-${idx + 1}`,
          properties: {
            ...(f.properties || {}),
            name: `Turf ${idx + 1}`,
            layer: "turf",
          },
        })
      );

    const nextFeatures = {
      ...layerFeaturesRef.current,
      turf: cleanedTurf,
    };
    const nextVisible = {
      ...layerVisibleRef.current,
      turf: true,
    };
    layerFeaturesRef.current = nextFeatures;
    layerVisibleRef.current = nextVisible;
    setLayerFeatures(nextFeatures);
    setLayerVisible(nextVisible);
    reloadDrawForActiveLayer(nextFeatures, nextVisible);
    pushToast(
      `Turf cleanup complete. Turf polygons: ${cleanedTurf.length}.`,
      "info",
      5000
    );
  }, [boundary, normalizeFeature, pushToast, reloadDrawForActiveLayer]);

  const resolveOverlapsPlowablePriority = useCallback(() => {
    const current = layerFeaturesRef.current;
    const boundaryFeature =
      boundary && isPolygonLike(boundary) ? to2DFeature(boundary) : null;
    const priority = ["plowable", "sidewalks", "mulch", "turf"];
    const next = {
      plowable: [],
      sidewalks: [],
      turf: [],
      mulch: [],
    };
    const blockers = [];
    let idCounter = 0;

    const beforeTotal = LAYER_KEYS.reduce(
      (sum, key) => sum + ((current[key] || []).length || 0),
      0
    );

    for (const layerKey of priority) {
      const rawFeatures = (current[layerKey] || [])
        .map((f) => to2DFeature(f))
        .filter((f) => isPolygonLike(f));
      for (const raw of rawFeatures) {
        let candidates = polygonFeatureParts(raw);
        if (!candidates.length) continue;

        if (boundaryFeature) {
          const clippedCandidates = [];
          for (const c of candidates) {
            const clipped = safeIntersectFeature(c, boundaryFeature);
            if (!clipped || !isPolygonLike(clipped)) continue;
            clippedCandidates.push(...polygonFeatureParts(clipped));
          }
          candidates = clippedCandidates;
          if (!candidates.length) continue;
        }

        for (const blocker of blockers) {
          const nextCandidates = [];
          for (const candidate of candidates) {
            const diff = subtractFeatureAllowEmpty(candidate, blocker);
            if (!diff || !isPolygonLike(diff)) continue;
            nextCandidates.push(...polygonFeatureParts(diff));
          }
          candidates = nextCandidates;
          if (!candidates.length) break;
        }

        for (const candidate of candidates) {
          if (featureSqft(candidate) < 6) continue;
          idCounter += 1;
          const normalized = normalizeFeature(layerKey, {
            ...candidate,
            id: `prio-${layerKey}-${Date.now()}-${idCounter}`,
            properties: {
              ...(candidate.properties || {}),
              ...(raw.properties || {}),
              layer: layerKey,
            },
          });
          next[layerKey].push(normalized);
          blockers.push(normalized);
        }
      }
    }

    const afterTotal = LAYER_KEYS.reduce(
      (sum, key) => sum + ((next[key] || []).length || 0),
      0
    );

    layerFeaturesRef.current = next;
    setLayerFeatures(next);
    reloadDrawForActiveLayer(next, layerVisibleRef.current);

    if (beforeTotal === afterTotal) {
      pushToast("Overlap check complete. Plowable priority applied.", "info", 4500);
      return;
    }
    pushToast(
      `Overlap fix complete. Plowable kept priority. Polygons: ${beforeTotal} -> ${afterTotal}.`,
      "info",
      5500
    );
  }, [boundary, normalizeFeature, pushToast, reloadDrawForActiveLayer]);

  const onUpload = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const geo = await loadKmlOrKmz(file);
        const poly = geo.features.find(
          (f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon"
        );
        if (!poly) {
          pushToast("No polygon boundary found in that KML/KMZ.", "error", 6000);
          return;
        }
        setBoundary(to2DFeature(poly));
        setDrawingBoundary(false);
        drawingBoundaryRef.current = false;

        if (!projectName.trim()) {
          setProjectName(file.name.replace(/\.(kml|kmz)$/i, ""));
        }

        pushToast("Boundary loaded.", "info");
      } catch (err) {
        console.error(err);
        pushToast("Failed to load that KML/KMZ file.", "error", 6000);
      }
    },
    [projectName, pushToast]
  );

  // Combined geojson for KML export
  const combinedLayerGeoJSON = useMemo(() => {
    const features = [];
    for (const k of LAYER_KEYS) {
      for (const f of layerFeatures[k] || []) {
        features.push({
          ...f,
          properties: { ...(f.properties || {}), layer: k },
        });
      }
    }
    return features;
  }, [layerFeatures]);

  // Totals per layer
  const totals = useMemo(() => {
    const out = {};
    for (const k of LAYER_KEYS) {
      let sqm = 0;
      for (const f of layerFeatures[k] || []) {
        try {
          sqm += turf.area(f);
        } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
      }
      const sqft = sqm * SQM_TO_SQFT;
      out[k] = { sqft: Math.round(sqft), acres: sqft / 43560 };
    }
    return out;
  }, [layerFeatures]);

  // Rows for polygon list export
  const polygonRows = useMemo(() => {
    const rows = [];

    for (const layerKey of LAYER_KEYS) {
      for (const f of layerFeatures[layerKey] || []) {
        if (!isPolygonLike(f)) continue;

        const sqft = featureSqft(f);
        const acres = sqft / 43560;

        rows.push({
          layer: LAYER_META[layerKey].name,
          name: f.properties?.name || "(unnamed)",
          sqft: Math.round(sqft),
          acres: Number(acres.toFixed(4)),
          id: f.id || "",
          outside: !!f.properties?.outside,
        });
      }
    }

    rows.sort((a, b) => (a.layer + a.name).localeCompare(b.layer + b.name));
    return rows;
  }, [layerFeatures]);

  const estimateTemplateTokens = useMemo(
    () => buildEstimateTemplateTokens(projectName, totals),
    [projectName, totals]
  );

  const qcSummary = useMemo(() => {
    const all = [];
    for (const key of LAYER_KEYS) {
      for (const feature of layerFeatures[key] || []) {
        if (!isPolygonLike(feature)) continue;
        all.push({ layer: key, feature });
      }
    }

    let outsideCount = 0;
    let tinyCount = 0;
    let invalidAreaCount = 0;
    for (const item of all) {
      const f = item.feature;
      const outside = boundary ? isOutsideBoundary(f, boundary) : !!f?.properties?.outside;
      if (outside) outsideCount += 1;
      const sqft = featureSqft(f);
      if (!Number.isFinite(sqft) || sqft <= 0) invalidAreaCount += 1;
      if (Number.isFinite(sqft) && sqft > 0 && sqft < TINY_POLYGON_SQFT) tinyCount += 1;
    }

    let overlapCount = 0;
    let overlapSqft = 0;
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const left = all[i].feature;
        const right = all[j].feature;
        const inter = safeIntersectFeature(left, right);
        if (!inter || !isPolygonLike(inter)) continue;
        const area = featureSqft(inter);
        if (!Number.isFinite(area) || area <= 1) continue;
        overlapCount += 1;
        overlapSqft += area;
      }
    }

    return {
      polygons: all.length,
      overlaps: overlapCount,
      overlapSqft: Math.round(overlapSqft),
      outside: outsideCount,
      tiny: tinyCount,
      invalidArea: invalidAreaCount,
    };
  }, [boundary, layerFeatures]);

  const qcHasIssues = useMemo(
    () =>
      qcSummary.overlaps > 0 ||
      qcSummary.outside > 0 ||
      qcSummary.tiny > 0 ||
      qcSummary.invalidArea > 0,
    [qcSummary]
  );

  const activeLearningQueue = useMemo(() => {
    const asText = (value) =>
      String(value || "")
        .trim()
        .toLowerCase();

    return (measurementHistory || [])
      .map((item) => {
        const confidence = Number(item?.confidence || 0);
        const notes = Array.isArray(item?.notes) ? item.notes : [];
        const notesBlob = notes.map((note) => asText(note)).join(" | ");
        let penalty = 0;
        if (notesBlob.includes("fallback")) penalty += 0.28;
        if (notesBlob.includes("degenerate")) penalty += 0.22;
        if (notesBlob.includes("no polygons")) penalty += 0.22;
        if (notesBlob.includes("failed")) penalty += 0.18;
        if (notesBlob.includes("heuristic")) penalty += 0.1;
        const score = (1 - Math.max(0, Math.min(1, confidence))) + penalty;
        return {
          id: item?.id,
          measurementType: item?.measurement_type,
          confidence,
          notes,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [measurementHistory]);

  // ---------- Map init ----------
  useEffect(() => {
    if (!isWorkspaceScreen) return;
    if (!mapDivRef.current) return;

    if (!maptilerKey) {
      console.error(
        "Missing VITE_MAPTILER_KEY in .env. Restart npm run dev after adding it."
      );
      pushToast("Missing MapTiler key (VITE_MAPTILER_KEY).", "error", 8000);
      return;
    }

    const AZURE_API_VERSION = "2024-04-01";
    const AZURE_MAX_ZOOM = 19;

    const map = new maplibregl.Map({
      container: mapDivRef.current,
      antialias: true,
      // iPad/Safari: keep one-finger map pan enabled.
      cooperativeGestures: false,
      // Required for reliable canvas exports (training ZIP / CV snapshot).
      // Without this, WebGL snapshots can be all-black on some GPUs/browsers.
      preserveDrawingBuffer: true,
      style: {
        version: 8,
        sources: {
          // MapTiler Satellite
          mt_sat: {
            type: "raster",
            url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${maptilerKey}`,
            tileSize: 256,
            attribution: "© MapTiler © OpenStreetMap contributors",
          },
          // Vector tiles for buildings (OpenMapTiles schema)
          streets: {
            type: "vector",
            url: `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${maptilerKey}`,
            attribution: "© MapTiler © OpenStreetMap contributors",
          },
          ...(mapboxToken
            ? {
                mb_sat: {
                  type: "raster",
                  tiles: [
                    `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${mapboxToken}`,
                  ],
                  tileSize: 256,
                  attribution: "© Mapbox © OpenStreetMap",
                },
              }
            : {}),
          ...(azureMapsKey
            ? {
                az_imagery: {
                  type: "raster",
                  tiles: [
                    `https://atlas.microsoft.com/map/tile?api-version=${AZURE_API_VERSION}&tilesetId=microsoft.imagery&zoom={z}&x={x}&y={y}&tileSize=256&subscription-key=${azureMapsKey}`,
                  ],
                  tileSize: 256,
                  maxzoom: AZURE_MAX_ZOOM,
                  attribution: "© Microsoft Azure Maps",
                },
                az_hybrid_road: {
                  type: "raster",
                  tiles: [
                    `https://atlas.microsoft.com/map/tile?api-version=${AZURE_API_VERSION}&tilesetId=microsoft.base.hybrid.road&zoom={z}&x={x}&y={y}&tileSize=256&subscription-key=${azureMapsKey}`,
                  ],
                  tileSize: 256,
                  maxzoom: AZURE_MAX_ZOOM,
                  attribution: "© Microsoft Azure Maps",
                },
              }
            : {}),
        },
        layers: [
          {
            id: "bm-empty",
            type: "background",
            layout: { visibility: "none" },
            paint: { "background-color": "#0b0b0b" },
          },
          { id: "bm-maptiler", type: "raster", source: "mt_sat" },
          ...(mapboxToken
            ? [
                {
                  id: "bm-mapbox",
                  type: "raster",
                  source: "mb_sat",
                  layout: { visibility: "none" },
                },
              ]
            : []),
          ...(azureMapsKey
            ? [
                {
                  id: "bm-azure",
                  type: "raster",
                  source: "az_imagery",
                  layout: { visibility: "none" },
                },
                {
                  id: "bm-azure-hybrid",
                  type: "raster",
                  source: "az_hybrid_road",
                  layout: { visibility: "none" },
                  paint: { "raster-opacity": 0.95 },
                },
              ]
            : []),
          // Optional 3D buildings
          {
            id: "3d-buildings",
            type: "fill-extrusion",
            source: "streets",
            "source-layer": "building",
            minzoom: 14,
            paint: {
              "fill-extrusion-height": [
                "coalesce",
                ["to-number", ["get", "height"]],
                15,
              ],
              "fill-extrusion-base": [
                "coalesce",
                ["to-number", ["get", "min_height"]],
                0,
              ],
              "fill-extrusion-opacity": 0.75,
            },
          },
        ],
      },
      center: [-75.0, 40.0],
      zoom: 16,
      pitch: 0,
      bearing: 0,
    });

    // Extra guard for iPad Safari so touch drag pans map instead of page.
    const canvasContainer = map.getCanvasContainer?.();
    if (canvasContainer) {
      canvasContainer.style.touchAction = "none";
      canvasContainer.style.webkitTouchCallout = "none";
      canvasContainer.style.webkitUserSelect = "none";
      canvasContainer.style.userSelect = "none";
    }

    // MapboxDraw expects mapboxgl global; MapLibre works if we point it here
    window.mapboxgl = maplibregl;

    // Build draw style expressions from LAYER_COLORS
    const drawLayerExpr = ["coalesce", ["get", "user_layer"], ["get", "layer"]];
    const layerFill = ["match", drawLayerExpr];
    const layerLine = ["match", drawLayerExpr];
    for (const k of LAYER_KEYS) {
      layerFill.push(k, LAYER_COLORS[k].fill);
      layerLine.push(k, LAYER_COLORS[k].line);
    }
    layerFill.push("#ff0000");
    layerLine.push("#ffffff");

    const baseStyles = MapboxDraw.styles;
    const drawStyles = Array.isArray(baseStyles)
      ? baseStyles.map((s) => {
          const fixed = { ...s, paint: fixDashArrayPaint(s.paint) };

          if (
            typeof fixed.id === "string" &&
            fixed.id.startsWith("gl-draw-polygon-fill")
          ) {
            return {
              ...fixed,
              paint: {
                ...fixed.paint,
                "fill-color": layerFill,
                "fill-opacity": 0,
              },
            };
          }
          if (
            typeof fixed.id === "string" &&
            fixed.id.startsWith("gl-draw-lines")
          ) {
            return {
              ...fixed,
              paint: {
                ...fixed.paint,
                "line-color": layerLine,
                "line-width": 2,
                "line-opacity": 0.2,
                "line-dasharray": ["literal", [1, 0]],
              },
            };
          }
          return fixed;
        })
      : null;

    const baseDrawModes = MapboxDraw.modes || {};
    const touchPanDrawPolygonMode = createTouchPanDrawPolygonMode(baseDrawModes.draw_polygon, {
      stylusOnlyRef: applePencilModeRef,
    });
    const drawModes = touchPanDrawPolygonMode
      ? { ...baseDrawModes, draw_polygon: touchPanDrawPolygonMode }
      : baseDrawModes;

    const draw = new MapboxDraw({
      userProperties: true,
      displayControlsDefault: false,
      controls: { polygon: true, trash: false },
      ...(drawModes ? { modes: drawModes } : {}),
      ...(drawStyles ? { styles: drawStyles } : {}),
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(draw, "top-right");

    // draw change events -> sync -> outlines refresh (throttled)
    const onChange = (event) => {
      if (suppressDrawSyncRef.current) return;
      const eventType = String(event?.type || "");
      const isDrawCreateEvent = eventType === "draw.create";
      const currentWorkflow = workflowModeRef.current;
      const pdfTool = pdfAnnotationToolRef.current;
      const isPdfAnnotationTool =
        pdfTool === "pen" || pdfTool === "marker" || pdfTool === "shape";
      if (currentWorkflow === WORKFLOW_MODE_PDF && isPdfAnnotationTool) {
        // In PDF mode, only capture completed features. Handling draw.update
        // here interrupts line/polygon creation before users can finish.
        if (!isDrawCreateEvent) return;
        const incoming = Array.isArray(event?.features) ? event.features : [];
        const expectedGeometry = pdfTool === "shape" ? "Polygon" : "LineString";
        const drawnFeature = incoming.find(
          (feature) => feature?.geometry?.type === expectedGeometry
        );
        if (drawnFeature) {
          const drawnGeometry = to2DFeature(drawnFeature)?.geometry || null;
          const lineCoords =
            drawnGeometry?.type === "LineString" ? drawnGeometry.coordinates : null;
          const polygonRings =
            drawnGeometry?.type === "Polygon" ? drawnGeometry.coordinates : null;
          const isValidLine =
            Array.isArray(lineCoords) && lineCoords.length >= 2;
          const isValidPolygon =
            Array.isArray(polygonRings) &&
            Array.isArray(polygonRings[0]) &&
            polygonRings[0].length >= 4;
          if (
            (pdfTool === "shape" && !isValidPolygon) ||
            (pdfTool !== "shape" && !isValidLine)
          ) {
            return;
          }
          const baseColor = normalizeHexColor(
            pdfAnnotationColorRef.current,
            PDF_ANNOT_DEFAULT_COLOR
          );
          const baseWidthRaw = Number(pdfAnnotationWidthRef.current);
          const baseWidth = Number.isFinite(baseWidthRaw)
            ? Math.max(1, Math.min(30, baseWidthRaw))
            : 4;
          const annotationWidth = pdfTool === "marker" ? Math.max(8, baseWidth * 2) : baseWidth;
          const annotationFeature = normalizePdfAnnotationFeature(
            {
              type: "Feature",
              properties: {
                kind: pdfTool,
                color: baseColor,
                fillColor: baseColor,
                width: annotationWidth,
                opacity: pdfTool === "marker" ? 0.35 : 1,
                fillOpacity: pdfTool === "shape" ? 0.2 : 0,
              },
              geometry: drawnGeometry,
            },
            0
          );
          if (annotationFeature) {
            setPdfAnnotations((prev) => [
              ...(Array.isArray(prev) ? prev : []),
              annotationFeature,
            ]);
          }
          try {
            if (drawnFeature.id) draw.delete(drawnFeature.id);
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
          try {
            draw.changeMode(
              pdfTool === "shape" ? "draw_polygon" : "draw_line_string"
            );
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
          return;
        }
      }
      if (drawingBoundaryRef.current) {
        const incoming = Array.isArray(event?.features) ? event.features : [];
        const drawnPoly = incoming.find((f) => isPolygonLike(f));
        if (!drawnPoly) return;

        const nextBoundary = to2DFeature({
          type: "Feature",
          geometry: drawnPoly.geometry,
          properties: { ...(drawnPoly.properties || {}), lookup_source: "manual_draw" },
        });
        setBoundary(nextBoundary);
        setDrawingBoundary(false);
        drawingBoundaryRef.current = false;

        try {
          if (drawnPoly.id) draw.delete(drawnPoly.id);
          draw.changeMode("simple_select");
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
        reloadDrawForActiveLayer(layerFeaturesRef.current, layerVisibleRef.current);
        pushToast("Boundary updated from drawn polygon.", "info", 5000);
        ensureDrawBorderLayers();
        refreshPolygonOutlinesRaf();
        return;
      }
      if (turfEraseModeRef.current) {
        const incoming = Array.isArray(event?.features) ? event.features : [];
        const drawnPoly = incoming.find((f) => isPolygonLike(f));
        if (!drawnPoly) return;

        turfEraseModeRef.current = false;
        setTurfEraseMode(false);
        try {
          if (drawnPoly.id) draw.delete(drawnPoly.id);
          draw.changeMode("simple_select");
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }

        const eraseFeature = to2DFeature({
          type: "Feature",
          geometry: drawnPoly.geometry,
          properties: {},
        });
        const existingTurf = (layerFeaturesRef.current.turf || [])
          .map((f) => to2DFeature(f))
          .filter((f) => isPolygonLike(f));
        if (!existingTurf.length) {
          pushToast("No turf polygons to erase.", "warn");
          reloadDrawForActiveLayer(layerFeaturesRef.current, layerVisibleRef.current);
          return;
        }

        const turfGeom = combinePolygonFeatures(existingTurf);
        const remaining = subtractFeatureAllowEmpty(turfGeom, eraseFeature);
        const kept = polygonFeatureParts(remaining)
          .filter((f) => featureSqft(f) >= 8)
          .map((f, idx) => ({
            ...to2DFeature(f),
            id: `turf-${Date.now()}-${idx + 1}`,
            properties: {
              ...(f.properties || {}),
              name: `Turf ${idx + 1}`,
              layer: "turf",
              outside: false,
            },
          }));

        const next = {
          ...layerFeaturesRef.current,
          turf: kept,
        };
        const nextVisible = {
          ...layerVisibleRef.current,
          turf: true,
        };
        layerFeaturesRef.current = next;
        layerVisibleRef.current = nextVisible;
        setLayerFeatures(next);
        setLayerVisible(nextVisible);
        reloadDrawForActiveLayer(next, nextVisible);
        pushToast(`Turf erase applied. Remaining turf polygons: ${kept.length}.`, "info", 4500);
        ensureDrawBorderLayers();
        refreshPolygonOutlinesRaf();
        return;
      }
      syncFromDraw(draw);
      ensureDrawBorderLayers();
      refreshPolygonOutlinesRaf();
    };

    map.on("draw.create", onChange);
    map.on("draw.update", onChange);

    // Editing detection + draw mode indicator
    map.on("draw.modechange", (e) => {
      const mode = e?.mode || "";
      setDrawMode(mode || "simple_select");
      setIsEditing(mode !== "simple_select");
      ensureDrawBorderLayers();
      refreshDrawStrokeWidths();
      refreshPolygonOutlinesRaf();
    });

    map.on("draw.selectionchange", () => {
      try {
        const mode = draw.getMode?.() || "simple_select";
        setDrawMode(mode);
        setIsEditing(mode !== "simple_select");
      } catch {
      /* intentionally ignore non-critical map/draw errors */
      }
      ensureDrawBorderLayers();
      refreshDrawStrokeWidths();
      refreshPolygonOutlinesRaf();
    });

    const onMapClickMeasure = (e) => {
      if (
        workflowModeRef.current === WORKFLOW_MODE_PDF &&
        pdfAnnotationToolRef.current === "text"
      ) {
        addPdfTextAnnotationAt(e.lngLat, pdfAnnotationTextDraftRef.current);
        return;
      }
      if (!measureModeRef.current) return;
      const mapNow = mapRef.current;
      if (!mapNow) return;
      const nextPoint = [e.lngLat.lng, e.lngLat.lat];

      setMeasurePoints((prev) => {
        const next = prev.length >= 2 ? [nextPoint] : [...prev, nextPoint];
        if (next.length === 2) {
          setMeasureResult(computeTwoPointMeasure(mapNow, next));
        } else {
          setMeasureResult(null);
        }
        return next;
      });
    };
    map.on("click", onMapClickMeasure);

    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();

    map.on("load", async () => {
      if (!map.getSource(MEASURE_SOURCE_ID)) {
        map.addSource(MEASURE_SOURCE_ID, {
          type: "geojson",
          data: buildMeasureFeatureCollection([]),
        });
      }
      if (!map.getLayer(MEASURE_LINE_LAYER_ID)) {
        map.addLayer({
          id: MEASURE_LINE_LAYER_ID,
          type: "line",
          source: MEASURE_SOURCE_ID,
          filter: ["==", ["get", "role"], "line"],
          paint: {
            "line-color": "#ffffff",
            "line-width": 2.5,
            "line-opacity": 0.95,
          },
        });
      }
      if (!map.getLayer(MEASURE_POINT_LAYER_ID)) {
        map.addLayer({
          id: MEASURE_POINT_LAYER_ID,
          type: "circle",
          source: MEASURE_SOURCE_ID,
          filter: ["==", ["get", "role"], "point"],
          paint: {
            "circle-radius": 5,
            "circle-color": "#111111",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
        });
      }
      ensurePdfAnnotationLayers(map);
      refreshPdfAnnotationsSource(pdfAnnotationsRef.current);

      if (googleMapsKey) {
        try {
          await ensureGoogleBasemapLayer(map);
        } catch (error) {
          pushToast(
            `Google basemap unavailable: ${error?.message || "tiles setup failed"}.`,
            "warn",
            6000
          );
        }
      }

      // Apply initial baseMap selection
      const initialBaseMap =
        workflowModeRef.current === WORKFLOW_MODE_PDF
          ? "none"
          : baseMapRef.current || "maptiler";
      applyBaseMapVisibility(
        map,
        initialBaseMap,
        !!azureHybridLabelsRef.current
      );
      applyPlanOverlayMode(
        map,
        planOverlayEnabledRef.current,
        planOverlayRef.current,
        planOverlayOpacityRef.current
      );
      applyObject3dMode(
        map,
        ENABLE_OBJECTS_3D ? objects3dRef.current : false,
        objects3dOpacityRef.current
      );
      applyTerrainMode(
        map,
        ENABLE_TRUE_TERRAIN ? terrain3dRef.current : false,
        terrainExaggerationRef.current
      );
      ensureDrawBorderLayers();
      refreshDrawStrokeWidths();
      refreshPolygonOutlinesRaf();
      if (pendingProjectFitRef.current) {
        const p = pendingProjectFitRef.current;
        fitMapToProject(p.boundary, p.layers);
        pendingProjectFitRef.current = null;
      }
    });

    let azureTileErrorHandled = false;
    let googleTileErrorHandled = false;
    const onMapError = (event) => {
      const sourceId = event?.sourceId || event?.source?.id || "";
      const sourceName = String(sourceId).toLowerCase();
      const isAzureSource =
        sourceName.includes("az_imagery") || sourceName.includes("az_hybrid_road");
      const isGoogleSource = sourceName.includes("google_sat");

      if (isAzureSource && !azureTileErrorHandled) {
        azureTileErrorHandled = true;
        setAzureHybridLabels(false);
        setBaseMap("maptiler");
        pushToast(
          "Azure aerial tiles failed to load (usually key/domain restriction). Switched to MapTiler.",
          "warn",
          7000
        );
        return;
      }

      if (isGoogleSource && !googleTileErrorHandled) {
        googleTileErrorHandled = true;
        googleTileSessionRef.current = null;
        googleTileSessionExpiryRef.current = 0;
        setBaseMap("maptiler");
        pushToast(
          "Google basemap tiles failed to load. Check Google Map Tiles API and key restrictions. Switched to MapTiler.",
          "warn",
          7000
        );
      }
    };
    map.on("error", onMapError);

    mapRef.current = map;
    drawRef.current = draw;

    return () => {
      try {
        map.off("draw.create", onChange);
        map.off("draw.update", onChange);
        map.off("click", onMapClickMeasure);
        map.off("error", onMapError);
      } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
      mapRef.current = null;
      drawRef.current = null;
      map.remove();
    };
    // Effect intentionally re-runs on home<->workspace transitions only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ensurePdfAnnotationLayers,
    isWorkspaceScreen,
    maptilerKey,
    pushToast,
    refreshPdfAnnotationsSource,
  ]);

  // React to basemap changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    const run = async () => {
      if (!map.isStyleLoaded?.()) return;
      if (effectiveBaseMap === "google") {
        try {
          const ok = await ensureGoogleBasemapLayer(map);
          if (!ok || !map.getLayer("bm-google")) {
            throw new Error("Google basemap layer did not initialize.");
          }
        } catch (error) {
          if (!cancelled) {
            pushToast(
              `Google basemap unavailable: ${error?.message || "tiles setup failed"}.`,
              "warn",
              6000
            );
            setBaseMap("maptiler");
          }
          return;
        }
      }
      if (!cancelled) {
        applyBaseMapVisibility(map, effectiveBaseMap, azureHybridLabels);
        if (effectiveBaseMap === "google") {
          try {
            if (map.getLayer("bm-maptiler")) {
              map.setLayoutProperty("bm-maptiler", "visibility", "none");
            }
            if (map.getLayer("bm-google")) {
              map.setLayoutProperty("bm-google", "visibility", "visible");
            }
            map.triggerRepaint?.();
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
        }
      }
    };
    if (!map.isStyleLoaded?.()) {
      const onLoad = () => {
        run();
      };
      map.once("load", onLoad);
      return () => {
        cancelled = true;
        try {
          map.off("load", onLoad);
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
      };
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [
    applyBaseMapVisibility,
    azureHybridLabels,
    effectiveBaseMap,
    ensureGoogleBasemapLayer,
    pushToast,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyPlanOverlayMode(map, planOverlayEnabled, planOverlay, planOverlayOpacity);
  }, [applyPlanOverlayMode, planOverlayEnabled, planOverlay, planOverlayOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyTerrainMode(map, ENABLE_TRUE_TERRAIN ? terrain3d : false, terrainExaggeration);
  }, [applyTerrainMode, terrain3d, terrainExaggeration]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyObject3dMode(map, ENABLE_OBJECTS_3D ? objects3d : false, objects3dOpacity);
  }, [applyObject3dMode, objects3d, objects3dOpacity]);

  useEffect(() => {
    updateMeasureOverlay(measurePoints);
  }, [measurePoints, updateMeasureOverlay]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || measurePoints.length !== 2) return;
    const onMove = () => {
      setMeasureResult(computeTwoPointMeasure(map, measurePoints));
    };
    map.on("move", onMove);
    return () => map.off("move", onMove);
  }, [measurePoints]);

  // Autosave draft availability on startup.
  useEffect(() => {
    try {
      setAutosaveDraftAvailable(!!localStorage.getItem(AUTOSAVE_KEY));
    } catch {
      setAutosaveDraftAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (!aiEnabled) return;
    refreshMeasurementHistory();
  }, [aiEnabled, refreshMeasurementHistory]);

  // Autosave every 30s while editing.
  useEffect(() => {
    const id = setInterval(() => {
      try {
        const payload = { ...buildProjectPayload(), autosavedAt: new Date().toISOString() };
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
        setAutosaveDraftAvailable(true);
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
    }, 30000);
    return () => clearInterval(id);
  }, [buildProjectPayload]);

  // Write an autosave snapshot when tab/window closes.
  useEffect(() => {
    const onBeforeUnload = (event) => {
      try {
        const payload = { ...buildProjectPayload(), autosavedAt: new Date().toISOString() };
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [buildProjectPayload, hasUnsavedChanges]);

  // Keyboard shortcuts:
  // P = draw polygon, Esc = select mode, Delete/Backspace = delete selected, 1-4 = switch layer
  useEffect(() => {
    const onKeyDown = (e) => {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;
      const shiftedQuestion = e.key === "?" || (e.key === "/" && e.shiftKey);
      if (
        isWorkspaceScreen &&
        cmdOrCtrl &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "k" || e.key === "K")
      ) {
        e.preventDefault();
        setShowShortcutHelp(false);
        setShowCommandPalette(true);
        return;
      }
      if (
        isWorkspaceScreen &&
        !cmdOrCtrl &&
        !e.altKey &&
        shiftedQuestion
      ) {
        e.preventDefault();
        setShowCommandPalette(false);
        setShowShortcutHelp((prev) => !prev);
        return;
      }
      if (showCommandPalette && e.key === "Escape") {
        e.preventDefault();
        setShowCommandPalette(false);
        setCommandPaletteQuery("");
        setCommandPaletteIndex(0);
        return;
      }
      if (showShortcutHelp && e.key === "Escape") {
        e.preventDefault();
        setShowShortcutHelp(false);
        return;
      }

      const target = e.target;
      const tag = target?.tagName?.toLowerCase?.();
      const typing =
        tag === "input" ||
        tag === "textarea" ||
        target?.isContentEditable;
      if (typing) return;

      const d = drawRef.current;
      if (!d) return;
      if (
        cmdOrCtrl &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "z" || e.key === "Z")
      ) {
        e.preventDefault();
        undoLayerEdit();
        return;
      }
      if (
        cmdOrCtrl &&
        !e.altKey &&
        ((e.shiftKey && (e.key === "z" || e.key === "Z")) || e.key === "y" || e.key === "Y")
      ) {
        e.preventDefault();
        redoLayerEdit();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        saveProject();
        return;
      }

      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        try {
          d.changeMode("draw_polygon");
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (drawingBoundaryRef.current) {
          drawingBoundaryRef.current = false;
          setDrawingBoundary(false);
        }
        if (turfEraseModeRef.current) {
          turfEraseModeRef.current = false;
          setTurfEraseMode(false);
        }
        try {
          d.changeMode("simple_select");
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelectedFeatures();
        return;
      }

      if (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") {
        e.preventDefault();
        const idx = Number(e.key) - 1;
        const layer = LAYER_KEYS[idx];
        if (layer) switchActiveLayer(layer);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    deleteSelectedFeatures,
    isWorkspaceScreen,
    redoLayerEdit,
    saveProject,
    switchActiveLayer,
    showCommandPalette,
    showShortcutHelp,
    undoLayerEdit,
  ]);

  // 3D camera for review/terrain
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!map.isStyleLoaded()) return;

    try {
      const terrainOn = ENABLE_TRUE_TERRAIN && terrain3d;
      const objectsOn = ENABLE_OBJECTS_3D && objects3d;
      const use3dCamera = review3d || terrainOn || objectsOn;
      const targetPitch = terrainOn ? 68 : use3dCamera ? 60 : 0;
      const targetBearing = use3dCamera ? 20 : 0;
      map.easeTo({
        pitch: targetPitch,
        bearing: targetBearing,
        duration: 350,
      });
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
  }, [objects3d, review3d, terrain3d]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const canvasContainer = map.getCanvasContainer?.();
    if (!canvasContainer) return;
    if (isCompactTouchUi && drawMode === "simple_select") {
      canvasContainer.style.touchAction = "pan-x pan-y pinch-zoom";
    } else {
      canvasContainer.style.touchAction = "none";
    }
  }, [drawMode, isCompactTouchUi]);

  // Keep draw in sync when switching layers/visibility.
  useEffect(() => {
    reloadDrawForActiveLayer();
  }, [activeLayer, layerVisible, reloadDrawForActiveLayer]);

  // Guarantee non-active layer overlays redraw on layer switch.
  useEffect(() => {
    refreshPolygonOutlinesRaf();
    ensureDrawBorderLayers();
  }, [activeLayer, ensureDrawBorderLayers, refreshPolygonOutlinesRaf]);

  // Keep outlines updated (throttled)
  useEffect(() => {
    refreshPolygonOutlinesRaf();
  }, [layerFeatures, layerVisible, boundary, isEditing, refreshPolygonOutlinesRaf]);

  // Keep MapboxDraw stroke/fill widths in sync with edit mode.
  useEffect(() => {
    refreshDrawStrokeWidths();
  }, [refreshDrawStrokeWidths]);

  // Keep guaranteed draw border overlays in sync with edit mode/style ordering.
  useEffect(() => {
    ensureDrawBorderLayers();
  }, [ensureDrawBorderLayers]);

  // Draw boundary + fit view + outside mask
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !boundary) return;
    if (!map.isStyleLoaded()) return;

    const srcId = "boundary-src";
    const lineId = "boundary-line";
    const fillId = "boundary-fill";

    const maskSrcId = "boundary-mask-src";
    const maskFillId = "boundary-mask-fill";

    // clean old
    for (const id of [maskFillId, fillId, lineId]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of [maskSrcId, srcId]) {
      if (map.getSource(id)) map.removeSource(id);
    }

    const beforeId = getDrawVertexLayerId(map) || undefined;

    if (maskOutsideBoundary) {
      const mask = makeOutsideMask(boundary);
      if (mask) {
        map.addSource(maskSrcId, { type: "geojson", data: mask });
        map.addLayer(
          {
            id: maskFillId,
            type: "fill",
            source: maskSrcId,
            paint: {
              "fill-color": "#000000",
              "fill-opacity": 0.35,
            },
          },
          beforeId
        );
      }
    }

    map.addSource(srcId, { type: "geojson", data: boundary });

    map.addLayer(
      {
        id: fillId,
        type: "fill",
        source: srcId,
        paint: {
          "fill-color": BOUNDARY_COLORS.fill,
          "fill-opacity": 0.08,
        },
      },
      beforeId
    );

    map.addLayer(
      {
        id: lineId,
        type: "line",
        source: srcId,
        paint: {
          "line-width": 5,
          "line-color": BOUNDARY_COLORS.line,
          "line-opacity": 0.95,
        },
      },
      beforeId
    );

    try {
      const bbox = turf.bbox(boundary);
      map.fitBounds(bbox, { padding: 40, duration: 600 });
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }

    refreshPolygonOutlinesRaf();
  }, [boundary, maskOutsideBoundary, refreshPolygonOutlinesRaf]);

  // ---------- UI actions ----------
  const autoMeasureExperimental = useCallback(() => {
    if (!aiEnabled) {
      pushToast("AI features are disabled in review mode.", "warn");
      return;
    }
    if (!boundary) {
      pushToast("Load a property boundary first.", "warn");
      return;
    }

    askConfirm({
      title: "Run AI Takeoff (Stable)",
      message:
        "This will replace current polygons using boundary/vector AI takeoff. Continue?",
      confirmText: "Run AI Takeoff",
      cancelText: "Cancel",
      danger: true,
      onConfirm: async () => {
        setConfirm(null);
        setAutoMeasuring(true);

        try {
          const SIDEWALK_WIDTH_FT = 6;
          const SIDEWALK_WIDTH_M = SIDEWALK_WIDTH_FT * 0.3048;
          const SIDEWALK_CENTERLINE_BUFFER_M = SIDEWALK_WIDTH_M / 2;
          const MULCH_BED_OUTER_FT = 8;
          const MULCH_BED_INNER_FT = 2;
          const MULCH_BED_OUTER_M = MULCH_BED_OUTER_FT * 0.3048;
          const MULCH_BED_INNER_M = MULCH_BED_INNER_FT * 0.3048;
          const MIN_TURF_AREA_SQFT = 120;
          const MIN_TURF_AREA_SQM = MIN_TURF_AREA_SQFT / SQM_TO_SQFT;
          const MIN_MULCH_AREA_SQFT = 40;
          const MIN_MULCH_AREA_SQM = MIN_MULCH_AREA_SQFT / SQM_TO_SQFT;

          let plowableGeom = boundary;
          let sidewalksGeom = null;
          let turfGeom = null;
          let mulchGeom = null;
          let buildingsGeom = null;
          let candidatePlowableGeom = null;
          let candidateSidewalksGeom = null;
          let candidateTurfGeom = null;
          let candidateBuildingsGeom = null;
          let usedBackendClassify = false;

          const safeIntersect = (a, b) => {
            if (!a || !b || !isPolygonLike(a) || !isPolygonLike(b)) return null;
            try {
              const out = turf.intersect(a, b);
              if (out && isPolygonLike(out) && turf.area(out) > 1) return out;
            } catch {
              try {
                const out = turf.intersect(turf.featureCollection([a, b]));
                if (out && isPolygonLike(out) && turf.area(out) > 1) return out;
              } catch {
                /* intentionally ignore non-critical map/draw errors */
              }
            }
            return null;
          };

          const safeDifference = (a, b) => {
            if (!a || !b || !isPolygonLike(a) || !isPolygonLike(b)) return a;
            try {
              const out = turf.difference(a, b);
              if (out && isPolygonLike(out) && turf.area(out) > 1) return out;
            } catch {
              try {
                const out = turf.difference(turf.featureCollection([a, b]));
                if (out && isPolygonLike(out) && turf.area(out) > 1) return out;
              } catch {
                /* intentionally ignore non-critical map/draw errors */
              }
            }
            return a;
          };

          // Experimental turf + building detection via vector source features.
          // This is more stable than canvas color sampling and avoids CORS pixel-read issues.
          try {
            const map = mapRef.current;
            if (map && map.getSource("streets")) {
              const clipToBoundary = (geom) => {
                if (!geom || !isPolygonLike(geom)) return null;
                try {
                  const clipped = turf.intersect(geom, boundary);
                  if (clipped && isPolygonLike(clipped)) return clipped;
                } catch {
                  try {
                    const clipped = turf.intersect(
                      turf.featureCollection([geom, boundary])
                    );
                    if (clipped && isPolygonLike(clipped)) return clipped;
                  } catch {
                    /* intentionally ignore non-critical map/draw errors */
                  }
                }
                return null;
              };

              const combinePolys = (arr) => {
                if (!arr.length) return null;
                if (arr.length === 1) return arr[0];
                try {
                  const combined = turf.combine(turf.featureCollection(arr));
                  return combined?.features?.[0] || null;
                } catch {
                  return null;
                }
              };

              const collectSourcePolys = (sourceLayer, predicate) => {
                let feats = [];
                try {
                  feats = map.querySourceFeatures("streets", { sourceLayer }) || [];
                } catch {
                  feats = [];
                }

                const out = [];
                const seen = new Set();
                for (const f of feats) {
                  if (!isPolygonLike(f)) continue;
                  if (predicate && !predicate(f.properties || {})) continue;
                  const idKey =
                    (f.id != null ? String(f.id) : "") +
                    JSON.stringify(f.geometry?.coordinates?.[0]?.[0] || []);
                  if (seen.has(idKey)) continue;
                  seen.add(idKey);

                  const clipped = clipToBoundary(f);
                  if (clipped && turf.area(clipped) > 1) out.push(clipped);
                }
                return out;
              };

              const collectBufferedLinePolys = (sourceLayer, predicate, bufferM) => {
                let feats = [];
                try {
                  feats = map.querySourceFeatures("streets", { sourceLayer }) || [];
                } catch {
                  feats = [];
                }

                const out = [];
                const seen = new Set();
                for (const f of feats) {
                  const t = f?.geometry?.type;
                  if (t !== "LineString" && t !== "MultiLineString") continue;
                  if (predicate && !predicate(f.properties || {})) continue;

                  const idKey =
                    (f.id != null ? String(f.id) : "") +
                    JSON.stringify(f.geometry?.coordinates?.[0] || []);
                  if (seen.has(idKey)) continue;
                  seen.add(idKey);

                  let buffered = null;
                  try {
                    buffered = turf.buffer(f, bufferM, { units: "meters" });
                  } catch {
                    buffered = null;
                  }
                  if (!buffered || !isPolygonLike(buffered)) continue;

                  const clipped = clipToBoundary(buffered);
                  if (clipped && turf.area(clipped) > 1) out.push(clipped);
                }
                return out;
              };

              const turfClasses = new Set(["grass", "meadow"]);

              const landcoverPolys = collectSourcePolys(
                "landcover",
                (p) => turfClasses.has(String(p.class || p.subclass || "").toLowerCase())
              );
              const buildingPolys = collectSourcePolys("building", () => true);
              const parkingPolys = collectSourcePolys(
                "landuse",
                (p) => String(p.class || p.subclass || "").toLowerCase() === "parking"
              );
              const sidewalkLikeClasses = new Set([
                "path",
                "footway",
                "pedestrian",
                "sidewalk",
                "steps",
              ]);
              const plowableRoadClasses = new Set([
                "motorway",
                "trunk",
                "primary",
                "secondary",
                "tertiary",
                "residential",
                "service",
                "unclassified",
                "road",
                "living_street",
                "track",
              ]);
              const walkwayPolys = collectBufferedLinePolys(
                "transportation",
                (p) =>
                  sidewalkLikeClasses.has(
                    String(p.class || p.subclass || p.type || "").toLowerCase()
                  ),
                SIDEWALK_CENTERLINE_BUFFER_M
              );
              const roadSurfacePolys = collectBufferedLinePolys(
                "transportation",
                (p) =>
                  plowableRoadClasses.has(
                    String(p.class || p.subclass || p.type || "").toLowerCase()
                  ) &&
                  !sidewalkLikeClasses.has(
                    String(p.class || p.subclass || p.type || "").toLowerCase()
                  ),
                4
              );

              const vegetation = combinePolys(landcoverPolys);
              const buildings = combinePolys(buildingPolys);
              const plowableCandidates = combinePolys([...roadSurfacePolys, ...parkingPolys]);
              const sidewalksDetected = combinePolys(walkwayPolys);

              candidatePlowableGeom = plowableCandidates;
              candidateTurfGeom = vegetation;
              candidateBuildingsGeom = buildings;
              candidateSidewalksGeom = sidewalksDetected;

              if (vegetation && isPolygonLike(vegetation) && turf.area(vegetation) >= MIN_TURF_AREA_SQM) {
                turfGeom = vegetation;
              }
              if (sidewalksDetected && isPolygonLike(sidewalksDetected) && turf.area(sidewalksDetected) > 1) {
                sidewalksGeom = sidewalksDetected;
              }

              if (buildings && isPolygonLike(buildings)) {
                buildingsGeom = buildings;
                sidewalksGeom = safeDifference(sidewalksGeom, buildings);
                turfGeom = safeDifference(turfGeom, buildings);
              }
            }
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }

          try {
            const backendClassified = await autoClassifyMeasurement({
              boundaryGeometry: boundary.geometry,
              candidatePlowableGeometry: candidatePlowableGeom?.geometry || null,
              candidateSidewalkGeometry: candidateSidewalksGeom?.geometry || null,
              candidateTurfGeometry: candidateTurfGeom?.geometry || null,
              candidateMulchGeometry: null,
              candidateBuildingsGeometry: candidateBuildingsGeom?.geometry || null,
            });

            const asFeature = (geometry, layerKey) => {
              if (!geometry) return null;
              return {
                type: "Feature",
                geometry,
                properties: { layer: layerKey },
              };
            };

            plowableGeom = asFeature(backendClassified.plowable_geometry, "plowable");
            sidewalksGeom = asFeature(backendClassified.sidewalks_geometry, "sidewalks");
            turfGeom = asFeature(backendClassified.turf_geometry, "turf");
            mulchGeom = asFeature(backendClassified.mulch_geometry, "mulch");
            usedBackendClassify = true;
          } catch (error) {
            pushToast(
              `Backend classify unavailable, using frontend fallback: ${error.message}`,
              "warn",
              5000
            );
          }

          // Avoid counting the same area across categories.
          if (!usedBackendClassify && sidewalksGeom && isPolygonLike(sidewalksGeom) && plowableGeom && isPolygonLike(plowableGeom)) {
            plowableGeom = safeDifference(plowableGeom, sidewalksGeom);
          }

          if (!usedBackendClassify && turfGeom && isPolygonLike(turfGeom) && plowableGeom && isPolygonLike(plowableGeom)) {
            plowableGeom = safeDifference(plowableGeom, turfGeom);
          }

          if (buildingsGeom && isPolygonLike(buildingsGeom) && plowableGeom && isPolygonLike(plowableGeom)) {
            plowableGeom = safeDifference(plowableGeom, buildingsGeom);
          }

          if (!usedBackendClassify && buildingsGeom && isPolygonLike(buildingsGeom)) {
            try {
              let outer = turf.buffer(buildingsGeom, MULCH_BED_OUTER_M, { units: "meters" });
              let inner = turf.buffer(buildingsGeom, MULCH_BED_INNER_M, { units: "meters" });
              if (outer && isPolygonLike(outer)) {
                outer = safeIntersect(outer, boundary) || outer;
              }
              if (inner && isPolygonLike(inner)) {
                inner = safeIntersect(inner, boundary) || inner;
              }
              mulchGeom = safeDifference(outer, inner);
              if (mulchGeom && isPolygonLike(mulchGeom)) {
                mulchGeom = safeDifference(mulchGeom, sidewalksGeom);
                mulchGeom = safeDifference(mulchGeom, turfGeom);
                if (turf.area(mulchGeom) < MIN_MULCH_AREA_SQM) {
                  mulchGeom = null;
                }
              }
            } catch {
              mulchGeom = null;
            }
          }

          if (!usedBackendClassify && mulchGeom && isPolygonLike(mulchGeom) && plowableGeom && isPolygonLike(plowableGeom)) {
            plowableGeom = safeDifference(plowableGeom, mulchGeom);
          }

          const stamp = Date.now();
          const next = {
            plowable: [],
            sidewalks: [],
            turf: [],
            mulch: [],
          };

          const clippedPlowable =
            plowableGeom && isPolygonLike(plowableGeom)
              ? (safeIntersect(plowableGeom, boundary) || null)
              : null;
          const clippedSidewalks =
            sidewalksGeom && isPolygonLike(sidewalksGeom)
              ? (safeIntersect(sidewalksGeom, boundary) || null)
              : null;
          const clippedTurf =
            turfGeom && isPolygonLike(turfGeom)
              ? (safeIntersect(turfGeom, boundary) || null)
              : null;
          const clippedMulch =
            mulchGeom && isPolygonLike(mulchGeom)
              ? (safeIntersect(mulchGeom, boundary) || null)
              : null;

          if (clippedPlowable && isPolygonLike(clippedPlowable)) {
            next.plowable.push(
              normalizeFeature("plowable", {
                ...clippedPlowable,
                id: `auto-plowable-${stamp}`,
                properties: { name: "Auto Plowable 1", layer: "plowable" },
              })
            );
          }

          if (clippedSidewalks && isPolygonLike(clippedSidewalks)) {
            next.sidewalks.push(
              normalizeFeature("sidewalks", {
                ...clippedSidewalks,
                id: `auto-sidewalks-${stamp}`,
                properties: { name: "Auto Sidewalks 1", layer: "sidewalks" },
              })
            );
          } else {
            pushToast(
              "Auto sidewalk detection found no reliable sidewalk features, so none were measured.",
              "warn",
              5000
            );
          }

          if (clippedTurf && isPolygonLike(clippedTurf)) {
            next.turf.push(
              normalizeFeature("turf", {
                ...clippedTurf,
                id: `auto-turf-${stamp}`,
                properties: { name: "Auto Turf 1", layer: "turf" },
              })
            );
          } else {
            pushToast(
              "Auto turf detection could not find reliable turf polygons at this zoom/source.",
              "warn",
              5000
            );
          }

          if (clippedMulch && isPolygonLike(clippedMulch)) {
            next.mulch.push(
              normalizeFeature("mulch", {
                ...clippedMulch,
                id: `auto-mulch-${stamp}`,
                properties: { name: "Auto Mulch 1", layer: "mulch" },
              })
            );
          } else {
            pushToast(
              "Auto mulch detection found no reliable mulch polygons.",
              "warn",
              4000
            );
          }

          setLayerFeatures(next);
          setLayerVisible({
            plowable: true,
            sidewalks: true,
            turf: true,
            mulch: true,
          });
          setActiveLayer("plowable");
          activeLayerRef.current = "plowable";

          reloadDrawForActiveLayer(next, {
            plowable: true,
            sidewalks: true,
            turf: true,
            mulch: true,
          });

          requestAnimationFrame(() => {
            fitMapToProject(boundary, next);
          });

          pushToast(
            "AI Takeoff complete. Review polygons and make quick edits if needed.",
            "info",
            5000
          );
        } finally {
          setAutoMeasuring(false);
        }
      },
    });
  }, [
    aiEnabled,
    askConfirm,
    boundary,
    fitMapToProject,
    normalizeFeature,
    pushToast,
    reloadDrawForActiveLayer,
  ]);

  const clearActiveLayer = useCallback(() => {
    const forceSyncPolygonVisuals = (nextFeatures) => {
      const nextVisible = layerVisibleRef.current;
      try {
        const d = drawRef.current;
        if (d) {
          try {
            d.changeMode("simple_select");
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
          try {
            d.deleteAll();
          } catch {
            /* intentionally ignore non-critical map/draw errors */
          }
        }
      } catch {
        /* intentionally ignore non-critical map/draw errors */
      }

      reloadDrawForActiveLayer(nextFeatures, nextVisible);

      const map = mapRef.current;
      if (map?.isStyleLoaded?.()) {
        const features = [];
        for (const layerKey of LAYER_KEYS) {
          if (!nextVisible?.[layerKey]) continue;
          for (const f of nextFeatures[layerKey] || []) {
            features.push({
              ...f,
              properties: {
                ...(f.properties || {}),
                layer: layerKey,
                outside:
                  boundary && isPolygonLike(f) ? isOutsideBoundary(f, boundary) : false,
              },
            });
          }
        }
        const source = map.getSource("polys-src");
        if (source && typeof source.setData === "function") {
          source.setData({ type: "FeatureCollection", features });
        }
      }

      refreshPolygonOutlinesRaf();
      ensureDrawBorderLayers();
    };

    askConfirm({
      title: `Clear ${LAYER_META[activeLayer].name}`,
      message: "This will remove all polygons in the active layer. Continue?",
      confirmText: "Clear",
      cancelText: "Cancel",
      danger: true,
      onConfirm: () => {
        const key = activeLayerRef.current;
        const next = {
          ...cloneLayerFeatures(layerFeaturesRef.current),
          [key]: [],
        };
        layerFeaturesRef.current = next;
        setLayerFeatures(next);
        forceSyncPolygonVisuals(next);
        setConfirm(null);
        pushToast("Active layer cleared.", "info");
      },
    });
  }, [
    activeLayer,
    askConfirm,
    boundary,
    ensureDrawBorderLayers,
    pushToast,
    refreshPolygonOutlinesRaf,
    reloadDrawForActiveLayer,
  ]);

  const clearAllLayers = useCallback(() => {
    askConfirm({
      title: "Clear ALL layers",
      message: "This will remove all polygons across all layers. Continue?",
      confirmText: "Clear All",
      cancelText: "Cancel",
      danger: true,
      onConfirm: () => {
        const next = {
          plowable: [],
          sidewalks: [],
          turf: [],
          mulch: [],
        };
        layerFeaturesRef.current = next;
        setLayerFeatures(next);
        setPdfAnnotations([]);
        try {
          const d = drawRef.current;
          if (d) {
            try {
              d.changeMode("simple_select");
            } catch {
              /* intentionally ignore non-critical map/draw errors */
            }
            try {
              d.deleteAll();
            } catch {
              /* intentionally ignore non-critical map/draw errors */
            }
          }
        } catch {
          /* intentionally ignore non-critical map/draw errors */
        }
        reloadDrawForActiveLayer(next, layerVisibleRef.current);
        const map = mapRef.current;
        if (map?.isStyleLoaded?.()) {
          const source = map.getSource("polys-src");
          if (source && typeof source.setData === "function") {
            source.setData({ type: "FeatureCollection", features: [] });
          }
        }
        refreshPolygonOutlinesRaf();
        ensureDrawBorderLayers();
        setConfirm(null);
        pushToast("All layers and PDF annotations cleared.", "info");
      },
    });
  }, [
    askConfirm,
    ensureDrawBorderLayers,
    pushToast,
    refreshPolygonOutlinesRaf,
    reloadDrawForActiveLayer,
  ]);

  const exportTotalsCsvSafe = useCallback(async () => {
    try {
      const { exportTotalsCSV } = await loadExportModule();
      exportTotalsCSV(totals);
    } catch (error) {
      pushToast(`Export totals failed: ${error?.message || "unknown error"}.`, "error", 5000);
    }
  }, [pushToast, totals]);

  const exportPolygonsCsvSafe = useCallback(async () => {
    try {
      const { exportPolygonsCSV } = await loadExportModule();
      exportPolygonsCSV(polygonRows);
    } catch (error) {
      pushToast(`Export polygon list failed: ${error?.message || "unknown error"}.`, "error", 5000);
    }
  }, [polygonRows, pushToast]);

  const exportLayersKmlSafe = useCallback(async () => {
    try {
      const { exportLayersKML } = await loadExportModule();
      await exportLayersKML(combinedLayerGeoJSON);
    } catch (error) {
      pushToast(`Export KML failed: ${error?.message || "unknown error"}.`, "error", 5000);
    }
  }, [combinedLayerGeoJSON, pushToast]);

  const exportPdfSafe = useCallback(async () => {
    const map = mapRef.current;
    if (!map) {
      pushToast("Map not ready yet.", "warn");
      return;
    }
    try {
      const { exportPDF } = await loadExportModule();
      await exportPDF(map, totals);
    } catch (error) {
      pushToast(`Export PDF failed: ${error?.message || "unknown error"}.`, "error", 5000);
    }
  }, [pushToast, totals]);

  const uploadEstimateTemplate = useCallback(
    async (templateKind, e) => {
      const file = e?.target?.files?.[0];
      if (!file) return;
      const kind = templateKind === "snow" ? "snow" : "landscaping";
      const kindLabel = kind === "snow" ? "Snow" : "Landscaping";
      try {
        const parsedTemplate = await readEstimateTemplateUpload(file, kind);
        if (!estimateTemplateHasData(parsedTemplate)) {
          pushToast(`${kindLabel} template is empty.`, "warn");
          e.target.value = "";
          return;
        }
        setEstimateTemplates((prev) => ({
          ...prev,
          [kind]: {
            name: String(parsedTemplate.name || `${kind}-estimate-template.txt`),
            mime: String(parsedTemplate.mime || "text/plain"),
            content: String(parsedTemplate.content || ""),
            format: parsedTemplate.format === "workbook" ? "workbook" : "text",
            binaryBase64: String(parsedTemplate.binaryBase64 || ""),
            binaryExt: String(parsedTemplate.binaryExt || ""),
          },
        }));
        if (parsedTemplate.convertedFromSpreadsheet) {
          const sheetCount = Number(parsedTemplate.sheetCount || 0);
          const sheetNote =
            sheetCount > 1
              ? ` ${sheetCount} sheets preserved.`
              : parsedTemplate.selectedSheetName
              ? ` Sheet: ${parsedTemplate.selectedSheetName}.`
              : "";
          const tokenNote = parsedTemplate.hasTemplatePlaceholders
            ? " Template placeholders detected."
            : " No placeholders detected; using auto-fill for common sections.";
          pushToast(
            `${kindLabel} spreadsheet uploaded.${sheetNote}${tokenNote} Export writes a filled .xlsx with all pages intact.`,
            "info",
            6200
          );
        } else {
          pushToast(
            `${kindLabel} template uploaded. Use placeholders like {{PROJECT_NAME}} and {{${kind === "snow" ? "PLOWABLE_SQFT" : "TURF_SQFT"}}}.`,
            "info",
            5200
          );
        }
      } catch (error) {
        pushToast(
          `${kindLabel} template upload failed: ${error?.message || "could not read file."}`,
          "error",
          6500
        );
      } finally {
        e.target.value = "";
      }
    },
    [pushToast]
  );

  const clearEstimateTemplate = useCallback((templateKind) => {
    const kind = templateKind === "snow" ? "snow" : "landscaping";
    const kindLabel = kind === "snow" ? "Snow" : "Landscaping";
    setEstimateTemplates((prev) => ({
      ...prev,
      [kind]: {
        name: "",
        mime: "text/plain",
        content: "",
        format: "text",
        binaryBase64: "",
        binaryExt: "",
      },
    }));
    pushToast(`${kindLabel} template cleared.`, "info");
  }, [pushToast]);

  const exportEstimateFromTemplate = useCallback(
    async (templateKind) => {
      const kind = templateKind === "snow" ? "snow" : "landscaping";
      const kindLabel = kind === "snow" ? "Snow" : "Landscaping";
      const template = estimateTemplates?.[kind];
      if (!estimateTemplateHasData(template)) {
        pushToast(`Upload a ${kindLabel} estimate template first.`, "warn");
        return;
      }
      const baseProject = safeFilename(projectName || "takeoff-project");
      const templateBaseName = safeFilename(
        String(template.name || `${kindLabel}-estimate-template`).replace(/\.[^.]+$/u, "")
      );
      try {
        if (template.format === "workbook") {
          const workbookBytes = base64ToUint8Array(template.binaryBase64 || "");
          const { XLSX, xlsxZahl } = await loadEstimateSpreadsheetReader();
          const workbook = XLSX.read(workbookBytes, {
            type: "array",
            dense: true,
            raw: false,
            cellFormula: false,
            numbers: xlsxZahl,
          });
          const sectionItems = buildEstimateSectionLineItems(layerFeatures);
          for (const sheetName of workbook.SheetNames || []) {
            const sheet = workbook.Sheets?.[sheetName];
            if (!sheet) continue;
            fillEstimateWorkbookSheet(XLSX, sheet, estimateTemplateTokens, sectionItems);
          }
          const outputBytes = XLSX.write(workbook, {
            type: "array",
            bookType: "xlsx",
            compression: true,
          });
          const filename = `${baseProject}-${templateBaseName}-filled.xlsx`;
          downloadBlob(
            filename,
            new Blob([outputBytes], {
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            })
          );
          pushToast(
            `${kindLabel} estimate exported (.xlsx) with all pages and polygon values.`,
            "info",
            4600
          );
          return;
        }

        const filled = applyEstimateTemplateText(template.content, estimateTemplateTokens);
        const extMatch = String(template.name || "").match(/\.[^.]+$/u);
        const ext = extMatch ? extMatch[0] : ".txt";
        const filename = `${baseProject}-${templateBaseName}-filled${ext}`;
        const mime =
          template.mime && /^(text\/|application\/(json|xml|csv))/i.test(template.mime)
            ? template.mime
            : "text/plain";
        downloadBlob(filename, new Blob([filled], { type: mime }));
        pushToast(`${kindLabel} estimate exported from template.`, "info", 4200);
      } catch (error) {
        pushToast(
          `${kindLabel} estimate export failed: ${error?.message || "unknown error."}`,
          "error",
          6500
        );
      }
    },
    [estimateTemplateTokens, estimateTemplates, layerFeatures, projectName, pushToast]
  );

  const exportTrainingSample = useCallback(
    async ({
      exportKind = "manual_export",
      feedbackNote = "",
      segmentationFeedback = null,
    } = {}) => {
    const map = mapRef.current;
    if (!map) {
      pushToast("Map not ready yet.", "warn");
      return false;
    }
    if (!boundary || !isPolygonLike(boundary)) {
      pushToast("Load or draw a property boundary before exporting training data.", "warn");
      return false;
    }

    const snapshot = buildLayerSnapshot();
    const featureCount =
      (snapshot.plowable?.length || 0) +
      (snapshot.sidewalks?.length || 0) +
      (snapshot.turf?.length || 0) +
      (snapshot.mulch?.length || 0);
    if (featureCount === 0) {
      pushToast("No layer polygons found. Draw/AI-detect first, then export training data.", "warn");
      return false;
    }

    setTrainingExporting(true);
    try {
      const mapCanvas = map.getCanvas();
      const imageBlob = await captureMapImageBlob(map, { failOnBlank: false });

      const width = mapCanvas.width || 1;
      const height = mapCanvas.height || 1;
      const cssW = mapCanvas.clientWidth || width;
      const cssH = mapCanvas.clientHeight || height;
      const sx = width / cssW;
      const sy = height / cssH;

      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = width;
      maskCanvas.height = height;
      const ctx = maskCanvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        throw new Error("Could not create mask canvas context.");
      }
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgb(0,0,0)";
      ctx.fillRect(0, 0, width, height);

      const traceFeaturePath = (feature) => {
        if (!feature || !isPolygonLike(feature)) return false;
        const geom = to2DFeature(feature)?.geometry;
        if (!geom) return false;
        const polygons =
          geom.type === "Polygon"
            ? [geom.coordinates]
            : geom.type === "MultiPolygon"
            ? geom.coordinates
            : [];
        let drew = false;
        for (const poly of polygons) {
          for (const ring of poly || []) {
            if (!Array.isArray(ring) || ring.length < 3) continue;
            let moved = false;
            for (const coord of ring) {
              if (!Array.isArray(coord) || coord.length < 2) continue;
              const p = map.project([Number(coord[0]), Number(coord[1])]);
              const x = p.x * sx;
              const y = p.y * sy;
              if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
              if (!moved) {
                ctx.moveTo(x, y);
                moved = true;
                drew = true;
              } else {
                ctx.lineTo(x, y);
              }
            }
            if (moved) ctx.closePath();
          }
        }
        return drew;
      };

      // Clip drawing to boundary so outside remains background.
      ctx.save();
      ctx.beginPath();
      const hasBoundaryPath = traceFeaturePath(boundary);
      if (hasBoundaryPath) {
        ctx.clip("evenodd");
      }

      const drawLayerMask = (layerKey, value) => {
        const features = snapshot[layerKey] || [];
        if (!features.length) return;
        ctx.fillStyle = `rgb(${value},${value},${value})`;
        for (const f of features) {
          ctx.beginPath();
          if (!traceFeaturePath(f)) continue;
          ctx.fill("evenodd");
        }
      };

      drawLayerMask("plowable", TRAIN_MASK_VALUES.plowable);
      drawLayerMask("sidewalks", TRAIN_MASK_VALUES.sidewalks);
      drawLayerMask("turf", TRAIN_MASK_VALUES.turf);
      drawLayerMask("mulch", TRAIN_MASK_VALUES.mulch);
      ctx.restore();

      // Quantize anti-aliased edges back into strict class ids [0..4].
      const img = ctx.getImageData(0, 0, width, height);
      const d = img.data;
      const palette = [
        TRAIN_MASK_VALUES.background,
        TRAIN_MASK_VALUES.plowable,
        TRAIN_MASK_VALUES.sidewalks,
        TRAIN_MASK_VALUES.turf,
        TRAIN_MASK_VALUES.mulch,
      ];
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i];
        let bestIdx = 0;
        let bestDist = Math.abs(v - palette[0]);
        for (let p = 1; p < palette.length; p += 1) {
          const dist = Math.abs(v - palette[p]);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = p;
          }
        }
        d[i] = bestIdx;
        d[i + 1] = bestIdx;
        d[i + 2] = bestIdx;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);

      const maskBlob = await new Promise((resolve, reject) => {
        maskCanvas.toBlob((nextBlob) => {
          if (nextBlob) resolve(nextBlob);
          else reject(new Error("Could not create mask image."));
        }, "image/png");
      });

      const previewCanvas = document.createElement("canvas");
      previewCanvas.width = width;
      previewCanvas.height = height;
      const previewCtx = previewCanvas.getContext("2d");
      if (!previewCtx) {
        throw new Error("Could not create preview canvas context.");
      }
      const previewImage = previewCtx.createImageData(width, height);
      const pd = previewImage.data;
      for (let i = 0; i < d.length; i += 4) {
        const id = d[i];
        const color = TRAIN_PREVIEW_COLORS[id] || TRAIN_PREVIEW_COLORS[0];
        pd[i] = color[0];
        pd[i + 1] = color[1];
        pd[i + 2] = color[2];
        pd[i + 3] = 255;
      }
      previewCtx.putImageData(previewImage, 0, 0);
      const maskPreviewBlob = await new Promise((resolve, reject) => {
        previewCanvas.toBlob((nextBlob) => {
          if (nextBlob) resolve(nextBlob);
          else reject(new Error("Could not create preview mask image."));
        }, "image/png");
      });

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const kindSlug = safeFilename(String(exportKind || "manual-export")).toLowerCase();
      const base = `${safeFilename(projectName || "takeoff-sample")}-${kindSlug}-${stamp}`;
      const metadata = {
        version: 1,
        created_at: new Date().toISOString(),
        export_kind: exportKind,
        feedback_note: String(feedbackNote || "").trim(),
        project_name: projectName || "",
        image_filename: `${base}.png`,
        mask_filename: `${base}_mask.png`,
        mask_preview_filename: `${base}_mask_preview.png`,
        mask_encoding: "grayscale class ids (0..4)",
        width,
        height,
        class_ids: TRAIN_CLASS_IDS,
        layer_feature_counts: {
          plowable: snapshot.plowable?.length || 0,
          sidewalks: snapshot.sidewalks?.length || 0,
          turf: snapshot.turf?.length || 0,
          mulch: snapshot.mulch?.length || 0,
        },
        boundary_source: boundary?.properties?.lookup_source || "unknown",
        segmentation_feedback:
          segmentationFeedback && typeof segmentationFeedback === "object"
            ? segmentationFeedback
            : null,
      };

      const [imageBuf, maskBuf] = await Promise.all([
        imageBlob.arrayBuffer(),
        maskBlob.arrayBuffer(),
      ]);
      const maskPreviewBuf = await maskPreviewBlob.arrayBuffer();
      const zipBytes = zipSync({
        [`${base}.png`]: new Uint8Array(imageBuf),
        [`${base}_mask.png`]: new Uint8Array(maskBuf),
        [`${base}_mask_preview.png`]: new Uint8Array(maskPreviewBuf),
        [`${base}.json`]: strToU8(`${JSON.stringify(metadata, null, 2)}\n`),
      });
      downloadBlob(
        `${base}_training-export.zip`,
        new Blob([zipBytes], { type: "application/zip" })
      );
      if (exportKind === "cv_marked_wrong") {
        pushToast(
          "CV correction export complete: ZIP includes current corrected polygons + feedback metadata.",
          "info",
          6500
        );
      } else {
        pushToast(
          "Training export complete: ZIP includes image, mask IDs, color preview, and metadata.",
          "info",
          6000
        );
      }
      return true;
    } catch (error) {
      pushToast(`Training export failed: ${error.message}`, "error", 6000);
      return false;
    } finally {
      setTrainingExporting(false);
    }
  }, [boundary, buildLayerSnapshot, projectName, pushToast]);

  const markCvPredictionWrongAndExport = useCallback(async () => {
    if (!segmentationResult) {
      pushToast(
        "Run CV segmentation first, then correct polygons and click this to export a correction sample.",
        "warn",
        6200
      );
      return;
    }

    const confidence = {
      plowable: Number(segmentationResult?.plowable?.confidence || 0),
      sidewalks: Number(segmentationResult?.sidewalks?.confidence || 0),
      turf: Number(segmentationResult?.turf?.confidence || 0),
      mulch: Number(segmentationResult?.mulch?.confidence || 0),
    };

    await exportTrainingSample({
      exportKind: "cv_marked_wrong",
      feedbackNote:
        "Operator marked CV output as wrong and exported corrected polygons for retraining.",
      segmentationFeedback: {
        original_confidence: confidence,
        original_notes: (segmentationResult?.notes || []).slice(0, 12),
        corrected_at: new Date().toISOString(),
      },
    });
  }, [exportTrainingSample, pushToast, segmentationResult]);

  const drawModeLabel = useMemo(() => {
    if (drawMode === "draw_polygon") return "Draw Polygon";
    if (drawMode === "direct_select") return "Edit Vertices";
    if (drawMode === "simple_select") return "Select";
    return drawMode || "Select";
  }, [drawMode]);

  const keyStatus = useMemo(
    () => ({
      maptiler: !!maptilerKey,
      mapbox: !!mapboxToken,
      azure: !!azureMapsKey,
      google: !!googleMapsKey,
    }),
    [azureMapsKey, googleMapsKey, mapboxToken, maptilerKey]
  );

  const commandActions = useMemo(
    () => [
      {
        id: "save-json",
        label: "Save Project (JSON)",
        detail: "Download JSON and sync shared project when logged in.",
        shortcut: "Cmd/Ctrl+S",
        keywords: "save json download project",
        disabled: saveInProgress,
        run: () => saveProject({ downloadFile: true }),
      },
      {
        id: "save-shared",
        label: "Save Project (Shared Only)",
        detail: "Store in browser/shared files without downloading JSON.",
        keywords: "save shared sync cloud",
        disabled: saveInProgress,
        run: () => saveProject({ downloadFile: false }),
      },
      {
        id: "version-history",
        label: "Open Version History",
        detail: "Compare snapshots and restore previous versions.",
        keywords: "history version compare restore",
        run: () => setShowVersionHistory(true),
      },
      {
        id: "refresh-shared-library",
        label: "Refresh Shared Library",
        detail: "Fetch latest Home projects from backend.",
        keywords: "refresh shared library projects",
        disabled: !sharedAccessAuthenticated || sharedProjectLibrarySyncing || sharedAuthChecking,
        run: () => refreshSharedProjectLibrary({ quiet: false }),
      },
      {
        id: "sync-shared-queue",
        label: "Sync Shared Queue",
        detail: "Upload queued project changes to shared storage.",
        keywords: "sync queue shared offline",
        disabled:
          !sharedAccessAuthenticated ||
          sharedProjectQueueSyncing ||
          sharedAuthChecking ||
          sharedProjectQueue.length === 0,
        run: () => syncSharedProjectQueue({ quiet: false }),
      },
      {
        id: "ai-takeoff",
        label: "Run AI Takeoff (Stable)",
        detail: "Generate polygons with backend takeoff.",
        keywords: "ai takeoff measure stable",
        disabled:
          !aiEnabled ||
          workflowMode === WORKFLOW_MODE_PDF ||
          !boundary ||
          autoMeasuring ||
          pdfConverting,
        run: autoMeasureExperimental,
      },
      {
        id: "cv-segment",
        label: "Run CV Segmentation (All Classes)",
        detail: "Run backend segmentation for all layers.",
        keywords: "cv segmentation polygons",
        disabled:
          !aiEnabled ||
          workflowMode === WORKFLOW_MODE_PDF ||
          segmentingImage ||
          pdfConverting ||
          (!measurementImageFile && !boundary),
        run: () => runSegmentationMeasurement(),
      },
      {
        id: "lookup-property",
        label: "Lookup Property by Address",
        detail: "Run boundary/address lookup using selected provider.",
        keywords: "lookup address boundary geocode",
        disabled:
          workflowMode === WORKFLOW_MODE_PDF ||
          propertyLookupLoading ||
          !propertyLookupQuery.trim(),
        run: () => lookupPropertyByAddress(),
      },
      {
        id: "draw-mode",
        label: "Switch to Draw Mode",
        detail: "Enable polygon drawing.",
        shortcut: "P",
        keywords: "draw polygon mode",
        run: switchToDrawMode,
      },
      {
        id: "pan-mode",
        label: "Switch to Pan/Select Mode",
        detail: "Pan map and select existing features.",
        shortcut: "Esc",
        keywords: "pan select mode",
        run: switchToPanMode,
      },
      {
        id: "delete-selected",
        label: "Delete Selected Features",
        detail: "Remove currently selected polygons.",
        shortcut: "Delete",
        keywords: "delete selected features",
        run: deleteSelectedFeatures,
      },
      {
        id: "undo",
        label: "Undo",
        detail: "Undo latest edit.",
        shortcut: "Cmd/Ctrl+Z",
        keywords: "undo edit",
        disabled: !canUndo,
        run: undoLayerEdit,
      },
      {
        id: "redo",
        label: "Redo",
        detail: "Redo last undone edit.",
        shortcut: "Cmd/Ctrl+Shift+Z",
        keywords: "redo edit",
        disabled: !canRedo,
        run: redoLayerEdit,
      },
      {
        id: "next-layer",
        label: "Cycle Active Layer",
        detail: "Move to the next layer: plowable, sidewalks, turf, mulch.",
        keywords: "layer cycle active",
        run: cycleActiveLayer,
      },
      {
        id: "open-3d",
        label: "Open True 3D Viewer",
        detail: "Open photorealistic 3D viewer with edit handles.",
        keywords: "3d viewer cesium terrain",
        disabled: workflowMode === WORKFLOW_MODE_PDF,
        run: openTrue3DViewer,
      },
      {
        id: "restore-autosave",
        label: "Restore Autosave Draft",
        detail: "Load latest autosave snapshot.",
        keywords: "autosave restore recover",
        disabled: !autosaveDraftAvailable,
        run: restoreAutosave,
      },
      {
        id: "clear-active",
        label: `Clear Active Layer (${LAYER_META[activeLayer]?.name || activeLayer})`,
        detail: "Remove polygons only from the current layer.",
        keywords: "clear active layer polygons",
        run: clearActiveLayer,
      },
      {
        id: "clear-all",
        label: "Clear All Layers",
        detail: "Remove polygons from all layers.",
        keywords: "clear all layers polygons",
        run: clearAllLayers,
      },
      {
        id: "open-home",
        label: "Go to Home Page",
        detail: "Open shared project home page.",
        keywords: "home projects page",
        run: () => setAppScreen(APP_SCREEN_HOME),
      },
      {
        id: "new-location",
        label: "Start New Location Project",
        detail: "Reset workspace and open location mode.",
        keywords: "new project location",
        run: () => startNewProject(WORKFLOW_MODE_LOCATION),
      },
      {
        id: "new-pdf",
        label: "Start New PDF/Image Project",
        detail: "Reset workspace and open PDF mode.",
        keywords: "new project pdf image",
        run: () => startNewProject(WORKFLOW_MODE_PDF),
      },
      {
        id: "open-page-picker",
        label: "Open Page Picker",
        detail: "Switch between location and PDF measuring pages.",
        keywords: "page picker workflow",
        run: () => setShowWorkflowPicker(true),
      },
    ],
    [
      activeLayer,
      aiEnabled,
      autoMeasureExperimental,
      autoMeasuring,
      autosaveDraftAvailable,
      boundary,
      canRedo,
      canUndo,
      clearActiveLayer,
      clearAllLayers,
      cycleActiveLayer,
      deleteSelectedFeatures,
      lookupPropertyByAddress,
      measurementImageFile,
      openTrue3DViewer,
      pdfConverting,
      propertyLookupLoading,
      propertyLookupQuery,
      redoLayerEdit,
      refreshSharedProjectLibrary,
      restoreAutosave,
      runSegmentationMeasurement,
      saveInProgress,
      saveProject,
      segmentingImage,
      sharedAccessAuthenticated,
      sharedAuthChecking,
      sharedProjectLibrarySyncing,
      sharedProjectQueue.length,
      sharedProjectQueueSyncing,
      startNewProject,
      switchToDrawMode,
      switchToPanMode,
      syncSharedProjectQueue,
      undoLayerEdit,
      workflowMode,
    ]
  );

  const filteredCommandActions = useMemo(() => {
    const q = String(commandPaletteQuery || "").trim().toLowerCase();
    if (!q) return commandActions;
    return commandActions.filter((action) =>
      `${action.label} ${action.detail || ""} ${action.keywords || ""}`
        .toLowerCase()
        .includes(q)
    );
  }, [commandActions, commandPaletteQuery]);

  const runCommandPaletteAction = useCallback((action) => {
    if (!action || action.disabled) return;
    try {
      action.run?.();
    } catch {
      /* intentionally ignore non-critical map/draw errors */
    }
    setShowCommandPalette(false);
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
  }, []);

  useEffect(() => {
    if (!showCommandPalette) return;
    setCommandPaletteIndex(0);
    requestAnimationFrame(() => {
      commandPaletteInputRef.current?.focus?.();
      commandPaletteInputRef.current?.select?.();
    });
  }, [showCommandPalette]);

  useEffect(() => {
    if (!showCommandPalette) return;
    if (!filteredCommandActions.length) {
      if (commandPaletteIndex !== 0) setCommandPaletteIndex(0);
      return;
    }
    if (commandPaletteIndex >= filteredCommandActions.length) {
      setCommandPaletteIndex(filteredCommandActions.length - 1);
    }
  }, [commandPaletteIndex, filteredCommandActions.length, showCommandPalette]);

  // ---------- Render ----------
  if (appScreen === APP_SCREEN_HOME) {
    return (
      <div
        style={{
          minHeight: "100vh",
          width: "100vw",
          color: "#fff",
          fontFamily: '"Avenir Next", "SF Pro Display", "Segoe UI", sans-serif',
          background:
            "radial-gradient(1200px 700px at 20% 10%, rgba(68,170,255,0.22), transparent 60%), radial-gradient(1000px 620px at 82% 18%, rgba(36,198,135,0.18), transparent 58%), linear-gradient(180deg, #07131f 0%, #050a12 100%)",
          position: "relative",
          overflow: "auto",
        }}
      >
        <Toasts toasts={toasts} onClose={closeToast} />
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              "repeating-linear-gradient(120deg, rgba(255,255,255,0.02) 0 1px, transparent 1px 40px)",
            opacity: 0.5,
          }}
        />

        <div style={{ position: "relative", zIndex: 1, maxWidth: 1180, margin: "0 auto", padding: "28px 22px 32px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              marginBottom: 26,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <img
                src="/logo.png"
                alt="McKenna Site Management"
                style={{
                  width: 86,
                  height: 86,
                  objectFit: "contain",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.04)",
                  padding: 6,
                }}
              />
              <div style={{ lineHeight: 1.1 }}>
                <div style={{ fontSize: 12, letterSpacing: 1.4, textTransform: "uppercase", opacity: 0.7 }}>
                  McKenna Site Management
                </div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>Takeoff Home</div>
              </div>
            </div>
            {hasCurrentProjectData ? (
              <button
                type="button"
                onClick={() => openMeasurementScreen(workflowMode)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.08)",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Continue Current Project
              </button>
            ) : null}
          </div>

          <div
            style={{
              borderRadius: 24,
              border: "1px solid rgba(255,255,255,0.12)",
              background:
                "linear-gradient(155deg, rgba(10,26,44,0.88) 0%, rgba(8,18,30,0.88) 58%, rgba(8,28,22,0.82) 100%)",
              boxShadow: "0 26px 60px rgba(0,0,0,0.45)",
              padding: "26px 24px 24px",
              marginBottom: 18,
            }}
          >
            <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: 0.4, marginBottom: 8 }}>
              Explore, Measure, Deliver
            </div>
            <div style={{ fontSize: 15, opacity: 0.83, maxWidth: 760, marginBottom: 18 }}>
              Open a saved property, import a project JSON, or start a fresh takeoff page.
              Location takeoff and PDF/image takeoff now open on separate pages.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
              <button
                type="button"
                onClick={() => startNewProject(WORKFLOW_MODE_LOCATION)}
                style={{
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1px solid rgba(124,214,255,0.55)",
                  background: "linear-gradient(120deg, rgba(0,134,255,0.28), rgba(40,210,136,0.26))",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                Measure Location Page
              </button>

              <button
                type="button"
                onClick={() => startNewProject(WORKFLOW_MODE_PDF)}
                style={{
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1px solid rgba(124,214,255,0.55)",
                  background: "linear-gradient(120deg, rgba(0,134,255,0.22), rgba(85,130,255,0.24))",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                Measure PDF/Image Page
              </button>

              <label
                style={{
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                  textAlign: "center",
                }}
              >
                Import Project JSON
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={loadProjectFile}
                  style={{ display: "none" }}
                />
              </label>

              <button
                type="button"
                onClick={() => {
                  setAppScreen(APP_SCREEN_LOCATION);
                  setShowWorkflowPicker(true);
                }}
                style={{
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Pick Mode
              </button>
            </div>
          </div>

          <div
            style={{
              borderRadius: 20,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(8,16,26,0.75)",
              padding: "16px 16px 14px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>Recent Projects</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {visibleProjectLibrary.length} saved
                </div>
                <div
                  style={{
                    fontSize: 11,
                    padding: "3px 7px",
                    borderRadius: 999,
                    border: sharedStatusUi.border,
                    background: sharedStatusUi.background,
                    color: "#fff",
                    fontWeight: 700,
                  }}
                >
                  {sharedStatusUi.label}
                </div>
                {sharedProjectQueue.length > 0 && (
                  <div
                    style={{
                      fontSize: 11,
                      padding: "3px 7px",
                      borderRadius: 999,
                      border: "1px solid rgba(255,214,102,0.55)",
                      background: "rgba(164,130,32,0.24)",
                      color: "#fff",
                      fontWeight: 700,
                    }}
                  >
                    Pending sync: {sharedProjectQueue.length}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => refreshSharedProjectLibrary({ quiet: false })}
                  disabled={
                    sharedProjectLibrarySyncing ||
                    sharedAuthChecking ||
                    !sharedAccessAuthenticated
                  }
                  style={{
                    padding: "5px 8px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    cursor:
                      sharedProjectLibrarySyncing ||
                      sharedAuthChecking ||
                      !sharedAccessAuthenticated
                        ? "not-allowed"
                        : "pointer",
                    opacity:
                      sharedProjectLibrarySyncing ||
                      sharedAuthChecking ||
                      !sharedAccessAuthenticated
                        ? 0.6
                        : 1,
                    fontWeight: 700,
                    fontSize: 11,
                  }}
                >
                  {sharedProjectLibrarySyncing ? "Refreshing..." : "Refresh"}
                </button>
                <button
                  type="button"
                  onClick={() => syncSharedProjectQueue({ quiet: false })}
                  disabled={
                    sharedProjectQueueSyncing ||
                    sharedProjectQueue.length === 0 ||
                    sharedAuthChecking ||
                    !sharedAccessAuthenticated
                  }
                  style={{
                    padding: "5px 8px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    cursor:
                      sharedProjectQueueSyncing ||
                      sharedProjectQueue.length === 0 ||
                      sharedAuthChecking ||
                      !sharedAccessAuthenticated
                        ? "not-allowed"
                        : "pointer",
                    opacity:
                      sharedProjectQueueSyncing ||
                      sharedProjectQueue.length === 0 ||
                      sharedAuthChecking ||
                      !sharedAccessAuthenticated
                        ? 0.6
                        : 1,
                    fontWeight: 700,
                    fontSize: 11,
                  }}
                >
                  {sharedProjectQueueSyncing ? "Syncing..." : "Sync Queue"}
                </button>
              </div>
            </div>

            {!sharedAccessAuthenticated ? (
              <form
                onSubmit={handleSharedLogin}
                style={{
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 12,
                  padding: 12,
                  marginBottom: 10,
                  background: "rgba(255,255,255,0.04)",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                  Log in to access shared files
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
                  Shared project library is locked until authenticated. Each team member can use their own login.
                </div>
                <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr auto" }}>
                  <input
                    type="text"
                    value={sharedLoginUsername}
                    onChange={(event) => setSharedLoginUsername(event.target.value)}
                    placeholder="Username"
                    autoComplete="username"
                    style={{
                      minWidth: 0,
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(6,12,18,0.9)",
                      color: "#fff",
                    }}
                  />
                  <input
                    type="password"
                    value={sharedLoginPassword}
                    onChange={(event) => setSharedLoginPassword(event.target.value)}
                    placeholder="Password"
                    autoComplete="current-password"
                    style={{
                      minWidth: 0,
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(6,12,18,0.9)",
                      color: "#fff",
                    }}
                  />
                  <button
                    type="submit"
                    disabled={sharedLoginSubmitting || sharedAuthChecking}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid rgba(124,214,255,0.55)",
                      background: "rgba(0,140,255,0.2)",
                      color: "#fff",
                      cursor:
                        sharedLoginSubmitting || sharedAuthChecking ? "not-allowed" : "pointer",
                      opacity: sharedLoginSubmitting || sharedAuthChecking ? 0.65 : 1,
                      fontWeight: 700,
                    }}
                  >
                    {sharedLoginSubmitting ? "Signing in..." : "Sign In"}
                  </button>
                </div>
              </form>
            ) : (
              <div
                style={{
                  border: "1px solid rgba(89,226,143,0.4)",
                  borderRadius: 12,
                  padding: "10px 12px",
                  marginBottom: 10,
                  background: "rgba(28,162,92,0.14)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.88 }}>
                  Signed in as <b>{sharedAuth?.username || "admin"}</b>
                  {sharedAuth?.expiresAt ? (
                    <span style={{ opacity: 0.8 }}>
                      {" "}
                      • session expires {new Date(sharedAuth.expiresAt).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={handleSharedLogout}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  Log Out
                </button>
              </div>
            )}

            {visibleProjectLibrary.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.72, lineHeight: 1.4 }}>
                {!sharedAccessAuthenticated
                  ? "Log in to view shared projects."
                  : "No saved projects yet. Use Save Project (JSON) in a measuring page and projects will appear here."}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {visibleProjectLibrary.map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto auto",
                      gap: 8,
                      alignItems: "center",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 12,
                      padding: "10px 12px",
                      background: "rgba(255,255,255,0.03)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 700,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {entry.projectName || "Untitled Project"}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>
                        {Number(entry.polygonCount || 0).toLocaleString()} polygons • Boundary:{" "}
                        {entry.hasBoundary ? "Yes" : "No"} • Saved by:{" "}
                        {entry.savedBy || "local"} • Last edited:{" "}
                        {entry.lastEditedAt
                          ? new Date(entry.lastEditedAt).toLocaleString()
                          : new Date(entry.savedAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => loadProjectFromLibrary(entry.id)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(124,214,255,0.55)",
                        background: "rgba(0,140,255,0.2)",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => removeProjectFromLibrary(entry.id)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.22)",
                        background: "rgba(255,255,255,0.06)",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              marginTop: 14,
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            }}
          >
            <div
              style={{
                borderRadius: 20,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(8,16,26,0.75)",
                padding: "14px 14px 12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 800 }}>Security & Legal</div>
                <button
                  type="button"
                  onClick={() => setShowLegalNotes((prev) => !prev)}
                  style={{
                    padding: "6px 9px",
                    borderRadius: 9,
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 11,
                  }}
                >
                  {showLegalNotes ? "Hide Policy" : "Show Policy"}
                </button>
              </div>
              <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.45 }}>
                Access requires login. Project changes are audit-logged (user, action, time, device/IP metadata).
              </div>
              {showLegalNotes ? (
                <div
                  style={{
                    marginTop: 10,
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(255,255,255,0.04)",
                    padding: "10px 11px",
                    fontSize: 12,
                    lineHeight: 1.48,
                    color: "rgba(255,255,255,0.9)",
                  }}
                >
                  <div style={{ fontWeight: 800, marginBottom: 4 }}>Terms of Use</div>
                  Authorized business use only. Do not upload protected data unless you have rights to process it.
                  <div style={{ fontWeight: 800, marginTop: 8, marginBottom: 4 }}>Privacy Notice</div>
                  Shared login events and project actions are logged for accountability and security review.
                  <div style={{ fontWeight: 800, marginTop: 8, marginBottom: 4 }}>Data Retention</div>
                  Audit events are retained by backend policy (`AUTO_MEASURE_AUDIT_RETENTION_DAYS`,
                  default 180 days). Shared project files remain until deleted by a logged-in user.
                </div>
              ) : null}
            </div>

            <div
              style={{
                borderRadius: 20,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(8,16,26,0.75)",
                padding: "14px 14px 12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 800 }}>Access Audit Log</div>
                <button
                  type="button"
                  onClick={() => refreshSecurityAuditEvents({ quiet: false })}
                  disabled={!sharedAccessAuthenticated || sharedAuthChecking || securityAuditSyncing}
                  style={{
                    padding: "6px 9px",
                    borderRadius: 9,
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    cursor:
                      !sharedAccessAuthenticated || sharedAuthChecking || securityAuditSyncing
                        ? "not-allowed"
                        : "pointer",
                    opacity:
                      !sharedAccessAuthenticated || sharedAuthChecking || securityAuditSyncing
                        ? 0.6
                        : 1,
                    fontWeight: 700,
                    fontSize: 11,
                  }}
                >
                  {securityAuditSyncing ? "Refreshing..." : "Refresh Log"}
                </button>
              </div>
              {!sharedAccessAuthenticated ? (
                <div style={{ fontSize: 12, opacity: 0.78 }}>
                  Sign in above to view audit events.
                </div>
              ) : securityAuditEvents.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.78 }}>
                  No audit events yet.
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: 250,
                    overflow: "auto",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 10,
                    background: "rgba(3,8,12,0.72)",
                  }}
                >
                  {securityAuditEvents.slice(0, 80).map((event) => (
                    <div
                      key={event.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "120px 1fr",
                        gap: 8,
                        padding: "8px 10px",
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        fontSize: 12,
                        lineHeight: 1.35,
                      }}
                    >
                      <div style={{ opacity: 0.7 }}>
                        {event.created_at
                          ? new Date(event.created_at).toLocaleString()
                          : "Unknown"}
                      </div>
                      <div>
                        <span style={{ fontWeight: 800 }}>{event.username || "unknown"}</span>{" "}
                        <span style={{ opacity: 0.9 }}>{event.action || "action"}</span>{" "}
                        <span
                          style={{
                            opacity: 0.95,
                            color:
                              event.outcome === "success"
                                ? "#7febad"
                                : event.outcome === "failure"
                                ? "#ff8a8a"
                                : "#ffd786",
                          }}
                        >
                          ({event.outcome || "unknown"})
                        </span>
                        {event.resource ? <span style={{ opacity: 0.75 }}> • {event.resource}</span> : null}
                        {event.ip_address ? (
                          <span style={{ opacity: 0.62 }}> • {event.ip_address}</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`app${isCompactTouchUi ? " compact-ui" : ""}`}
      style={{ display: "flex", height: "100vh", width: "100vw" }}
    >
      <Toasts toasts={toasts} onClose={closeToast} />

      <ConfirmDialog
        open={!!confirm?.open}
        title={confirm?.title}
        message={confirm?.message}
        confirmText={confirm?.confirmText}
        cancelText={confirm?.cancelText}
        danger={confirm?.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm?.onConfirm?.()}
      />

      {showVersionHistory && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10002,
            background: "rgba(0,0,0,0.66)",
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "min(980px, 100%)",
              maxHeight: "86vh",
              overflow: "auto",
              background: "#0f0f0f",
              border: "1px solid rgba(255,255,255,0.16)",
              borderRadius: 16,
              boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
              padding: 14,
              color: "#fff",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>Version History</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>
                  {projectName || "Untitled Project"} • {currentProjectVersions.length} snapshot
                  {currentProjectVersions.length === 1 ? "" : "s"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={clearCurrentProjectVersionHistory}
                  disabled={!currentProjectVersions.length}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,125,125,0.45)",
                    background: "rgba(180,58,58,0.20)",
                    color: "#fff",
                    cursor: currentProjectVersions.length ? "pointer" : "not-allowed",
                    opacity: currentProjectVersions.length ? 1 : 0.6,
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  Clear History
                </button>
                <button
                  type="button"
                  onClick={() => setShowVersionHistory(false)}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.20)",
                    background: "rgba(255,255,255,0.08)",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.15fr 1fr",
                gap: 12,
              }}
            >
              <div
                style={{
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.03)",
                  overflow: "hidden",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.8, padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.10)" }}>
                  Snapshots (newest first)
                </div>
                {!currentProjectVersions.length ? (
                  <div style={{ padding: 12, fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
                    No snapshots yet. Save your project to create restorable versions.
                  </div>
                ) : (
                  <div style={{ maxHeight: 430, overflow: "auto" }}>
                    {currentProjectVersions.map((version) => {
                      const selected = String(versionCompareId || "") === String(version.id || "");
                      return (
                        <div
                          key={version.id}
                          style={{
                            padding: "9px 10px",
                            borderBottom: "1px solid rgba(255,255,255,0.08)",
                            background: selected ? "rgba(0,140,255,0.16)" : "transparent",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 700 }}>
                              {version.savedAt
                                ? new Date(version.savedAt).toLocaleString()
                                : "Unknown time"}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                padding: "2px 6px",
                                borderRadius: 999,
                                border: "1px solid rgba(255,255,255,0.18)",
                                background: "rgba(255,255,255,0.07)",
                                opacity: 0.9,
                              }}
                            >
                              {version.source || "local"}
                            </div>
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 3 }}>
                            {Number(version.polygonCount || 0).toLocaleString()} polygons
                            {version.savedBy ? ` • by ${version.savedBy}` : ""}
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
                            <button
                              type="button"
                              onClick={() => setVersionCompareId(String(version.id || ""))}
                              style={{
                                padding: "6px 8px",
                                borderRadius: 8,
                                border: "1px solid rgba(255,255,255,0.16)",
                                background: selected ? "rgba(0,140,255,0.20)" : "rgba(255,255,255,0.06)",
                                color: "#fff",
                                cursor: "pointer",
                                fontWeight: 700,
                                fontSize: 11,
                              }}
                            >
                              {selected ? "Selected" : "Compare"}
                            </button>
                            <button
                              type="button"
                              onClick={() => restoreVersionSnapshot(version.id)}
                              style={{
                                padding: "6px 8px",
                                borderRadius: 8,
                                border: "1px solid rgba(124,214,255,0.45)",
                                background: "rgba(0,140,255,0.20)",
                                color: "#fff",
                                cursor: "pointer",
                                fontWeight: 700,
                                fontSize: 11,
                              }}
                            >
                              Restore
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div
                style={{
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.03)",
                  padding: 10,
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.84, marginBottom: 8 }}>
                  {selectedVersionForCompare
                    ? "Comparison (selected snapshot vs current)"
                    : "Select a snapshot to compare."}
                </div>
                {selectedVersionForCompare ? (
                  <div style={{ fontSize: 12 }}>
                    <div style={{ marginBottom: 8, opacity: 0.78 }}>
                      Snapshot:{" "}
                      {selectedVersionForCompare.savedAt
                        ? new Date(selectedVersionForCompare.savedAt).toLocaleString()
                        : "Unknown"}
                    </div>
                    {LAYER_KEYS.map((layerKey) => {
                      const currentLayer = currentProjectMetrics.byLayer[layerKey] || {
                        polygons: 0,
                        sqft: 0,
                      };
                      const snapLayer = selectedVersionMetrics.byLayer[layerKey] || {
                        polygons: 0,
                        sqft: 0,
                      };
                      const polyDelta = currentLayer.polygons - snapLayer.polygons;
                      const sqftDelta = currentLayer.sqft - snapLayer.sqft;
                      return (
                        <div
                          key={`version-layer-${layerKey}`}
                          style={{
                            padding: "6px 0",
                            borderBottom: "1px dashed rgba(255,255,255,0.10)",
                          }}
                        >
                          <div style={{ fontWeight: 700 }}>{LAYER_META[layerKey].name}</div>
                          <div style={{ opacity: 0.8 }}>
                            Polygons: {snapLayer.polygons} → {currentLayer.polygons} (
                            {polyDelta >= 0 ? "+" : ""}
                            {polyDelta})
                          </div>
                          <div style={{ opacity: 0.8 }}>
                            Sqft: {Math.round(snapLayer.sqft).toLocaleString()} →{" "}
                            {Math.round(currentLayer.sqft).toLocaleString()} (
                            {sqftDelta >= 0 ? "+" : ""}
                            {Math.round(sqftDelta).toLocaleString()})
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ marginTop: 8, fontWeight: 800 }}>
                      Total polygons: {selectedVersionMetrics.polygons} → {currentProjectMetrics.polygons}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    Tip: click <b>Compare</b> on a snapshot to inspect what changed by layer.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showCommandPalette && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setShowCommandPalette(false);
            setCommandPaletteQuery("");
            setCommandPaletteIndex(0);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10003,
            background: "rgba(0,0,0,0.64)",
            display: "grid",
            placeItems: "start center",
            padding: "7vh 16px 16px",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(760px, 100%)",
              background: "#0d1016",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 14,
              boxShadow: "0 28px 70px rgba(0,0,0,0.6)",
              overflow: "hidden",
            }}
          >
            <input
              ref={commandPaletteInputRef}
              value={commandPaletteQuery}
              onChange={(event) => setCommandPaletteQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setShowCommandPalette(false);
                  setCommandPaletteQuery("");
                  setCommandPaletteIndex(0);
                  return;
                }
                if (!filteredCommandActions.length) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setCommandPaletteIndex((prev) => (prev + 1) % filteredCommandActions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setCommandPaletteIndex((prev) =>
                    (prev - 1 + filteredCommandActions.length) % filteredCommandActions.length
                  );
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const action =
                    filteredCommandActions[Math.max(0, Math.min(commandPaletteIndex, filteredCommandActions.length - 1))];
                  runCommandPaletteAction(action);
                }
              }}
              placeholder="Type a command (save, history, ai, segmentation, home...)"
              style={{
                width: "100%",
                padding: "14px 14px",
                border: "none",
                borderBottom: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.02)",
                color: "#fff",
                fontSize: 15,
                outline: "none",
              }}
            />
            <div style={{ maxHeight: "58vh", overflow: "auto" }}>
              {!filteredCommandActions.length ? (
                <div style={{ padding: "14px 14px", fontSize: 12, opacity: 0.72 }}>
                  No matching commands.
                </div>
              ) : (
                filteredCommandActions.map((action, idx) => {
                  const selected = idx === commandPaletteIndex;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => runCommandPaletteAction(action)}
                      disabled={!!action.disabled}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        border: "none",
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        background: selected ? "rgba(0,140,255,0.20)" : "transparent",
                        color: action.disabled ? "rgba(255,255,255,0.45)" : "#fff",
                        cursor: action.disabled ? "not-allowed" : "pointer",
                        padding: "10px 14px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontWeight: 800, fontSize: 13 }}>{action.label}</div>
                        {action.shortcut ? (
                          <div style={{ fontSize: 11, opacity: 0.75 }}>{action.shortcut}</div>
                        ) : null}
                      </div>
                      {action.detail ? (
                        <div style={{ fontSize: 11, opacity: 0.72, marginTop: 2 }}>{action.detail}</div>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {showShortcutHelp && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10001,
            background: "rgba(0,0,0,0.60)",
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={() => setShowShortcutHelp(false)}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(620px, 100%)",
              background: "#0f0f0f",
              border: "1px solid rgba(255,255,255,0.16)",
              borderRadius: 14,
              boxShadow: "0 24px 70px rgba(0,0,0,0.55)",
              padding: 14,
              color: "#fff",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 18, fontWeight: 900 }}>Keyboard Shortcuts</div>
              <button
                type="button"
                onClick={() => setShowShortcutHelp(false)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.08)",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Close
              </button>
            </div>
            {[
              ["Cmd/Ctrl + K", "Open command palette"],
              ["Shift + ?", "Open shortcut help"],
              ["Cmd/Ctrl + S", "Save project JSON + shared sync"],
              ["Cmd/Ctrl + Z", "Undo edit"],
              ["Cmd/Ctrl + Shift + Z", "Redo edit"],
              ["P", "Draw polygon mode"],
              ["Esc", "Select/pan mode"],
              ["Delete / Backspace", "Delete selected features"],
              ["1 / 2 / 3 / 4", "Switch active layer"],
            ].map(([combo, desc]) => (
              <div
                key={`shortcut-${combo}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "170px 1fr",
                  gap: 10,
                  padding: "7px 0",
                  borderBottom: "1px dashed rgba(255,255,255,0.10)",
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 800 }}>{combo}</div>
                <div style={{ opacity: 0.82 }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showWorkflowPicker && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10001,
            background: "rgba(0,0,0,0.62)",
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "min(720px, 100%)",
              background: "#0f0f0f",
              border: "1px solid rgba(255,255,255,0.16)",
              borderRadius: 16,
              boxShadow: "0 24px 70px rgba(0,0,0,0.55)",
              padding: 16,
              color: "#fff",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>
              Choose Measurement Mode
            </div>
            <div style={{ fontSize: 13, opacity: 0.82, marginBottom: 12 }}>
              Pick the workflow you want to start with. You can switch anytime.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button
                type="button"
                onClick={() => openMeasurementScreen(WORKFLOW_MODE_LOCATION)}
                style={{
                  padding: "14px 12px",
                  borderRadius: 12,
                  border:
                    workflowMode === WORKFLOW_MODE_LOCATION
                      ? "1px solid rgba(130,220,255,0.8)"
                      : "1px solid rgba(255,255,255,0.16)",
                  background:
                    workflowMode === WORKFLOW_MODE_LOCATION
                      ? "rgba(0,140,255,0.2)"
                      : "rgba(255,255,255,0.04)",
                  color: "#fff",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 800, marginBottom: 4 }}>Measure Location</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  Load boundary by KML or search by property address.
                </div>
              </button>
              <button
                type="button"
                onClick={() => openMeasurementScreen(WORKFLOW_MODE_PDF)}
                style={{
                  padding: "14px 12px",
                  borderRadius: 12,
                  border:
                    workflowMode === WORKFLOW_MODE_PDF
                      ? "1px solid rgba(130,220,255,0.8)"
                      : "1px solid rgba(255,255,255,0.16)",
                  background:
                    workflowMode === WORKFLOW_MODE_PDF
                      ? "rgba(0,140,255,0.2)"
                      : "rgba(255,255,255,0.04)",
                  color: "#fff",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 800, marginBottom: 4 }}>Measure PDF / Image</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  Upload a PDF plan and measure directly on the overlaid page.
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="sidebar"
        style={{
          width: isCompactTouchUi ? 340 : 420,
          maxWidth: isCompactTouchUi ? "58vw" : "42vw",
          minWidth: isCompactTouchUi ? 300 : 420,
          background: "#0b0b0b",
          color: "#fff",
          borderRight: "1px solid rgba(255,255,255,0.08)",
          padding: 14,
          overflow: "auto",
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <img
            src="/logo.png"
            alt="McKenna Site Management"
            style={{
              width: "100%",
              maxHeight: 220,
              objectFit: "contain",
              display: "block",
            }}
          />
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 8 }}>Takeoff Tool</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Mode: <span style={{ fontWeight: 700 }}>{drawModeLabel}</span>
            {isEditing ? " • editing" : ""}
          </div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
            Page:{" "}
            <span style={{ fontWeight: 700 }}>
              {workflowMode === WORKFLOW_MODE_PDF
                ? "PDF/Image Measuring"
                : "Location Measuring"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAppScreen(APP_SCREEN_HOME)}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              fontSize: 12,
            }}
          >
            Back to Home
          </button>
        </div>

        <div
          style={{
            padding: 10,
            border: "1px solid rgba(255,255,255,0.10)",
            borderRadius: 12,
            marginBottom: 12,
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Workspace Status</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div
              style={{
                fontSize: 12,
                padding: "3px 8px",
                borderRadius: 999,
                border: hasUnsavedChanges
                  ? "1px solid rgba(255,160,110,0.55)"
                  : "1px solid rgba(96,220,154,0.55)",
                background: hasUnsavedChanges
                  ? "rgba(182,110,46,0.24)"
                  : "rgba(26,154,92,0.20)",
                fontWeight: 700,
              }}
            >
              {saveStatusLabel}
            </div>
            <div
              style={{
                fontSize: 12,
                padding: "3px 8px",
                borderRadius: 999,
                border: sharedStatusUi.border,
                background: sharedStatusUi.background,
                fontWeight: 700,
              }}
            >
              {sharedStatusUi.label}
            </div>
          </div>
          {activeSharedProjectMeta?.id ? (
            <div style={{ fontSize: 11, opacity: 0.72, marginTop: 7, lineHeight: 1.35 }}>
              Shared file: {activeSharedProjectMeta.id}
              {activeSharedProjectMeta.savedBy ? ` • by ${activeSharedProjectMeta.savedBy}` : ""}
              {activeSharedProjectMeta.lastEditedAt
                ? ` • ${new Date(activeSharedProjectMeta.lastEditedAt).toLocaleString()}`
                : ""}
            </div>
          ) : null}
        </div>

        {remoteSharedUpdateNotice ? (
          <div
            style={{
              padding: 10,
              border: "1px solid rgba(255,170,96,0.6)",
              borderRadius: 12,
              marginBottom: 12,
              background: "rgba(190,105,34,0.24)",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 4 }}>
              Shared Update Detected
            </div>
            <div style={{ fontSize: 12, opacity: 0.88, lineHeight: 1.35 }}>
              {remoteSharedUpdateNotice.savedBy || "Another user"} edited this project{" "}
              {remoteSharedUpdateNotice.lastEditedAt
                ? `at ${new Date(remoteSharedUpdateNotice.lastEditedAt).toLocaleString()}.`
                : "recently."}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
              <button
                type="button"
                onClick={() => loadProjectFromLibrary(remoteSharedUpdateNotice.id)}
                style={{
                  padding: "7px 8px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.24)",
                  background: "rgba(255,255,255,0.08)",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                Reload Shared
              </button>
              <button
                type="button"
                onClick={() => saveProject({ downloadFile: false, forceOverwrite: true })}
                disabled={saveInProgress}
                style={{
                  padding: "7px 8px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.24)",
                  background: "rgba(0,140,255,0.16)",
                  color: "#fff",
                  cursor: saveInProgress ? "not-allowed" : "pointer",
                  opacity: saveInProgress ? 0.6 : 1,
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                Overwrite Shared
              </button>
            </div>
            <button
              type="button"
              onClick={() => setRemoteSharedUpdateNotice(null)}
              style={{
                width: "100%",
                marginTop: 6,
                padding: "6px 8px",
                borderRadius: 9,
                border: "1px solid rgba(255,255,255,0.20)",
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        <div
          style={{
            padding: 10,
            border: "1px solid rgba(255,255,255,0.10)",
            borderRadius: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Quick Actions</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            <button
              type="button"
              onClick={() => {
                setShowShortcutHelp(false);
                setShowCommandPalette(true);
              }}
              style={{
                padding: "7px 8px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              Command (⌘K)
            </button>
            <button
              type="button"
              onClick={() => setShowVersionHistory(true)}
              style={{
                padding: "7px 8px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              Version History
            </button>
            <button
              type="button"
              onClick={() => setShowShortcutHelp(true)}
              style={{
                padding: "7px 8px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              Shortcuts (?)
            </button>
          </div>
        </div>

        {activeOperations.length > 0 ? (
          <div
            style={{
              padding: 10,
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 12,
              marginBottom: 12,
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
              Active Operations ({activeOperations.length})
            </div>
            {activeOperations.map((operation) => (
              <div
                key={`op-${operation.id}`}
                style={{
                  padding: "7px 0",
                  borderBottom: "1px dashed rgba(255,255,255,0.10)",
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontWeight: 700 }}>{operation.label}</span>
                  {operation.canCancel ? (
                    <button
                      type="button"
                      onClick={() => cancelOperationById(operation.id)}
                      style={{
                        padding: "3px 7px",
                        borderRadius: 999,
                        border: "1px solid rgba(255,170,96,0.5)",
                        background: "rgba(165,90,28,0.22)",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 700,
                        fontSize: 11,
                      }}
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
                {operation.detail ? (
                  <div style={{ opacity: 0.72, marginTop: 2, lineHeight: 1.3 }}>
                    {operation.detail}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10 }}>
          MapTiler key: {keyStatus.maptiler ? "LOADED ✅" : "MISSING ❌"}
          <br />
          Mapbox token: {keyStatus.mapbox ? "LOADED ✅" : "MISSING ❌"}
          <br />
          Azure key: {keyStatus.azure ? "LOADED ✅" : "MISSING ❌"}
          <br />
          Google Maps key: {keyStatus.google ? "LOADED ✅" : "MISSING ❌"}
        </div>

        {/* Basemap */}
        {workflowMode !== WORKFLOW_MODE_PDF ? (
          <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Basemap</div>

            <select
              value={baseMap}
              onChange={(e) => setBaseMap(e.target.value)}
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "#111",
                color: "#fff",
              }}
              aria-label="Basemap"
            >
              <option value="maptiler">MapTiler (Satellite)</option>
              <option value="google" disabled={!googleMapsKey}>
                Google Maps (Satellite){!googleMapsKey ? " — missing key" : ""}
              </option>
              <option value="mapbox" disabled={!mapboxToken}>
                Mapbox (Satellite){!mapboxToken ? " — missing token" : ""}
              </option>
              <option value="azure" disabled={!azureMapsKey}>
                Azure (Aerial){!azureMapsKey ? " — missing key" : ""}
              </option>
            </select>

            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input
                type="checkbox"
                checked={azureHybridLabels}
                onChange={(e) => setAzureHybridLabels(e.target.checked)}
                disabled={baseMap !== "azure"}
              />
              <span style={{ fontSize: 13 }}>Azure: labels/roads overlay</span>
            </label>

            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input
                type="checkbox"
                checked={review3d}
                onChange={(e) => setReview3d(e.target.checked)}
              />
              <span style={{ fontSize: 13 }}>3D Review Mode (tilt)</span>
            </label>

            <button
              type="button"
              onClick={openTrue3DViewer}
              style={{
                width: "100%",
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Open True 3D Viewer
            </button>

            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8, lineHeight: 1.35 }}>
              Note: Azure aerial is raster and can go blank if zoomed beyond tile max.
              This clamps Azure to zoom ≤ 19. True terrain and 3D objects are temporarily disabled.
            </div>
          </div>
        ) : (
          <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 6, fontWeight: 700 }}>
              PDF/Image Canvas Mode
            </div>
            <div style={{ fontSize: 12, opacity: 0.74, lineHeight: 1.35 }}>
              Basemap is hidden in PDF mode so you edit only on the uploaded file.
            </div>
          </div>
        )}

        {/* Project name */}
        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Project Name</div>
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="e.g., 45 Liberty Boulevard"
            style={{
              width: "100%",
              padding: 8,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "#111",
              color: "#fff",
            }}
            aria-label="Project name"
          />
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
            Used in project file and download filename.
          </div>
        </div>

        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Pages</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button
              type="button"
              onClick={() => openMeasurementScreen(WORKFLOW_MODE_LOCATION)}
              style={{
                padding: "9px 10px",
                borderRadius: 10,
                cursor: "pointer",
                border:
                  workflowMode === WORKFLOW_MODE_LOCATION
                    ? "1px solid rgba(130, 220, 255, 0.8)"
                    : "1px solid rgba(255,255,255,0.12)",
                background:
                  workflowMode === WORKFLOW_MODE_LOCATION
                    ? "rgba(0, 140, 255, 0.2)"
                    : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              Measure Location
            </button>
            <button
              type="button"
              onClick={() => openMeasurementScreen(WORKFLOW_MODE_PDF)}
              style={{
                padding: "9px 10px",
                borderRadius: 10,
                cursor: "pointer",
                border:
                  workflowMode === WORKFLOW_MODE_PDF
                    ? "1px solid rgba(130, 220, 255, 0.8)"
                    : "1px solid rgba(255,255,255,0.12)",
                background:
                  workflowMode === WORKFLOW_MODE_PDF
                    ? "rgba(0, 140, 255, 0.2)"
                    : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              Measure PDF/Image
            </button>
          </div>
          <div style={{ fontSize: 12, opacity: 0.74, marginTop: 8, lineHeight: 1.35 }}>
            {workflowMode === WORKFLOW_MODE_PDF
              ? "PDF/Image mode: upload a PDF or image in AI Measurement, then draw and segment on top."
              : "Location mode: load boundary from KML/KMZ or lookup by address first."}
          </div>
          <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>
            Current page:{" "}
            {workflowMode === WORKFLOW_MODE_PDF
              ? "PDF/Image Measuring Page"
              : "Location Measuring Page"}
          </div>
          <button
            type="button"
            onClick={() => setShowWorkflowPicker(true)}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.05)",
              color: "#fff",
              fontWeight: 700,
              fontSize: 12,
            }}
          >
            Open Page Picker
          </button>
        </div>

        {/* Boundary upload */}
        {workflowMode === WORKFLOW_MODE_LOCATION ? (
          <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
            1) Load Property Boundary (KML/KMZ)
          </div>
          <input type="file" accept=".kml,.kmz" onChange={onUpload} aria-label="Upload boundary KML/KMZ" />
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 10, marginBottom: 6 }}>
            or Lookup Property by Address
          </div>
          <select
            value={propertyLookupProvider}
            onChange={(e) => {
              setPropertyLookupProvider(e.target.value);
              setPropertyLookupSuggestions([]);
              setPropertyLookupSuggestOpen(false);
              setPropertyLookupSuggestIndex(-1);
            }}
            style={{
              width: "100%",
              padding: 8,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "#111",
              color: "#fff",
              marginBottom: 8,
            }}
            aria-label="Property lookup provider"
          >
            <option value={PROPERTY_LOOKUP_PROVIDER_GOOGLE} disabled={!googleMapsKey}>
              Google Maps Places
            </option>
            <option value={PROPERTY_LOOKUP_PROVIDER_MAPTILER} disabled={!maptilerKey}>
              MapTiler Geocoding
            </option>
          </select>
          <div style={{ position: "relative", marginBottom: 8 }}>
            <input
              value={propertyLookupQuery}
              onChange={(e) => {
                setPropertyLookupQuery(e.target.value);
                setPropertyLookupSuggestOpen(true);
                setPropertyLookupSuggestIndex(-1);
              }}
              onFocus={() => {
                if (propertyLookupSuggestions.length) {
                  setPropertyLookupSuggestOpen(true);
                }
              }}
              onBlur={() => {
                setTimeout(() => setPropertyLookupSuggestOpen(false), 120);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  if (!propertyLookupSuggestions.length) return;
                  e.preventDefault();
                  setPropertyLookupSuggestOpen(true);
                  setPropertyLookupSuggestIndex((prev) => {
                    if (prev < 0) return 0;
                    return (prev + 1) % propertyLookupSuggestions.length;
                  });
                  return;
                }
                if (e.key === "ArrowUp") {
                  if (!propertyLookupSuggestions.length) return;
                  e.preventDefault();
                  setPropertyLookupSuggestOpen(true);
                  setPropertyLookupSuggestIndex((prev) => {
                    if (prev < 0) return propertyLookupSuggestions.length - 1;
                    return (prev - 1 + propertyLookupSuggestions.length) % propertyLookupSuggestions.length;
                  });
                  return;
                }
                if (e.key === "Escape") {
                  setPropertyLookupSuggestOpen(false);
                  setPropertyLookupSuggestIndex(-1);
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (
                    propertyLookupSuggestOpen &&
                    propertyLookupSuggestIndex >= 0 &&
                    propertyLookupSuggestIndex < propertyLookupSuggestions.length
                  ) {
                    const selected = propertyLookupSuggestions[propertyLookupSuggestIndex];
                    const label = getLookupFeatureLabel(selected, propertyLookupQuery);
                    setPropertyLookupQuery(label);
                    lookupPropertyByAddress(selected);
                    return;
                  }
                  lookupPropertyByAddress();
                }
              }}
              placeholder="e.g., 123 Main St or Christiana Mall"
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "#111",
                color: "#fff",
              }}
              aria-label="Lookup property address"
            />
            {propertyLookupSuggestOpen && (propertyLookupSuggestLoading || propertyLookupSuggestions.length > 0) && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 20,
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "#0f0f0f",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                {propertyLookupSuggestLoading && !propertyLookupSuggestions.length ? (
                  <div style={{ padding: "8px 10px", fontSize: 12, opacity: 0.75 }}>
                    Searching addresses...
                  </div>
                ) : (
                  propertyLookupSuggestions.map((feature, idx) => {
                    const label = getLookupFeatureLabel(feature, propertyLookupQuery) || "Unnamed result";
                    const selected = idx === propertyLookupSuggestIndex;
                    return (
                      <button
                        key={`${label}-${idx}`}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setPropertyLookupQuery(label);
                          setPropertyLookupSuggestOpen(false);
                          setPropertyLookupSuggestIndex(idx);
                          lookupPropertyByAddress(feature);
                        }}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          background: selected ? "rgba(255,255,255,0.12)" : "transparent",
                          color: "#fff",
                          border: "none",
                          borderBottom:
                            idx < propertyLookupSuggestions.length - 1
                              ? "1px solid rgba(255,255,255,0.08)"
                              : "none",
                          padding: "8px 10px",
                          fontSize: 12,
                          cursor: "pointer",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
          <button
            onClick={lookupPropertyByAddress}
            disabled={propertyLookupLoading || !propertyLookupQuery.trim()}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              cursor:
                propertyLookupLoading || !propertyLookupQuery.trim()
                  ? "not-allowed"
                  : "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background:
                propertyLookupLoading || !propertyLookupQuery.trim()
                  ? "rgba(255,255,255,0.03)"
                  : "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              opacity: propertyLookupLoading || !propertyLookupQuery.trim() ? 0.6 : 1,
            }}
          >
            {propertyLookupLoading ? "Looking Up Property..." : "Lookup Property"}
          </button>
          <button
            type="button"
            onClick={cancelPropertyLookup}
            disabled={!propertyLookupLoading && !propertyLookupSuggestLoading}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              marginTop: 8,
              cursor:
                !propertyLookupLoading && !propertyLookupSuggestLoading
                  ? "not-allowed"
                  : "pointer",
              border: "1px solid rgba(255,170,96,0.5)",
              background:
                !propertyLookupLoading && !propertyLookupSuggestLoading
                  ? "rgba(255,255,255,0.03)"
                  : "rgba(165,90,28,0.2)",
              color: "#fff",
              fontWeight: 700,
              opacity:
                !propertyLookupLoading && !propertyLookupSuggestLoading ? 0.55 : 1,
            }}
          >
            Cancel Lookup
          </button>
          <button
            onClick={toggleBoundaryDraw}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              marginTop: 8,
              cursor: "pointer",
              border: drawingBoundary
                ? "1px solid rgba(130, 220, 255, 0.8)"
                : "1px solid rgba(255,255,255,0.12)",
              background: drawingBoundary
                ? "rgba(0, 140, 255, 0.2)"
                : "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              opacity: 1,
            }}
          >
            {drawingBoundary ? "Cancel Boundary Draw" : "Draw Boundary on Map"}
          </button>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
            Boundary will be highlighted. After lookup, you can draw your exact boundary and apply it.
          </div>
          </div>
        ) : (
          <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
              1) PDF / Image Setup
            </div>
            <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
              Use the AI Measurement panel below to upload a PDF or image and turn on
              `Show uploaded plan on map`. Then use `Quick Distance (2 Points)` to calibrate.
            </div>
          </div>
        )}

        {/* Active layer */}
        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            {workflowMode === WORKFLOW_MODE_LOCATION ? "2) Active Editing Layer" : "2) Draw/Edit Layer"}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {LAYER_KEYS.map((k) => {
              const active = activeLayer === k;
              return (
                <button
                  key={k}
                  onClick={() => switchActiveLayer(k)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 12,
                    cursor: "pointer",
                    border: active
                      ? "1px solid rgba(255,255,255,0.35)"
                      : "1px solid rgba(255,255,255,0.12)",
                    background: active ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 99,
                      background: LAYER_COLORS[k].line,
                      boxShadow: "0 0 0 2px rgba(0,0,0,0.35)",
                    }}
                  />
                  {LAYER_META[k].name}
                </button>
              );
            })}
          </div>

          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
            Outlines stay bold normally and go thinner while editing so you can grab vertices.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <button
              onClick={switchToDrawMode}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                cursor: "pointer",
                border:
                  drawMode === "draw_polygon"
                    ? "1px solid rgba(130, 220, 255, 0.8)"
                    : "1px solid rgba(255,255,255,0.12)",
                background:
                  drawMode === "draw_polygon"
                    ? "rgba(0, 140, 255, 0.2)"
                    : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
              }}
            >
              Draw Mode
            </button>
            <button
              onClick={switchToPanMode}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                cursor: "pointer",
                border:
                  drawMode === "simple_select"
                    ? "1px solid rgba(130, 220, 255, 0.8)"
                    : "1px solid rgba(255,255,255,0.12)",
                background:
                  drawMode === "simple_select"
                    ? "rgba(0, 140, 255, 0.2)"
                    : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
              }}
            >
              Pan / Select
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <button
              onClick={undoLayerEdit}
              disabled={!canUndo}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                cursor: canUndo ? "pointer" : "not-allowed",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
                opacity: canUndo ? 1 : 0.55,
              }}
            >
              Undo
            </button>
            <button
              onClick={redoLayerEdit}
              disabled={!canRedo}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                cursor: canRedo ? "pointer" : "not-allowed",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
                opacity: canRedo ? 1 : 0.55,
              }}
            >
              Redo
            </button>
          </div>

          <div
            style={{
              marginTop: 8,
              padding: 8,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={snapToEdges}
                onChange={(e) => setSnapToEdges(e.target.checked)}
              />
              <span style={{ fontSize: 13 }}>Snap new polygons to curb/road edges</span>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input
                type="checkbox"
                checked={applePencilMode}
                onChange={(e) => setApplePencilMode(e.target.checked)}
              />
              <span style={{ fontSize: 13 }}>Apple Pencil mode (finger pan, pencil draw)</span>
            </label>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginTop: 8,
              }}
            >
              <span style={{ fontSize: 12, opacity: 0.8 }}>Snap distance (meters)</span>
              <input
                type="number"
                min="0.25"
                max="20"
                step="0.25"
                value={snapDistanceM}
                onChange={(e) => setSnapDistanceM(e.target.value)}
                style={{
                  marginLeft: "auto",
                  width: 90,
                  padding: "6px 8px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "#111",
                  color: "#fff",
                }}
              />
            </div>
          </div>

          <div style={{ fontSize: 12, opacity: 0.68, marginTop: 6 }}>
            Shortcuts: `P` draw, `Esc` select, `Delete` remove selected, `Cmd/Ctrl+Z` undo,
            `Cmd/Ctrl+K` command palette, `Shift+?` shortcut help.
          </div>
        </div>

        {/* Visibility + boundary controls */}
        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            Layer Visibility
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button
              onClick={() =>
                setLayerVisible({
                  plowable: true,
                  sidewalks: true,
                  turf: true,
                  mulch: true,
                })
              }
              style={{
                flex: 1,
                padding: "7px 8px",
                borderRadius: 10,
                cursor: "pointer",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Show All Layers
            </button>
          </div>

          {LAYER_KEYS.map((k) => (
            <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={!!layerVisible[k]}
                onChange={(e) =>
                  setLayerVisible((p) => ({ ...p, [k]: e.target.checked }))
                }
              />
              <span style={{ fontSize: 13 }}>{LAYER_META[k].name}</span>
            </label>
          ))}

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input
              type="checkbox"
              checked={lockNonActiveLayers}
              onChange={(e) => setLockNonActiveLayers(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>
              Lock non-active layers (visible but not selectable)
            </span>
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <input
              type="checkbox"
              checked={maskOutsideBoundary}
              onChange={(e) => setMaskOutsideBoundary(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>Dim outside boundary</span>
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <input
              type="checkbox"
              checked={warnOutsideBoundary}
              onChange={(e) => setWarnOutsideBoundary(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>Warn if outside boundary</span>
          </label>

          <button
            onClick={clipAllPolygonsToBoundary}
            disabled={!boundary}
            style={{
              marginTop: 10,
              width: "100%",
              padding: "9px 10px",
              borderRadius: 12,
              cursor: boundary ? "pointer" : "not-allowed",
              border: "1px solid rgba(255,255,255,0.12)",
              background: boundary ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
              color: "#fff",
              opacity: boundary ? 1 : 0.6,
              fontWeight: 700,
            }}
          >
            Clip All Polygons to Boundary
          </button>

          <button
            onClick={toggleTurfErase}
            disabled={(!layerFeatures.turf || layerFeatures.turf.length === 0) && !turfEraseMode}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "9px 10px",
              borderRadius: 12,
              cursor:
                ((!layerFeatures.turf || layerFeatures.turf.length === 0) && !turfEraseMode)
                  ? "not-allowed"
                  : "pointer",
              border: turfEraseMode
                ? "1px solid rgba(130, 220, 255, 0.8)"
                : "1px solid rgba(255,255,255,0.12)",
              background: turfEraseMode
                ? "rgba(0, 140, 255, 0.2)"
                : "rgba(255,255,255,0.06)",
              color: "#fff",
              opacity:
                ((!layerFeatures.turf || layerFeatures.turf.length === 0) && !turfEraseMode)
                  ? 0.6
                  : 1,
              fontWeight: 700,
            }}
          >
            {turfEraseMode ? "Cancel Turf Erase" : "Erase Turf (Draw)"}
          </button>

          <button
            onClick={cleanupTurfQuick}
            disabled={!boundary || !layerFeatures.turf || layerFeatures.turf.length === 0}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "9px 10px",
              borderRadius: 12,
              cursor:
                !boundary || !layerFeatures.turf || layerFeatures.turf.length === 0
                  ? "not-allowed"
                  : "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background:
                !boundary || !layerFeatures.turf || layerFeatures.turf.length === 0
                  ? "rgba(255,255,255,0.03)"
                  : "rgba(255,255,255,0.06)",
              color: "#fff",
              opacity:
                !boundary || !layerFeatures.turf || layerFeatures.turf.length === 0
                  ? 0.6
                  : 1,
              fontWeight: 700,
            }}
          >
            Turf Quick Cleanup
          </button>

          {aiEnabled && workflowMode !== WORKFLOW_MODE_PDF && (
            <button
              onClick={autoMeasureExperimental}
              disabled={!boundary || autoMeasuring}
              style={{
                marginTop: 8,
                width: "100%",
                padding: "9px 10px",
                borderRadius: 12,
                cursor: !boundary || autoMeasuring ? "not-allowed" : "pointer",
                border: "1px solid rgba(255,255,255,0.12)",
                background:
                  !boundary || autoMeasuring
                    ? "rgba(255,255,255,0.03)"
                    : "rgba(255,255,255,0.06)",
                color: "#fff",
                opacity: !boundary || autoMeasuring ? 0.6 : 1,
                fontWeight: 700,
              }}
            >
              {autoMeasuring ? "Running AI Takeoff..." : "Run AI Takeoff (Stable)"}
            </button>
          )}
        </div>

        {workflowMode === WORKFLOW_MODE_PDF && (
          <div
            style={{
              padding: 10,
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 12,
              marginBottom: 12,
              background:
                "linear-gradient(145deg, rgba(25,27,38,0.95) 0%, rgba(11,12,18,0.95) 100%)",
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.86, marginBottom: 8, fontWeight: 800 }}>
              PDF Expert Annotation Toolbar
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 6 }}>
              {[
                { key: "select", label: "Select" },
                { key: "pen", label: "Pen" },
                { key: "marker", label: "Marker" },
                { key: "shape", label: "Shape" },
                { key: "text", label: "Text" },
              ].map((tool) => {
                const active = pdfAnnotationTool === tool.key;
                return (
                  <button
                    key={`pdf-annot-tool-${tool.key}`}
                    type="button"
                    onClick={() => activatePdfAnnotationTool(tool.key)}
                    style={{
                      padding: "8px 6px",
                      borderRadius: 10,
                      cursor: "pointer",
                      border: active
                        ? "1px solid rgba(130,220,255,0.85)"
                        : "1px solid rgba(255,255,255,0.12)",
                      background: active ? "rgba(0,140,255,0.20)" : "rgba(255,255,255,0.05)",
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  >
                    {tool.label}
                  </button>
                );
              })}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: 8,
                alignItems: "center",
                marginTop: 8,
              }}
            >
              <label style={{ fontSize: 12, opacity: 0.82 }}>Color</label>
              <input
                type="color"
                value={normalizeHexColor(pdfAnnotationColor, PDF_ANNOT_DEFAULT_COLOR)}
                onChange={(e) => setPdfAnnotationColor(e.target.value)}
                style={{
                  width: "100%",
                  height: 34,
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "#111",
                }}
                aria-label="PDF annotation color"
              />
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.82, marginBottom: 4 }}>
                {pdfAnnotationTool === "marker" ? "Marker Width" : "Pen/Shape Width"}:{" "}
                {Number(pdfAnnotationWidth).toFixed(0)}
              </div>
              <input
                type="range"
                min="1"
                max="30"
                step="1"
                value={pdfAnnotationWidth}
                onChange={(e) => setPdfAnnotationWidth(Number(e.target.value))}
                style={{ width: "100%", accentColor: "#6dd6ff" }}
                aria-label="PDF annotation stroke width"
              />
            </div>

            <label style={{ fontSize: 12, opacity: 0.82, display: "block", marginTop: 8, marginBottom: 4 }}>
              Text to place on PDF
            </label>
            <input
              value={pdfAnnotationTextDraft}
              onChange={(e) => setPdfAnnotationTextDraft(e.target.value)}
              placeholder="Type note, then click PDF to place"
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "#111",
                color: "#fff",
              }}
              aria-label="PDF annotation text"
            />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
              <button
                type="button"
                onClick={removeLastPdfAnnotation}
                disabled={!Array.isArray(pdfAnnotations) || pdfAnnotations.length === 0}
                style={{
                  padding: "8px 9px",
                  borderRadius: 10,
                  cursor:
                    Array.isArray(pdfAnnotations) && pdfAnnotations.length > 0
                      ? "pointer"
                      : "not-allowed",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background:
                    Array.isArray(pdfAnnotations) && pdfAnnotations.length > 0
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(255,255,255,0.03)",
                  color: "#fff",
                  opacity:
                    Array.isArray(pdfAnnotations) && pdfAnnotations.length > 0 ? 1 : 0.6,
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                Undo Last Markup
              </button>
              <button
                type="button"
                onClick={clearPdfAnnotations}
                disabled={!Array.isArray(pdfAnnotations) || pdfAnnotations.length === 0}
                style={{
                  padding: "8px 9px",
                  borderRadius: 10,
                  cursor:
                    Array.isArray(pdfAnnotations) && pdfAnnotations.length > 0
                      ? "pointer"
                      : "not-allowed",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background:
                    Array.isArray(pdfAnnotations) && pdfAnnotations.length > 0
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(255,255,255,0.03)",
                  color: "#fff",
                  opacity:
                    Array.isArray(pdfAnnotations) && pdfAnnotations.length > 0 ? 1 : 0.6,
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                Clear Markups
              </button>
            </div>

            <div style={{ fontSize: 11, opacity: 0.72, marginTop: 8, lineHeight: 1.35 }}>
              Pen/Marker/Shape: draw directly on the PDF. Text: click the PDF to place typed notes.
            </div>
          </div>
        )}

        {SHOW_TWO_POINT_MEASURE_TOOL && (
          <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
              {workflowMode === WORKFLOW_MODE_PDF
                ? "PDF Expert Distance Tool (2 Points)"
                : "Quick Distance (2 Points)"}
            </div>

            <button
              onClick={toggleMeasureMode}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 12,
                cursor: "pointer",
                border: measureMode
                  ? "1px solid rgba(130, 220, 255, 0.8)"
                  : "1px solid rgba(255,255,255,0.12)",
                background: measureMode ? "rgba(0, 140, 255, 0.2)" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
              }}
            >
              {measureMode ? "Measuring: Click 2 points" : "Measure 2 Points"}
            </button>

            <button
              onClick={clearMeasure}
              disabled={measurePoints.length === 0 && !measureResult}
              style={{
                marginTop: 8,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 10,
                cursor: measurePoints.length === 0 && !measureResult ? "not-allowed" : "pointer",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                fontWeight: 700,
                opacity: measurePoints.length === 0 && !measureResult ? 0.55 : 1,
              }}
            >
              Clear Measurement
            </button>

            {workflowMode === WORKFLOW_MODE_PDF && (
              <button
                type="button"
                onClick={applyCurrentMeasurementPixelsToCalibration}
                disabled={!measureResult || !Number.isFinite(Number(measureResult.pixels))}
                style={{
                  marginTop: 8,
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 10,
                  cursor:
                    !measureResult || !Number.isFinite(Number(measureResult.pixels))
                      ? "not-allowed"
                      : "pointer",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background:
                    !measureResult || !Number.isFinite(Number(measureResult.pixels))
                      ? "rgba(255,255,255,0.03)"
                      : "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 700,
                  opacity:
                    !measureResult || !Number.isFinite(Number(measureResult.pixels)) ? 0.55 : 1,
                }}
              >
                Use Measured Pixels as Calibration
              </button>
            )}

            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8, lineHeight: 1.35 }}>
              {displayedMeasureResult
                ? `${
                    Number.isFinite(Number(displayedMeasureResult.feet))
                      ? `${Number(displayedMeasureResult.feet).toFixed(2)} ft`
                      : "Set scale to compute feet"
                  } • ${displayedMeasureResult.pixels.toFixed(2)} px${
                    displayedMeasureResult.scaled ? " (scaled)" : ""
                  }`
                : measureMode
                ? `Point ${Math.min(measurePoints.length + 1, 2)} of 2`
                : "Turn on, then click two map points."}
            </div>

            {workflowMode === WORKFLOW_MODE_PDF && (
              <div style={{ fontSize: 11, opacity: 0.72, marginTop: 6, lineHeight: 1.35 }}>
                Enter scale below, measure a known scale-bar segment, then set calibration pixels.
              </div>
            )}
          </div>
        )}

        {aiEnabled && (
          <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
              {workflowMode === WORKFLOW_MODE_PDF
                ? "PDF Upload + Manual Calibration"
                : "AI Measurement (Backend)"}
            </div>

          {workflowMode !== WORKFLOW_MODE_PDF && (
            <>
              <label style={{ fontSize: 12, opacity: 0.8, display: "block", marginBottom: 6 }}>
                Measurement Type
              </label>
              <select
                value={measurementType}
                onChange={(e) => setMeasurementType(e.target.value)}
                style={{
                  width: "100%",
                  padding: 8,
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "#111",
                  color: "#fff",
                  marginBottom: 8,
                }}
                aria-label="Measurement type"
              >
                <option value="lawn_area">Lawn Area</option>
                <option value="driveway_area">Driveway Area</option>
                <option value="sidewalk_length">Sidewalk Length</option>
                <option value="parking_lot_area">Parking Lot Area</option>
                <option value="plow_route_length">Plow Route Length</option>
              </select>
            </>
          )}

          {workflowMode === WORKFLOW_MODE_PDF && (
            <div
              style={{
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 10,
                padding: 8,
                marginBottom: 8,
                background: "rgba(255,255,255,0.03)",
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 6, fontWeight: 700 }}>
                PDF Scale Helper (inches to feet)
              </div>

              <label style={{ fontSize: 12, opacity: 0.8, display: "block", marginBottom: 4 }}>
                Plan Distance (inches)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={pdfScaleInchesInput}
                onChange={(e) => setPdfScaleInchesInput(e.target.value)}
                style={{
                  width: "100%",
                  padding: 8,
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "#111",
                  color: "#fff",
                  marginBottom: 6,
                }}
                aria-label="Plan distance in inches"
              />

              <label style={{ fontSize: 12, opacity: 0.8, display: "block", marginBottom: 4 }}>
                Scale (feet per inch)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={pdfScaleFeetPerInchInput}
                onChange={(e) => setPdfScaleFeetPerInchInput(e.target.value)}
                style={{
                  width: "100%",
                  padding: 8,
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "#111",
                  color: "#fff",
                  marginBottom: 6,
                }}
                aria-label="Scale feet per inch"
              />

              <div style={{ fontSize: 12, opacity: 0.82, marginBottom: 6 }}>
                Real Distance:{" "}
                {Number.isFinite(pdfScaleDerivedFeet)
                  ? `${pdfScaleDerivedFeet.toFixed(2)} ft`
                  : "enter valid values"}
              </div>

              <div style={{ fontSize: 12, opacity: 0.78, marginBottom: 6 }}>
                Current calibration:{" "}
                {Number.isFinite(knownFeetPerPixel)
                  ? `${knownFeetPerPixel.toFixed(4)} ft/px`
                  : "not calibrated yet"}
              </div>

              <button
                type="button"
                onClick={applyPdfScaleToKnownFeet}
                disabled={!Number.isFinite(pdfScaleDerivedFeet) || pdfScaleDerivedFeet <= 0}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 10,
                  cursor:
                    !Number.isFinite(pdfScaleDerivedFeet) || pdfScaleDerivedFeet <= 0
                      ? "not-allowed"
                      : "pointer",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background:
                    !Number.isFinite(pdfScaleDerivedFeet) || pdfScaleDerivedFeet <= 0
                      ? "rgba(255,255,255,0.03)"
                      : "rgba(255,255,255,0.05)",
                  color: "#fff",
                  opacity:
                    !Number.isFinite(pdfScaleDerivedFeet) || pdfScaleDerivedFeet <= 0 ? 0.6 : 1,
                  fontWeight: 700,
                }}
              >
                Use Real Feet for Calibration
              </button>

              <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6, lineHeight: 1.35 }}>
                Example workflow: enter `1 in = 20 ft`, measure that scale bar with the 2-point tool,
                then click “Use Measured Pixels as Calibration”.
              </div>
            </div>
          )}

          <label style={{ fontSize: 12, opacity: 0.8, display: "block", marginBottom: 6 }}>
            Known Distance (Feet)
          </label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={knownDistanceFtInput}
            onChange={(e) => setKnownDistanceFtInput(e.target.value)}
            style={{
              width: "100%",
              padding: 8,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "#111",
              color: "#fff",
              marginBottom: 8,
            }}
            aria-label="Known distance in feet"
          />

          <label style={{ fontSize: 12, opacity: 0.8, display: "block", marginBottom: 6 }}>
            Known Distance (Pixels)
          </label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={knownDistancePixelsInput}
            onChange={(e) => setKnownDistancePixelsInput(e.target.value)}
            style={{
              width: "100%",
              padding: 8,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "#111",
              color: "#fff",
              marginBottom: 8,
            }}
            aria-label="Known distance in pixels"
          />
          <div style={{ fontSize: 12, opacity: 0.72, marginTop: -2, marginBottom: 8, lineHeight: 1.35 }}>
            Scale updates AI/CV result units (ft/sqft). It does not resize polygons already drawn on the map.
          </div>

          {SHOW_TWO_POINT_CALIBRATION && (
            <button
              onClick={calibrateFromTwoPoints}
              disabled={measurePoints.length !== 2 || backendCalibrating}
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 10,
                cursor:
                  measurePoints.length !== 2 || backendCalibrating
                    ? "not-allowed"
                    : "pointer",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                fontWeight: 700,
                marginBottom: 8,
                opacity: measurePoints.length !== 2 || backendCalibrating ? 0.55 : 1,
              }}
            >
              {backendCalibrating ? "Calibrating..." : "Use 2-Point Calibration"}
            </button>
          )}

          <label
            style={{
              display: "block",
              textAlign: "center",
              padding: "9px 10px",
              borderRadius: 12,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            {pdfConverting
              ? "Converting PDF page 1..."
              : measurementImageFile
              ? `Image: ${measurementImageFile.name}`
              : "Upload Image or PDF"}
            <input
              type="file"
              accept="image/*,.pdf,application/pdf"
              onChange={handleMeasurementMediaUpload}
              style={{ display: "none" }}
              aria-label="Upload measurement image or pdf"
            />
          </label>
          <div style={{ fontSize: 12, opacity: 0.72, marginTop: -4, marginBottom: 8 }}>
            PDF uploads convert page 1 to PNG and overlay it on the map.
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={planOverlayEnabled}
              disabled={!planOverlay}
              onChange={(e) => setPlanOverlayEnabled(e.target.checked)}
            />
            <span style={{ fontSize: 13, opacity: planOverlay ? 1 : 0.6 }}>
              Show uploaded plan on map
            </span>
          </label>

          <div style={{ marginTop: 2, marginBottom: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
              Plan Overlay Opacity: {Math.round(Number(planOverlayOpacity) * 100)}%
            </div>
            <input
              type="range"
              min="0.15"
              max="1"
              step="0.01"
              value={planOverlayOpacity}
              onChange={(e) => setPlanOverlayOpacity(Number(e.target.value))}
              disabled={!planOverlayEnabled}
              style={{
                width: "100%",
                accentColor: "#6dd6ff",
                opacity: planOverlayEnabled ? 1 : 0.45,
              }}
              aria-label="Plan overlay opacity"
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
            <button
              type="button"
              onClick={reanchorPlanOverlay}
              disabled={!planOverlay}
              style={{
                padding: "8px 9px",
                borderRadius: 10,
                cursor: planOverlay ? "pointer" : "not-allowed",
                border: "1px solid rgba(255,255,255,0.12)",
                background: planOverlay ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.03)",
                color: "#fff",
                opacity: planOverlay ? 1 : 0.6,
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              Re-anchor Plan
            </button>
            <button
              type="button"
              onClick={() => clearUploadedPlanOverlay(true)}
              disabled={!planOverlay && !measurementImageFile}
              style={{
                padding: "8px 9px",
                borderRadius: 10,
                cursor: planOverlay || measurementImageFile ? "pointer" : "not-allowed",
                border: "1px solid rgba(255,255,255,0.12)",
                background:
                  planOverlay || measurementImageFile
                    ? "rgba(255,255,255,0.05)"
                    : "rgba(255,255,255,0.03)",
                color: "#fff",
                opacity: planOverlay || measurementImageFile ? 1 : 0.6,
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              Clear Plan
            </button>
          </div>

          {workflowMode === WORKFLOW_MODE_PDF ? (
            <div style={{ fontSize: 12, opacity: 0.78, lineHeight: 1.35 }}>
              Manual PDF mode is active. Draw polygons by hand in your active layer and use
              `Quick Distance (2 Points)` + scale helper for calibration. AI/CV buttons are disabled in this mode.
            </div>
          ) : (
            <>
              <button
                onClick={boundary ? autoMeasureExperimental : runBackendMeasurement}
                disabled={
                  boundary ? autoMeasuring || pdfConverting : backendSubmitting || capturingMapImage || pdfConverting
                }
                style={{
                  width: "100%",
                  padding: "9px 10px",
                  borderRadius: 12,
                  cursor:
                    boundary
                      ? autoMeasuring || pdfConverting
                        ? "not-allowed"
                        : "pointer"
                      : backendSubmitting || capturingMapImage || pdfConverting
                      ? "not-allowed"
                      : "pointer",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background:
                    boundary
                      ? autoMeasuring || pdfConverting
                        ? "rgba(255,255,255,0.03)"
                        : "rgba(255,255,255,0.06)"
                      : backendSubmitting || capturingMapImage || pdfConverting
                      ? "rgba(255,255,255,0.03)"
                      : "rgba(255,255,255,0.06)",
                  color: "#fff",
                  opacity:
                    boundary
                      ? autoMeasuring || pdfConverting
                        ? 0.6
                        : 1
                      : backendSubmitting || capturingMapImage || pdfConverting
                      ? 0.6
                      : 1,
                  fontWeight: 700,
                  marginBottom: 8,
                }}
              >
                {boundary
                  ? autoMeasuring
                    ? "Running AI Takeoff..."
                    : pdfConverting
                    ? "Converting PDF..."
                    : "Run AI Takeoff (Stable)"
                  : capturingMapImage
                  ? "Capturing Property View..."
                  : pdfConverting
                  ? "Converting PDF..."
                  : backendSubmitting
                  ? "Running Measurement..."
                  : "Run AI Measurement"}
              </button>

              <button
                onClick={runSegmentationMeasurement}
                disabled={segmentingImage || pdfConverting || (!measurementImageFile && !boundary)}
                style={{
                  width: "100%",
                  padding: "9px 10px",
                  borderRadius: 12,
                  cursor:
                    segmentingImage || pdfConverting || (!measurementImageFile && !boundary)
                      ? "not-allowed"
                      : "pointer",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background:
                    segmentingImage || pdfConverting || (!measurementImageFile && !boundary)
                      ? "rgba(255,255,255,0.03)"
                      : "rgba(255,255,255,0.06)",
                  color: "#fff",
                  opacity: segmentingImage || pdfConverting || (!measurementImageFile && !boundary) ? 0.6 : 1,
                  fontWeight: 700,
                  marginBottom: 8,
                }}
              >
                {pdfConverting ? "Converting PDF..." : segmentingImage ? "Running Segmentation..." : "Run CV Segmentation (Beta)"}
              </button>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 6,
                  marginBottom: 8,
                }}
              >
                {LAYER_KEYS.map((key) => (
                  <button
                    key={`seg-class-${key}`}
                    onClick={() => runSegmentationMeasurement([key])}
                    disabled={segmentingImage || pdfConverting || (!measurementImageFile && !boundary)}
                    style={{
                      padding: "8px 9px",
                      borderRadius: 10,
                      cursor:
                        segmentingImage || pdfConverting || (!measurementImageFile && !boundary)
                          ? "not-allowed"
                          : "pointer",
                      border: "1px solid rgba(255,255,255,0.12)",
                      background:
                        segmentingImage || pdfConverting || (!measurementImageFile && !boundary)
                          ? "rgba(255,255,255,0.03)"
                          : "rgba(255,255,255,0.05)",
                      color: "#fff",
                      opacity: segmentingImage || pdfConverting || (!measurementImageFile && !boundary) ? 0.6 : 1,
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    {pdfConverting ? "Converting..." : segmentingImage ? "Running..." : `CV ${LAYER_META[key].name}`}
                  </button>
                ))}
              </div>

              <button
                onClick={refreshMeasurementHistory}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 10,
                  cursor: "pointer",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 700,
                  marginBottom: 8,
                }}
              >
                Refresh Measurement History
              </button>

              {backendMeasurementResult && (
                <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4, marginBottom: 8 }}>
                  <div>Area: {backendMeasurementResult.total_area_sqft.toFixed(2)} sqft</div>
                  <div>Length: {backendMeasurementResult.total_length_ft.toFixed(2)} ft</div>
                  <div>Confidence: {(backendMeasurementResult.confidence * 100).toFixed(0)}%</div>
                  {backendMeasurementResult.notes?.slice(0, 2).map((note, idx) => (
                    <div key={`note-${idx}`}>- {note}</div>
                  ))}
                </div>
              )}

              {segmentationResult && (
                <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4, marginBottom: 8 }}>
                  <div>
                    Segmentation confidence:
                    {" "}
                    P {Math.round((segmentationResult.plowable?.confidence || 0) * 100)}%
                    {" "}
                    S {Math.round((segmentationResult.sidewalks?.confidence || 0) * 100)}%
                    {" "}
                    T {Math.round((segmentationResult.turf?.confidence || 0) * 100)}%
                    {" "}
                    M {Math.round((segmentationResult.mulch?.confidence || 0) * 100)}%
                  </div>
                  {(segmentationResult.notes || []).slice(0, 4).map((note, idx) => (
                    <div key={`seg-note-${idx}`}>- {note}</div>
                  ))}
                  <button
                    type="button"
                    onClick={markCvPredictionWrongAndExport}
                    disabled={trainingExporting}
                    style={{
                      marginTop: 8,
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 10,
                      cursor: trainingExporting ? "not-allowed" : "pointer",
                      border: "1px solid rgba(255,170,96,0.55)",
                      background: "rgba(210,120,40,0.22)",
                      color: "#fff",
                      opacity: trainingExporting ? 0.6 : 1,
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    {trainingExporting
                      ? "Exporting Correction ZIP..."
                      : "Mark CV Wrong + Export Correction Sample"}
                  </button>
                  <div style={{ fontSize: 11, opacity: 0.72, marginTop: 5 }}>
                    Fix polygons first, then click this to create a retraining sample instantly.
                  </div>
                </div>
              )}

              <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
                {boundary?.geometry
                  ? "KML boundary loaded: measuring directly from property geometry. "
                  : !measurementImageFile
                  ? "No image uploaded: using current map view screenshot. "
                  : ""}
                {measurementHistory.length > 0
                  ? `Recent jobs: ${measurementHistory
                      .slice(0, 3)
                      .map((item) => `#${item.id} ${item.measurement_type}`)
                      .join(" • ")}`
                  : "No backend history yet."}
              </div>
            </>
          )}
          </div>
        )}

        {aiEnabled && (
          <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
              Active Learning Queue (Hardest Recent Jobs)
            </div>

            {!activeLearningQueue.length ? (
              <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
                No recent backend jobs yet. Run AI/CV jobs, correct polygons, then export training samples.
              </div>
            ) : (
              activeLearningQueue.map((item) => {
                const confidencePct = Math.round(Math.max(0, Math.min(1, Number(item.confidence || 0))) * 100);
                return (
                  <div
                    key={`alq-${item.id || item.measurementType}-${confidencePct}`}
                    style={{
                      padding: "7px 0",
                      borderBottom: "1px dashed rgba(255,255,255,0.10)",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ opacity: 0.92 }}>
                        #{item.id ?? "?"} {item.measurementType || "job"}
                      </span>
                      <span style={{ opacity: 0.85 }}>Conf: {confidencePct}%</span>
                    </div>
                    {!!item.notes?.length && (
                      <div style={{ opacity: 0.66, marginTop: 2 }}>
                        {String(item.notes[0])}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 8, lineHeight: 1.35 }}>
              Focus labeling on low-confidence jobs first to improve model performance faster.
            </div>
          </div>
        )}

        {!aiEnabled && (
          <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>
              Review mode is active. AI measurement and CV segmentation are disabled in this build.
            </div>
          </div>
        )}

        {/* Project files */}
        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Project Files</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            Status:{" "}
            <span
              style={{
                color: hasUnsavedChanges ? "#ffd39d" : "rgba(180,255,210,0.95)",
                fontWeight: 700,
              }}
            >
              {saveStatusLabel}
            </span>
          </div>

          <button
            onClick={() => setAppScreen(APP_SCREEN_HOME)}
            style={{
              width: "100%",
              padding: "9px 10px",
              borderRadius: 12,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Open Home Page
          </button>

          <button
            onClick={() => saveProject({ downloadFile: true })}
            disabled={saveInProgress}
            style={{
              width: "100%",
              padding: "9px 10px",
              borderRadius: 12,
              cursor: saveInProgress ? "not-allowed" : "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              opacity: saveInProgress ? 0.65 : 1,
            }}
          >
            {saveInProgress ? "Saving..." : "Save Project (JSON)"}
          </button>

          <button
            onClick={() => saveProject({ downloadFile: false })}
            disabled={saveInProgress}
            style={{
              width: "100%",
              marginTop: 8,
              padding: "9px 10px",
              borderRadius: 12,
              cursor: saveInProgress ? "not-allowed" : "pointer",
              border: "1px solid rgba(124,214,255,0.35)",
              background: "rgba(0,140,255,0.12)",
              color: "#fff",
              fontWeight: 700,
              opacity: saveInProgress ? 0.65 : 1,
            }}
          >
            Save Project (Shared Only)
          </button>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => setShowVersionHistory(true)}
              style={{
                padding: "8px 9px",
                borderRadius: 10,
                cursor: "pointer",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              Version History
            </button>
            <button
              type="button"
              onClick={() => {
                setShowShortcutHelp(false);
                setShowCommandPalette(true);
              }}
              style={{
                padding: "8px 9px",
                borderRadius: 10,
                cursor: "pointer",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              Command Palette
            </button>
          </div>

          <label
            style={{
              marginTop: 8,
              display: "block",
              textAlign: "center",
              padding: "9px 10px",
              borderRadius: 12,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
            }}
          >
            Load Project (JSON)
            <input
              type="file"
              accept=".json,application/json"
              onChange={loadProjectFile}
              style={{ display: "none" }}
            />
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              onClick={restoreAutosave}
              disabled={!autosaveDraftAvailable}
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: 10,
                cursor: autosaveDraftAvailable ? "pointer" : "not-allowed",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
                opacity: autosaveDraftAvailable ? 1 : 0.55,
              }}
            >
              Restore Autosave
            </button>
            <button
              onClick={clearAutosave}
              disabled={!autosaveDraftAvailable}
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: 10,
                cursor: autosaveDraftAvailable ? "pointer" : "not-allowed",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 700,
                opacity: autosaveDraftAvailable ? 1 : 0.55,
              }}
            >
              Clear Autosave
            </button>
          </div>

          <div style={{ fontSize: 12, opacity: 0.72, marginTop: 8, lineHeight: 1.35 }}>
            Autosave runs every 30 seconds and on tab close.
          </div>

          <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6, lineHeight: 1.35 }}>
            Shared sync queue: {sharedProjectQueue.length} pending change
            {sharedProjectQueue.length === 1 ? "" : "s"}.
            {!sharedAccessAuthenticated ? " Log in on Home to sync shared files." : ""}
          </div>
          <button
            onClick={() => syncSharedProjectQueue({ quiet: false })}
            disabled={
              sharedProjectQueueSyncing ||
              sharedProjectQueue.length === 0 ||
              !sharedAccessAuthenticated ||
              sharedAuthChecking
            }
            style={{
              width: "100%",
              marginTop: 8,
              padding: "8px 10px",
              borderRadius: 10,
              cursor:
                sharedProjectQueueSyncing ||
                sharedProjectQueue.length === 0 ||
                !sharedAccessAuthenticated ||
                sharedAuthChecking
                  ? "not-allowed"
                  : "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              opacity:
                sharedProjectQueueSyncing ||
                sharedProjectQueue.length === 0 ||
                !sharedAccessAuthenticated ||
                sharedAuthChecking
                  ? 0.6
                  : 1,
            }}
          >
            {sharedProjectQueueSyncing ? "Syncing Shared Queue..." : "Sync Shared Queue Now"}
          </button>
        </div>

        {/* Totals */}
        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Totals</div>
          {LAYER_KEYS.map((k) => (
            <div
              key={k}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                padding: "6px 0",
                borderBottom: "1px dashed rgba(255,255,255,0.10)",
              }}
            >
              <span style={{ fontSize: 13 }}>{LAYER_META[k].name}</span>
              <span style={{ fontSize: 13, opacity: 0.9 }}>
                {totals[k].sqft.toLocaleString()} sq ft ({totals[k].acres.toFixed(2)} ac)
              </span>
            </div>
          ))}
        </div>

        {/* QC Panel */}
        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            QC Panel
          </div>

          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
            Scanned polygons: {qcSummary.polygons.toLocaleString()}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              rowGap: 6,
              columnGap: 10,
              fontSize: 12,
            }}
          >
            <span style={{ opacity: 0.85 }}>Overlaps</span>
            <span style={{ color: qcSummary.overlaps > 0 ? "#ffb066" : "rgba(255,255,255,0.75)" }}>
              {qcSummary.overlaps.toLocaleString()} ({qcSummary.overlapSqft.toLocaleString()} sq ft)
            </span>
            <span style={{ opacity: 0.85 }}>Outside boundary</span>
            <span style={{ color: qcSummary.outside > 0 ? "#ffb066" : "rgba(255,255,255,0.75)" }}>
              {qcSummary.outside.toLocaleString()}
            </span>
            <span style={{ opacity: 0.85 }}>Tiny polygons (&lt; {TINY_POLYGON_SQFT} sq ft)</span>
            <span style={{ color: qcSummary.tiny > 0 ? "#ffb066" : "rgba(255,255,255,0.75)" }}>
              {qcSummary.tiny.toLocaleString()}
            </span>
            <span style={{ opacity: 0.85 }}>Invalid / zero area</span>
            <span style={{ color: qcSummary.invalidArea > 0 ? "#ff8a8a" : "rgba(255,255,255,0.75)" }}>
              {qcSummary.invalidArea.toLocaleString()}
            </span>
          </div>

          <button
            onClick={resolveOverlapsPlowablePriority}
            disabled={qcSummary.overlaps <= 0}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              cursor: qcSummary.overlaps > 0 ? "pointer" : "not-allowed",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              opacity: qcSummary.overlaps > 0 ? 1 : 0.55,
            }}
          >
            Fix Overlaps (Plowable Priority)
          </button>

          <button
            onClick={clipAllPolygonsToBoundary}
            disabled={!boundary || qcSummary.outside <= 0}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              cursor: boundary && qcSummary.outside > 0 ? "pointer" : "not-allowed",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontWeight: 700,
              opacity: boundary && qcSummary.outside > 0 ? 1 : 0.55,
            }}
          >
            Clip Outside Boundary
          </button>

          {!qcHasIssues && (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.76 }}>
              QC status: no overlaps/outside/tiny/invalid polygons detected.
            </div>
          )}
        </div>

        {/* Polygons list */}
        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            Polygons in {LAYER_META[activeLayer].name}
          </div>

          {(layerFeatures[activeLayer] || []).length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Draw polygons to see them listed here.
            </div>
          ) : (
            (layerFeatures[activeLayer] || []).map((f) => {
              const sqft = featureSqft(f);
              const outside = !!f.properties?.outside;

              return (
                <div
                  key={f.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "6px 0",
                    borderBottom: "1px dashed rgba(255,255,255,0.10)",
                  }}
                >
                  <input
                    value={f.properties?.name || ""}
                    onChange={(e) => renameFeature(f.id, e.target.value)}
                    placeholder="Name"
                    style={{
                      flex: 1,
                      padding: 7,
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.14)",
                      background: "#111",
                      color: "#fff",
                    }}
                    aria-label="Polygon name"
                  />

                  {outside ? (
                    <span
                      title="Outside boundary"
                      style={{
                        fontSize: 12,
                        color: "#ff7777",
                        fontWeight: 800,
                        marginRight: 2,
                      }}
                    >
                      !
                    </span>
                  ) : null}

                  <div style={{ width: 140, textAlign: "right", fontSize: 12, opacity: 0.9 }}>
                    {Math.round(sqft).toLocaleString()} sq ft
                  </div>

                  <button
                    onClick={() => zoomToFeature(f)}
                    style={{
                      width: 64,
                      padding: "7px 8px",
                      borderRadius: 10,
                      cursor: "pointer",
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(255,255,255,0.06)",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    Zoom
                  </button>

                  <button
                    onClick={() => deleteFeature(f.id)}
                    style={{
                      width: 72,
                      padding: "7px 8px",
                      borderRadius: 10,
                      cursor: "pointer",
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(255,255,255,0.06)",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    Delete
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Exports */}
        <div style={{ padding: 10, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Exports</div>

          <button
            onClick={exportTotalsCsvSafe}
            style={btnStyleFull()}
          >
            Export CSV (Totals)
          </button>

          <button
            onClick={exportPolygonsCsvSafe}
            style={{ ...btnStyleFull(), marginTop: 8 }}
          >
            Export Polygon List (CSV)
          </button>

          <button
            onClick={exportLayersKmlSafe}
            style={{ ...btnStyleFull(), marginTop: 8 }}
          >
            Export KML
          </button>

          <button
            onClick={exportPdfSafe}
            style={{ ...btnStyleFull(), marginTop: 8 }}
          >
            Export PDF
          </button>

          <button
            onClick={() => exportTrainingSample()}
            disabled={trainingExporting}
            style={{
              ...btnStyleFull(),
              marginTop: 8,
              cursor: trainingExporting ? "not-allowed" : "pointer",
              opacity: trainingExporting ? 0.6 : 1,
            }}
          >
            {trainingExporting ? "Exporting Training Sample..." : "One-Click Training Export"}
          </button>

          <div
            style={{
              marginTop: 12,
              paddingTop: 10,
              borderTop: "1px solid rgba(255,255,255,0.10)",
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.86, marginBottom: 8 }}>
              Estimate Templates (Snow + Landscaping)
            </div>
            <div style={{ fontSize: 11, opacity: 0.72, marginBottom: 8, lineHeight: 1.35 }}>
              Upload text templates (`.txt`, `.csv`, `.md`, `.json`, `.xml`, `.html`) or spreadsheet
              templates (`.numbers`, `.xlsx`, `.xls`, `.ods`). Spreadsheet exports preserve all
              sheets/pages and output a filled `.xlsx`.
            </div>

            <div style={{ marginBottom: 10, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Snow Template</div>
              <input
                type="file"
                accept=".txt,.csv,.md,.json,.xml,.html,.tsv,.numbers,.xlsx,.xlsm,.xlsb,.xls,.ods,.fods"
                onChange={(e) => uploadEstimateTemplate("snow", e)}
                style={{ width: "100%", fontSize: 12, marginBottom: 6 }}
              />
              <div style={{ fontSize: 11, opacity: 0.72, marginBottom: 6 }}>
                {estimateTemplates?.snow?.name
                  ? `Loaded: ${estimateTemplates.snow.name}`
                  : "No snow template uploaded yet."}
              </div>
              <button
                onClick={() => exportEstimateFromTemplate("snow")}
                disabled={!estimateTemplateHasData(estimateTemplates?.snow)}
                style={{
                  ...btnStyleFull(),
                  marginBottom: 6,
                  cursor: estimateTemplateHasData(estimateTemplates?.snow)
                    ? "pointer"
                    : "not-allowed",
                  opacity: estimateTemplateHasData(estimateTemplates?.snow) ? 1 : 0.6,
                }}
              >
                Export Filled Snow Estimate
              </button>
              <button
                onClick={() => clearEstimateTemplate("snow")}
                disabled={!estimateTemplateHasData(estimateTemplates?.snow)}
                style={{
                  ...btnStyleFull(),
                  cursor: estimateTemplateHasData(estimateTemplates?.snow)
                    ? "pointer"
                    : "not-allowed",
                  opacity: estimateTemplateHasData(estimateTemplates?.snow) ? 1 : 0.6,
                }}
              >
                Clear Snow Template
              </button>
            </div>

            <div style={{ marginBottom: 4, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Landscaping Template</div>
              <input
                type="file"
                accept=".txt,.csv,.md,.json,.xml,.html,.tsv,.numbers,.xlsx,.xlsm,.xlsb,.xls,.ods,.fods"
                onChange={(e) => uploadEstimateTemplate("landscaping", e)}
                style={{ width: "100%", fontSize: 12, marginBottom: 6 }}
              />
              <div style={{ fontSize: 11, opacity: 0.72, marginBottom: 6 }}>
                {estimateTemplates?.landscaping?.name
                  ? `Loaded: ${estimateTemplates.landscaping.name}`
                  : "No landscaping template uploaded yet."}
              </div>
              <button
                onClick={() => exportEstimateFromTemplate("landscaping")}
                disabled={!estimateTemplateHasData(estimateTemplates?.landscaping)}
                style={{
                  ...btnStyleFull(),
                  marginBottom: 6,
                  cursor: estimateTemplateHasData(estimateTemplates?.landscaping)
                    ? "pointer"
                    : "not-allowed",
                  opacity: estimateTemplateHasData(estimateTemplates?.landscaping) ? 1 : 0.6,
                }}
              >
                Export Filled Landscaping Estimate
              </button>
              <button
                onClick={() => clearEstimateTemplate("landscaping")}
                disabled={!estimateTemplateHasData(estimateTemplates?.landscaping)}
                style={{
                  ...btnStyleFull(),
                  cursor: estimateTemplateHasData(estimateTemplates?.landscaping)
                    ? "pointer"
                    : "not-allowed",
                  opacity: estimateTemplateHasData(estimateTemplates?.landscaping) ? 1 : 0.6,
                }}
              >
                Clear Landscaping Template
              </button>
            </div>
          </div>

          <button
            onClick={clearActiveLayer}
            style={{ ...btnStyleFull(), marginTop: 8 }}
          >
            Clear Active Layer
          </button>

          <button
            onClick={resolveOverlapsPlowablePriority}
            style={{ ...btnStyleFull(), marginTop: 8 }}
          >
            Fix Overlaps (Plowable Priority)
          </button>

          <button
            onClick={clearAllLayers}
            style={{ ...btnStyleFull(), marginTop: 8 }}
          >
            Clear All
          </button>
        </div>
      </div>

      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <div
          className="map"
          ref={mapDivRef}
          style={{
            position: "absolute",
            inset: 0,
            touchAction:
              isCompactTouchUi && drawMode === "simple_select"
                ? "pan-x pan-y pinch-zoom"
                : "none",
          }}
        />

        {activeOperations.length > 0 && !showTrue3DViewer && (
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              zIndex: 9,
              width: "min(340px, calc(100% - 20px))",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(10,12,18,0.88)",
              color: "#fff",
              backdropFilter: "blur(2px)",
              padding: "8px 10px",
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
              Working ({activeOperations.length})
            </div>
            {activeOperations.slice(0, 3).map((operation) => (
              <div
                key={`map-op-${operation.id}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  padding: "4px 0",
                  borderBottom: "1px dashed rgba(255,255,255,0.08)",
                }}
              >
                <span style={{ opacity: 0.9 }}>{operation.label}</span>
                {operation.canCancel ? (
                  <button
                    type="button"
                    onClick={() => cancelOperationById(operation.id)}
                    style={{
                      padding: "2px 6px",
                      borderRadius: 999,
                      border: "1px solid rgba(255,170,96,0.55)",
                      background: "rgba(170,90,30,0.24)",
                      color: "#fff",
                      cursor: "pointer",
                      fontWeight: 700,
                      fontSize: 10,
                    }}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {workflowMode === WORKFLOW_MODE_PDF &&
          (!measurementImageFile || !planOverlay?.url) && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 18,
                background:
                  "linear-gradient(180deg, rgba(6,8,14,0.92) 0%, rgba(8,10,15,0.94) 100%)",
                display: "grid",
                placeItems: "center",
                padding: 20,
              }}
            >
              <div
                style={{
                  width: "min(560px, 100%)",
                  borderRadius: 16,
                  border: "1px solid rgba(255,255,255,0.16)",
                  background: "rgba(255,255,255,0.04)",
                  boxShadow: "0 24px 70px rgba(0,0,0,0.45)",
                  padding: "18px 16px",
                  color: "#fff",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 6 }}>
                  Upload PDF/Image to Start Measuring
                </div>
                <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 12, lineHeight: 1.4 }}>
                  This page is file-only. No basemap is shown in PDF mode.
                </div>
                <label
                  style={{
                    display: "inline-block",
                    padding: "10px 14px",
                    borderRadius: 12,
                    border: "1px solid rgba(130,220,255,0.8)",
                    background: "rgba(0,140,255,0.20)",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 800,
                  }}
                >
                  Choose PDF or Image
                  <input
                    ref={pdfUploadPromptInputRef}
                    type="file"
                    accept="image/*,.pdf,application/pdf"
                    onChange={handleMeasurementMediaUpload}
                    style={{ display: "none" }}
                    aria-label="Upload PDF or image to begin measuring"
                  />
                </label>
              </div>
            </div>
          )}

        {showTrue3DViewer && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 30,
              background: "rgba(0,0,0,0.92)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 12px",
                borderBottom: "1px solid rgba(255,255,255,0.16)",
                color: "#fff",
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 14 }}>
                True 3D Viewer (Beta)
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() =>
                    setTrue3DEditMode((prev) => {
                      const next = !prev;
                      setTrue3DToolMode(next ? "edit" : "pan");
                      return next;
                    })
                  }
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    border: true3DEditMode
                      ? "1px solid rgba(130,220,255,0.8)"
                      : "1px solid rgba(255,255,255,0.2)",
                    background: true3DEditMode
                      ? "rgba(0,140,255,0.2)"
                      : "rgba(255,255,255,0.08)",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                  title="Edit active layer vertices in 3D"
                >
                  {true3DEditMode ? "Edit Handles: ON" : "Edit Handles: OFF"}
                </button>
                <button
                  type="button"
                  onClick={() => setTrue3DToolMode("pan")}
                  disabled={!true3DEditMode}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    border:
                      true3DToolMode === "pan"
                        ? "1px solid rgba(130,220,255,0.8)"
                        : "1px solid rgba(255,255,255,0.2)",
                    background:
                      true3DToolMode === "pan"
                        ? "rgba(0,140,255,0.2)"
                        : "rgba(255,255,255,0.08)",
                    color: true3DEditMode ? "#fff" : "rgba(255,255,255,0.45)",
                    cursor: true3DEditMode ? "pointer" : "not-allowed",
                    fontWeight: 700,
                  }}
                  title="Pan, orbit, and zoom camera"
                >
                  Pan
                </button>
                <button
                  type="button"
                  onClick={() => setTrue3DToolMode("edit")}
                  disabled={!true3DEditMode}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    border:
                      true3DToolMode === "edit"
                        ? "1px solid rgba(130,220,255,0.8)"
                        : "1px solid rgba(255,255,255,0.2)",
                    background:
                      true3DToolMode === "edit"
                        ? "rgba(0,140,255,0.2)"
                        : "rgba(255,255,255,0.08)",
                    color: true3DEditMode ? "#fff" : "rgba(255,255,255,0.45)",
                    cursor: true3DEditMode ? "pointer" : "not-allowed",
                    fontWeight: 700,
                  }}
                  title="Drag vertices for active layer"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setTrue3DSelectedFeatureId("")}
                  disabled={!true3DSelectedFeatureId}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: true3DSelectedFeatureId ? "#fff" : "rgba(255,255,255,0.45)",
                    cursor: true3DSelectedFeatureId ? "pointer" : "not-allowed",
                    fontWeight: 700,
                  }}
                  title="Clear selected 3D polygon"
                >
                  Clear Selected
                </button>
                <button
                  type="button"
                  onClick={undoLayerEdit}
                  disabled={!canUndo}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: canUndo ? "#fff" : "rgba(255,255,255,0.45)",
                    cursor: canUndo ? "pointer" : "not-allowed",
                    fontWeight: 700,
                  }}
                  title="Undo last edit"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={redoLayerEdit}
                  disabled={!canRedo}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: canRedo ? "#fff" : "rgba(255,255,255,0.45)",
                    cursor: canRedo ? "pointer" : "not-allowed",
                    fontWeight: 700,
                  }}
                  title="Redo last undone edit"
                >
                  Redo
                </button>
                <button
                  type="button"
                  onClick={() => zoomTrue3D(0.7)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: 18,
                    fontWeight: 800,
                  }}
                  aria-label="Zoom in 3D"
                  title="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => zoomTrue3D(1.35)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: 18,
                    fontWeight: 800,
                  }}
                  aria-label="Zoom out 3D"
                  title="Zoom out"
                >
                  -
                </button>
                <button
                  type="button"
                  onClick={closeTrue3DViewer}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  Close 3D
                </button>
              </div>
            </div>
            <div style={{ padding: "6px 12px", color: "rgba(255,255,255,0.84)", fontSize: 12 }}>
              {true3DLoading ? "Initializing 3D scene..." : true3DStatus || "3D ready."}
            </div>
            <div
              style={{
                padding: "0 12px 8px",
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.92)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 999,
                  padding: "4px 9px",
                  background: "rgba(255,255,255,0.08)",
                }}
              >
                Layer: {LAYER_META[activeLayer]?.name || activeLayer}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.92)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 999,
                  padding: "4px 9px",
                  background: "rgba(255,255,255,0.08)",
                }}
              >
                Vertices: {true3DActiveVertexCount}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.92)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 999,
                  padding: "4px 9px",
                  background: "rgba(255,255,255,0.08)",
                }}
              >
                Selected: {true3DSelectedFeatureId ? `#${true3DSelectedFeatureId}` : "none"}
              </span>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.74)" }}>
                {!true3DEditMode
                  ? "Enable Edit Handles, then click a polygon to edit."
                  : !true3DSelectedFeatureId
                  ? "Click a polygon in 3D to select it; handles appear for selected shape only."
                  : true3DToolMode === "edit"
                  ? "Edit mode: drag handles to move vertices."
                  : "Pan mode: orbit/zoom camera without moving handles."}
              </span>
            </div>
            <div
              ref={true3DContainerRef}
              style={{
                flex: 1,
                minHeight: 0,
                touchAction: "none",
                overscrollBehavior: "contain",
                WebkitUserSelect: "none",
                userSelect: "none",
              }}
            />
          </div>
        )}

        {isCompactTouchUi && (
          <div
            style={{
              position: "absolute",
              left: 10,
              right: 10,
              bottom: 12,
              zIndex: 5,
              display: "grid",
              gap: 8,
              pointerEvents: "none",
              paddingBottom: "max(env(safe-area-inset-bottom, 0px), 6px)",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: 6,
                background: "rgba(12,12,12,0.92)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 12,
                padding: 6,
                pointerEvents: "auto",
              }}
            >
              <button
                onClick={switchToDrawMode}
                style={{
                  padding: "10px 6px",
                  borderRadius: 10,
                  border:
                    drawMode === "draw_polygon"
                      ? "1px solid rgba(130, 220, 255, 0.8)"
                      : "1px solid rgba(255,255,255,0.14)",
                  background:
                    drawMode === "draw_polygon"
                      ? "rgba(0, 140, 255, 0.22)"
                      : "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                Draw
              </button>
              <button
                onClick={switchToPanMode}
                style={{
                  padding: "10px 6px",
                  borderRadius: 10,
                  border:
                    drawMode === "simple_select"
                      ? "1px solid rgba(130, 220, 255, 0.8)"
                      : "1px solid rgba(255,255,255,0.14)",
                  background:
                    drawMode === "simple_select"
                      ? "rgba(0, 140, 255, 0.22)"
                      : "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                Pan
              </button>
              <button
                onClick={undoLayerEdit}
                disabled={!canUndo}
                style={{
                  padding: "10px 6px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 12,
                  opacity: canUndo ? 1 : 0.55,
                }}
              >
                Undo
              </button>
              <button
                onClick={redoLayerEdit}
                disabled={!canRedo}
                style={{
                  padding: "10px 6px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 12,
                  opacity: canRedo ? 1 : 0.55,
                }}
              >
                Redo
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: 6,
                background: "rgba(12,12,12,0.92)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 12,
                padding: 6,
                pointerEvents: "auto",
              }}
            >
              {LAYER_KEYS.map((k) => {
                const active = activeLayer === k;
                return (
                  <button
                    key={`compact-layer-${k}`}
                    onClick={() => switchActiveLayer(k)}
                    style={{
                      padding: "9px 4px",
                      borderRadius: 10,
                      border: active
                        ? "1px solid rgba(255,255,255,0.35)"
                        : "1px solid rgba(255,255,255,0.14)",
                      background: active ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  >
                    {LAYER_META[k].name}
                  </button>
                );
              })}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: 6,
                background: "rgba(12,12,12,0.92)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 12,
                padding: 6,
                pointerEvents: "auto",
              }}
            >
              <button
                type="button"
                onClick={() => saveProject({ downloadFile: false })}
                disabled={saveInProgress}
                style={{
                  padding: "10px 4px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(0,140,255,0.18)",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 11,
                  opacity: saveInProgress ? 0.6 : 1,
                }}
              >
                {saveInProgress ? "Saving" : "Save"}
              </button>
              <button
                type="button"
                onClick={deleteSelectedFeatures}
                style={{
                  padding: "10px 4px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 11,
                }}
              >
                Delete
              </button>
              <button
                type="button"
                onClick={cycleActiveLayer}
                style={{
                  padding: "10px 4px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 11,
                }}
              >
                Next Layer
              </button>
              <button
                type="button"
                onClick={() => setAppScreen(APP_SCREEN_HOME)}
                style={{
                  padding: "10px 4px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 11,
                }}
              >
                Home
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// helper for buttons
function btnStyleFull() {
  return {
    width: "100%",
    padding: "9px 10px",
    borderRadius: 12,
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontWeight: 700,
  };
}
