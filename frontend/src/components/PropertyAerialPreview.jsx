import { useEffect, useMemo, useState } from "react";
import { LAYER_COLORS, PREVIEW_HEIGHT, PREVIEW_WIDTH, tilesForFrame } from "../projects/propertyPreview";

async function json(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Satellite imagery unavailable");
  return response.json();
}

async function getSource(provider, frame, ensureGoogleSession, signal) {
  const keys = {
    maptiler: import.meta.env.VITE_MAPTILER_KEY, mapbox: import.meta.env.VITE_MAPBOX_TOKEN,
    azure: import.meta.env.VITE_AZURE_MAPS_KEY, google: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
  };
  const selected = provider === "mapbox3d" ? "mapbox" : provider;
  const name = Object.hasOwn(keys, selected) && keys[selected] ? selected : Object.keys(keys).find(k => keys[k]);
  if (!name) throw new Error("No imagery configured");
  const key = encodeURIComponent(keys[name]);
  if (name === "google") {
    const session = await ensureGoogleSession();
    const params = new URLSearchParams({ ...frame.bounds, zoom: Math.min(frame.zoom, 22), key: keys.google, session });
    const viewport = await json("https://tile.googleapis.com/tile/v1/viewport?" + params, signal);
    const levels = (viewport.maxZoomRects || []).map(rect => rect.maxZoom).filter(Number.isFinite);
    return { template: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session)}&key=${key}`,
      maxzoom: levels.length ? Math.min(22, Math.max(...levels)) : 22, label: "Google Maps", credit: viewport.copyright || "", link: "https://maps.google.com/" };
  }
  if (name === "azure") return { template: `https://atlas.microsoft.com/map/tile?api-version=2024-04-01&tilesetId=microsoft.imagery&zoom={z}&x={x}&y={y}&tileSize=256&subscription-key=${key}`,
    maxzoom: 19, label: "Microsoft Azure Maps", link: "https://azure.microsoft.com/products/azure-maps" };
  if (name === "mapbox") return { template: `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${key}`,
    maxzoom: 22, label: "Mapbox", credit: "© Mapbox © OpenStreetMap • Improve this map", link: "https://www.mapbox.com/map-feedback/" };
  const meta = await json(`https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${key}`, signal);
  if (!meta.tiles?.[0]) throw new Error("No satellite tiles available");
  const credit = new DOMParser().parseFromString(meta.attribution || "", "text/html").body.textContent;
  return { template: meta.tiles[0], maxzoom: Number.isInteger(meta.maxzoom) ? meta.maxzoom : 20,
    tms: meta.scheme === "tms", label: "MapTiler", credit, link: "https://www.maptiler.com/copyright/" };
}

function AerialFrame({ frame, provider, ensureGoogleSession }) {
  const [source, setSource] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getSource(provider, frame, ensureGoogleSession, controller.signal).then(result => {
      if (!controller.signal.aborted) setSource(result);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [frame, provider, ensureGoogleSession]);
  const tiles = useMemo(() => source ? tilesForFrame(frame, source) : [], [frame, source]);
  const ready = !failed && tiles.length > 0 && loaded >= tiles.length;
  return <>
    <svg className="desk-aerial-svg" viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`} role="img"
      aria-label={ready ? "Property satellite image with measured polygon outlines" : "Measured project outline"}>
      {!failed && <g opacity={ready ? 1 : 0}>{tiles.map(tile => <image key={tile.left + ":" + tile.top}
        href={tile.url} x={tile.left} y={tile.top} width={tile.size} height={tile.size} preserveAspectRatio="none"
        onLoad={() => setLoaded(n => n + 1)} onError={() => setFailed(true)} />)}</g>}
      {frame.paths.map(({ layer, d }, i) => <path key={i} d={d} fillRule="evenodd" strokeLinejoin="round"
        fill={LAYER_COLORS[layer]?.fill || "none"} fillOpacity=".16" stroke={LAYER_COLORS[layer]?.line || "#00ffea"}
        strokeWidth={layer === "boundary" ? 1.6 : 2} vectorEffect="non-scaling-stroke" />)}
    </svg>
    <figcaption className="desk-aerial-caption">
      <span>{ready ? "Satellite / Measured property" : failed ? "Imagery unavailable / Measured outline" : "Loading satellite imagery"}</span>
      {ready && <a href={source.link} target="_blank" rel="noreferrer">{source.label}{source.credit ? " · " + source.credit : ""}</a>}
    </figcaption>
  </>;
}

export default function PropertyAerialPreview(props) {
  // A new viewport must never inherit tile load events or imagery from the previous one.
  const { frame, provider } = props;
  return <AerialFrame key={`${provider}:${frame.x0}:${frame.y0}:${frame.scale}`} {...props} />;
}
