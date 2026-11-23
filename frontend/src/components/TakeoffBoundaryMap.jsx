import { useEffect, useEffectEvent, useRef, useState } from "react";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import * as turf from "@turf/turf";
import * as maplibregl from "maplibre-gl";

const DEFAULT_CENTER = [-75.5244, 39.1582];
const SQ_METERS_TO_SQ_FEET = 10.76391041671;
const SQ_FEET_PER_ACRE = 43_560;
const DRAFT_SOURCE_ID = "takeoff-boundary-draft";
const DRAFT_LINE_LAYER_ID = "takeoff-boundary-draft-line";
const DRAFT_POINT_LAYER_ID = "takeoff-boundary-draft-points";
const COMPLETED_SOURCE_ID = "takeoff-boundary-completed";
const COMPLETED_FILL_LAYER_ID = "takeoff-boundary-completed-fill";
const COMPLETED_HALO_LAYER_ID = "takeoff-boundary-completed-halo";
const COMPLETED_LINE_LAYER_ID = "takeoff-boundary-completed-line";

// Mapbox Draw still ships Mapbox GL class names; align them with MapLibre's DOM.
if (MapboxDraw.constants?.classes) {
  MapboxDraw.constants.classes.CANVAS = "maplibregl-canvas";
  MapboxDraw.constants.classes.CONTROL_BASE = "maplibregl-ctrl";
  MapboxDraw.constants.classes.CONTROL_PREFIX = "maplibregl-ctrl-";
  MapboxDraw.constants.classes.CONTROL_GROUP = "maplibregl-ctrl-group";
  MapboxDraw.constants.classes.ATTRIBUTION = "maplibregl-ctrl-attrib";
}

function formatArea(squareFeet) {
  if (!Number.isFinite(squareFeet) || squareFeet <= 0) return "Boundary not drawn";
  return `${squareFeet.toLocaleString()} sq ft · ${(squareFeet / SQ_FEET_PER_ACRE).toFixed(2)} ac`;
}

function drawStyles() {
  const baseStyles = Array.isArray(MapboxDraw.styles)
    ? MapboxDraw.styles
    : Array.isArray(MapboxDraw.lib?.theme)
    ? MapboxDraw.lib.theme
    : [];
  return baseStyles.map((style) => {
    const paint = { ...(style.paint || {}) };
    for (const [key, value] of Object.entries(paint)) {
      if (key.endsWith("dasharray") && Array.isArray(value)) {
        const normalizeDashArrays = (candidate) => {
          if (!Array.isArray(candidate)) return candidate;
          if (candidate.length && candidate.every(Number.isFinite)) {
            return ["literal", candidate];
          }
          return candidate.map(normalizeDashArrays);
        };
        paint[key] = normalizeDashArrays(value);
      }
    }
    if (String(style.id || "").startsWith("gl-draw-polygon-fill")) {
      paint["fill-color"] = "#66b84d";
      paint["fill-opacity"] = 0.2;
    }
    if (String(style.id || "").startsWith("gl-draw-lines")) {
      paint["line-color"] = "#f8fff5";
      paint["line-width"] = 3;
    }
    if (String(style.id || "").startsWith("gl-draw-point")) {
      paint["circle-color"] = "#66b84d";
      paint["circle-stroke-color"] = "#ffffff";
      paint["circle-radius"] = 6;
    }
    return { ...style, paint };
  });
}

function TakeoffBoundaryMap({
  address,
  mapboxToken,
  value,
  onChange,
  onSquareFeetChange,
  addressSearchNonce = 0,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const loadedRef = useRef(false);
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSquareFeetChangeRef = useRef(onSquareFeetChange);
  const draftingRef = useRef(false);
  const draftCoordinatesRef = useRef([]);
  const updateDraftRef = useRef(() => {});
  const updateCompletedRef = useRef(() => {});
  const completeDraftRef = useRef(() => false);
  const [mapStatus, setMapStatus] = useState("Draw the outer property boundary to estimate its area.");
  const [locating, setLocating] = useState(false);
  const [boundarySquareFeet, setBoundarySquareFeet] = useState(0);
  const [isDrafting, setIsDrafting] = useState(false);
  const [draftPointCount, setDraftPointCount] = useState(0);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSquareFeetChangeRef.current = onSquareFeetChange;
  }, [onChange, onSquareFeetChange]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;

    window.mapboxgl = maplibregl;
    const satelliteTiles = mapboxToken
      ? [`https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${mapboxToken}`]
      : ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"];
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: DEFAULT_CENTER,
      zoom: 12,
      maxZoom: 22,
      cooperativeGestures: false,
      style: {
        version: 8,
        sources: {
          takeoffImagery: {
            type: "raster",
            tiles: satelliteTiles,
            tileSize: 256,
            maxzoom: mapboxToken ? 22 : 19,
            attribution: mapboxToken ? "© Mapbox © OpenStreetMap" : "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "takeoff-imagery", type: "raster", source: "takeoffImagery" }],
      },
    });
    const draw = new MapboxDraw({
      displayControlsDefault: false,
      userProperties: true,
      styles: drawStyles(),
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(draw, "top-right");
    mapRef.current = map;
    drawRef.current = draw;

    const updateCompletedBoundary = (feature) => {
      const source = map.getSource(COMPLETED_SOURCE_ID);
      if (!source) return;
      source.setData({
        type: "FeatureCollection",
        features: feature ? [feature] : [],
      });
    };

    const syncBoundary = (event) => {
      if (event?.type === "draw.create") {
        const newestId = event.features?.[0]?.id;
        for (const feature of draw.getAll().features) {
          if (feature.id !== newestId) draw.delete(feature.id);
        }
      }
      const feature = draw.getAll().features.find(
        (candidate) => candidate?.geometry?.type === "Polygon"
      ) || null;
      const squareFeet = feature
        ? Math.max(0, Math.round(turf.area(feature) * SQ_METERS_TO_SQ_FEET))
        : 0;
      updateCompletedBoundary(feature);
      setBoundarySquareFeet(squareFeet);
      onChangeRef.current?.(feature);
      onSquareFeetChangeRef.current?.(squareFeet);
      setMapStatus(
        feature
          ? `${formatArea(squareFeet)} inside the drawn boundary. Drag any point to refine it.`
          : "Boundary cleared. Draw the outer property boundary to estimate its area."
      );
    };

    const updateDraft = (coordinates) => {
      const source = map.getSource(DRAFT_SOURCE_ID);
      if (!source) return;
      const points = Array.isArray(coordinates) ? coordinates : [];
      const features = points.map((coordinate, index) => ({
        type: "Feature",
        properties: { index },
        geometry: { type: "Point", coordinates: coordinate },
      }));
      if (points.length >= 2) {
        features.unshift({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: points },
        });
      }
      source.setData({ type: "FeatureCollection", features });
    };

    const stopDrafting = () => {
      draftingRef.current = false;
      setIsDrafting(false);
      draftCoordinatesRef.current = [];
      setDraftPointCount(0);
      updateDraft([]);
      map.getCanvas().style.cursor = "";
    };

    const completeDraft = (coordinates = draftCoordinatesRef.current) => {
      const points = Array.isArray(coordinates) ? coordinates : [];
      if (points.length < 3) {
        setMapStatus("Place at least three boundary points before finishing.");
        return false;
      }
      const polygon = turf.polygon([[...points, points[0]]]);
      draw.deleteAll();
      const [featureId] = draw.add(polygon);
      stopDrafting();
      syncBoundary({ type: "draw.create", features: [{ ...polygon, id: featureId }] });
      try {
        draw.changeMode("direct_select", { featureId });
      } catch {
        draw.changeMode("simple_select");
      }
      return true;
    };

    updateDraftRef.current = updateDraft;
    updateCompletedRef.current = updateCompletedBoundary;
    completeDraftRef.current = completeDraft;

    const addDraftCoordinate = (coordinate) => {
      if (!draftingRef.current) return;
      const current = draftCoordinatesRef.current;
      if (current.length >= 3) {
        const firstPoint = map.project(current[0]);
        const clickedPoint = map.project(coordinate);
        const distance = Math.hypot(
          firstPoint.x - clickedPoint.x,
          firstPoint.y - clickedPoint.y
        );
        if (distance <= 22) {
          completeDraft(current);
          return;
        }
      }
      const next = [...current, coordinate];
      draftCoordinatesRef.current = next;
      setDraftPointCount(next.length);
      updateDraft(next);
      setMapStatus(
        next.length < 3
          ? `${next.length} point${next.length === 1 ? "" : "s"} placed. Add at least ${3 - next.length} more.`
          : `${next.length} points placed. Continue tracing or select Finish boundary.`
      );
    };

    let lastNativeTouchAt = 0;
    const handleMapClick = (event) => {
      if (performance.now() - lastNativeTouchAt < 700) return;
      addDraftCoordinate([Number(event.lngLat.lng), Number(event.lngLat.lat)]);
    };

    let touchPointerStart = null;
    const activeTouchPointers = new Set();
    const handlePointerDown = (event) => {
      if (!draftingRef.current || !["touch", "pen"].includes(event.pointerType)) return;
      activeTouchPointers.add(event.pointerId);
      if (activeTouchPointers.size > 1) {
        touchPointerStart = null;
        return;
      }
      touchPointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: performance.now(),
      };
    };
    const handlePointerUp = (event) => {
      const start = touchPointerStart;
      touchPointerStart = null;
      activeTouchPointers.delete(event.pointerId);
      if (
        !draftingRef.current ||
        !start ||
        start.id !== event.pointerId ||
        !["touch", "pen"].includes(event.pointerType)
      ) return;
      const movement = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (movement > 12 || performance.now() - start.time > 900) return;
      const bounds = map.getCanvas().getBoundingClientRect();
      const lngLat = map.unproject([
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      ]);
      lastNativeTouchAt = performance.now();
      addDraftCoordinate([Number(lngLat.lng), Number(lngLat.lat)]);
    };
    const handlePointerCancel = (event) => {
      activeTouchPointers.delete(event.pointerId);
      touchPointerStart = null;
    };

    map.on("load", () => {
      loadedRef.current = true;
      const firstDrawLayerId = drawStyles()
        .map((style) => style.id)
        .find((layerId) => map.getLayer(layerId));
      map.addSource(COMPLETED_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: COMPLETED_FILL_LAYER_ID,
        type: "fill",
        source: COMPLETED_SOURCE_ID,
        paint: {
          "fill-color": "#66b84d",
          "fill-opacity": 0.16,
        },
      }, firstDrawLayerId);
      map.addLayer({
        id: COMPLETED_HALO_LAYER_ID,
        type: "line",
        source: COMPLETED_SOURCE_ID,
        paint: {
          "line-color": "#071208",
          "line-opacity": 0.82,
          "line-width": 9,
        },
      }, firstDrawLayerId);
      map.addLayer({
        id: COMPLETED_LINE_LAYER_ID,
        type: "line",
        source: COMPLETED_SOURCE_ID,
        paint: {
          "line-color": "#b8ff78",
          "line-width": 5,
        },
      }, firstDrawLayerId);
      map.addSource(DRAFT_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: DRAFT_LINE_LAYER_ID,
        type: "line",
        source: DRAFT_SOURCE_ID,
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "#f8fff5",
          "line-width": 4,
          "line-dasharray": [2, 1.5],
        },
      });
      map.addLayer({
        id: DRAFT_POINT_LAYER_ID,
        type: "circle",
        source: DRAFT_SOURCE_ID,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": "#66b84d",
          "circle-radius": 7,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      const initialValue = initialValueRef.current;
      if (initialValue?.geometry?.type === "Polygon" || initialValue?.type === "Polygon") {
        draw.add(initialValue);
        syncBoundary();
      }
    });
    map.on("draw.create", syncBoundary);
    map.on("draw.update", syncBoundary);
    map.on("draw.delete", syncBoundary);
    map.on("click", handleMapClick);
    const canvas = map.getCanvas();
    canvas.addEventListener("pointerdown", handlePointerDown, true);
    canvas.addEventListener("pointerup", handlePointerUp, true);
    canvas.addEventListener("pointercancel", handlePointerCancel, true);

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      loadedRef.current = false;
      draftingRef.current = false;
      draftCoordinatesRef.current = [];
      updateDraftRef.current = () => {};
      updateCompletedRef.current = () => {};
      completeDraftRef.current = () => false;
      canvas.removeEventListener("pointerdown", handlePointerDown, true);
      canvas.removeEventListener("pointerup", handlePointerUp, true);
      canvas.removeEventListener("pointercancel", handlePointerCancel, true);
      drawRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [mapboxToken]);

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || !loadedRef.current) return;
    const existing = draw.getAll().features;
    if (!value && existing.length) {
      draw.deleteAll();
      updateCompletedRef.current(null);
      setBoundarySquareFeet(0);
      setMapStatus("Boundary cleared. Draw the outer property boundary to estimate its area.");
    }
  }, [value]);

  const findAddress = async () => {
    const query = String(address || "").trim();
    if (!query) {
      setMapStatus("Enter the property address first.");
      return;
    }
    if (!mapboxToken) {
      setMapStatus("Address lookup is unavailable until the Mapbox token is configured.");
      return;
    }
    setLocating(true);
    setMapStatus("Finding the property...");
    try {
      const params = new URLSearchParams({
        q: query,
        country: "us",
        limit: "1",
        autocomplete: "false",
        access_token: mapboxToken,
      });
      const response = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params}`);
      if (!response.ok) throw new Error("Address lookup failed");
      const payload = await response.json();
      const coordinates = payload?.features?.[0]?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new Error("Address not found");
      }
      mapRef.current?.flyTo({ center: coordinates, zoom: 18, duration: 900 });
      setMapStatus("Property found. Select Draw boundary, then trace the full area to measure.");
    } catch (error) {
      setMapStatus(error?.message === "Address not found"
        ? "We could not find that address. Add the city and state, then try again."
        : "Address lookup failed. You can still pan and zoom to the property manually.");
    } finally {
      setLocating(false);
    }
  };

  const findAddressForEffect = useEffectEvent(() => {
    void findAddress();
  });

  useEffect(() => {
    if (addressSearchNonce > 0) findAddressForEffect();
  }, [addressSearchNonce]);

  const startDrawing = () => {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (!draw || !map || !loadedRef.current) {
      setMapStatus("The map is still loading. Try Draw boundary again in a moment.");
      return;
    }
    draw.deleteAll();
    updateCompletedRef.current(null);
    draw.changeMode("simple_select");
    setBoundarySquareFeet(0);
    onChangeRef.current?.(null);
    onSquareFeetChangeRef.current?.(0);
    draftingRef.current = true;
    setIsDrafting(true);
    draftCoordinatesRef.current = [];
    setDraftPointCount(0);
    updateDraftRef.current([]);
    map.getCanvas().style.cursor = "crosshair";
    setMapStatus("Tap or click around the property. Use Finish boundary after placing at least three points.");
  };

  const undoDraftPoint = () => {
    if (!draftingRef.current || !draftCoordinatesRef.current.length) return;
    const next = draftCoordinatesRef.current.slice(0, -1);
    draftCoordinatesRef.current = next;
    setDraftPointCount(next.length);
    updateDraftRef.current(next);
    setMapStatus(
      next.length
        ? `${next.length} point${next.length === 1 ? "" : "s"} placed.`
        : "No points placed yet. Tap or click the first boundary corner."
    );
  };

  const finishBoundary = () => {
    completeDraftRef.current(draftCoordinatesRef.current);
  };

  const clearBoundary = () => {
    drawRef.current?.deleteAll();
    updateCompletedRef.current(null);
    draftingRef.current = false;
    setIsDrafting(false);
    draftCoordinatesRef.current = [];
    setDraftPointCount(0);
    updateDraftRef.current([]);
    if (mapRef.current) mapRef.current.getCanvas().style.cursor = "";
    setBoundarySquareFeet(0);
    onChangeRef.current?.(null);
    onSquareFeetChangeRef.current?.(0);
    setMapStatus("Boundary cleared. Draw the outer property boundary to estimate its area.");
  };

  return (
    <section className="takeoff-boundary-editor" aria-label="Property boundary map">
      <div className="takeoff-boundary-toolbar">
        <div>
          <strong>Property boundary</strong>
          <span>{mapboxToken ? "Satellite map" : "Street map fallback"}</span>
        </div>
        <div className="takeoff-boundary-actions">
          <button type="button" onClick={() => void findAddress()} disabled={locating}>
            {locating ? "Finding..." : "Find address"}
          </button>
          <button type="button" className="primary" onClick={startDrawing} disabled={locating}>Draw boundary</button>
          {isDrafting ? (
            <>
              <button type="button" onClick={undoDraftPoint} disabled={!draftPointCount}>Undo point</button>
              <button type="button" className="primary" onClick={finishBoundary} disabled={draftPointCount < 3}>Finish boundary</button>
            </>
          ) : null}
          <button type="button" onClick={clearBoundary} disabled={!value}>Clear</button>
        </div>
      </div>
      <div className="takeoff-boundary-map-shell" data-boundary-visible={boundarySquareFeet > 0 ? "true" : "false"}>
        <div ref={containerRef} className="takeoff-boundary-map" />
        <output className={`takeoff-boundary-area${boundarySquareFeet ? " ready" : ""}`}>
          <small>Quote boundary</small>
          <strong>{formatArea(boundarySquareFeet)}</strong>
        </output>
      </div>
      <p className="takeoff-boundary-status" role="status">{mapStatus}</p>
    </section>
  );
}

export default TakeoffBoundaryMap;
