export const LAYER_COLORS = {
  plowable: { fill: "#00ffff", line: "#0088ff" },
  sidewalks: { fill: "#ffff00", line: "#ffaa00" },
  turf: { fill: "#00ff00", line: "#00cc00" },
  mulch: { fill: "#ff6600", line: "#ff5500" },
};

export const PREVIEW_WIDTH = 640;
export const PREVIEW_HEIGHT = 300;
const W = PREVIEW_WIDTH, H = PREVIEW_HEIGHT;
const MAX_LAT = 85.05112878;
const wrap = (x, n) => ((x % n) + n) % n;

export function buildPropertyFrame(layers, boundary) {
  const polygons = [];
  let referenceX;
  const add = (feature, layer) => {
    const geometry = feature?.geometry || feature;
    const polygonsInFeature = geometry?.type === "Polygon" ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
    for (const rings of polygonsInFeature || []) {
      if (!Array.isArray(rings)) continue;
      const projected = rings.map((ring) => Array.isArray(ring) ? ring.flatMap((point) => {
        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[1]) > 90) return [];
        const x = (point[0] + 180) / 360;
        referenceX ??= x;
        const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, point[1])) * Math.PI / 180;
        return [[x + Math.round(referenceX - x), (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2]];
      }) : []);
      if (projected[0]?.length >= 3) polygons.push({ layer, rings: projected.filter(ring => ring.length >= 3) });
    }
  };
  for (const layer of Object.keys(LAYER_COLORS)) {
    for (const feature of Array.isArray(layers?.[layer]) ? layers[layer] : []) add(feature, layer);
  }
  const measuredCount = polygons.length;
  add(boundary, "boundary");
  if (!polygons.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const { rings } of polygons.slice(0, measuredCount || polygons.length)) {
    for (const [x, y] of rings[0]) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  // Geographic points and raster tiles share this single Web Mercator transform.
  const scale = Math.min(256 * 2 ** 22, (W - 52) / (right - left), (H - 52) / (bottom - top));
  const x0 = (left + right) / 2 - W / (2 * scale);
  const y0 = (top + bottom) / 2 - H / (2 * scale);
  const paths = polygons.map(({ layer, rings }) => ({
    layer, d: rings.map(ring => ring.map(([x, y], i) =>
      `${i ? "L" : "M"}${((x - x0) * scale).toFixed(2)},${((y - y0) * scale).toFixed(2)}`
    ).join("") + "Z").join(""),
  }));
  const longitude = x => wrap(x * 360, 360) - 180;
  const latitude = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * Math.min(1, Math.max(0, y))))) * 180 / Math.PI;
  return { paths, x0, y0, scale, zoom: Math.max(0, Math.round(Math.log2(scale / 256))),
    bounds: { west: longitude(x0), east: longitude(x0 + W / scale), north: latitude(y0), south: latitude(y0 + H / scale) } };
}

export function tilesForFrame(frame, source) {
  const zoom = Math.min(source.maxzoom, frame.zoom);
  const n = 2 ** zoom;
  const size = frame.scale / n;
  const tiles = [];
  for (let x = Math.floor(frame.x0 * n); x < Math.ceil((frame.x0 + W / frame.scale) * n); x++) {
    for (let y = Math.max(0, Math.floor(frame.y0 * n)); y < Math.min(n, Math.ceil((frame.y0 + H / frame.scale) * n)); y++) {
      const url = source.template.replace("{z}", zoom).replace("{x}", wrap(x, n)).replace("{y}", source.tms ? n - y - 1 : y);
      tiles.push({ url, left: (x / n - frame.x0) * frame.scale, top: (y / n - frame.y0) * frame.scale, size });
    }
  }
  return tiles;
}
