import { useEffect, useEffectEvent, useRef, useState } from "react";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import * as turf from "@turf/turf";
import * as maplibregl from "maplibre-gl";

const DEFAULT_CENTER = [-75.5244, 39.1582];
const SQ_METERS_TO_SQ_FEET = 10.76391041671;
const SQ_FEET_PER_ACRE = 43_560;

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
      if (key.endsWith("dasharray") && Array.isArray(value) && value.every(Number.isFinite)) {
        paint[key] = ["literal", value];
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
  const [mapStatus, setMapStatus] = useState("Draw the outer property boundary to estimate its area.");
  const [locating, setLocating] = useState(false);
  const [boundarySquareFeet, setBoundarySquareFeet] = useState(0);

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
      setBoundarySquareFeet(squareFeet);
      onChangeRef.current?.(feature);
      onSquareFeetChangeRef.current?.(squareFeet);
      setMapStatus(
        feature
          ? `${formatArea(squareFeet)} inside the drawn boundary. Drag any point to refine it.`
          : "Boundary cleared. Draw the outer property boundary to estimate its area."
      );
    };

    map.on("load", () => {
      loadedRef.current = true;
      const initialValue = initialValueRef.current;
      if (initialValue?.geometry?.type === "Polygon" || initialValue?.type === "Polygon") {
        draw.add(initialValue);
        syncBoundary();
      }
    });
    map.on("draw.create", syncBoundary);
    map.on("draw.update", syncBoundary);
    map.on("draw.delete", syncBoundary);

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      loadedRef.current = false;
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
    if (!draw) return;
    draw.deleteAll();
    setBoundarySquareFeet(0);
    onChangeRef.current?.(null);
    onSquareFeetChangeRef.current?.(0);
    draw.changeMode("draw_polygon");
    setMapStatus("Tap or click around the property. Select the first point again to finish.");
  };

  const clearBoundary = () => {
    drawRef.current?.deleteAll();
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
          <button type="button" onClick={clearBoundary} disabled={!value}>Clear</button>
        </div>
      </div>
      <div className="takeoff-boundary-map-shell">
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
