import { bbox } from "@turf/turf";

function polygonBounds(feature) {
  if (!["Polygon", "MultiPolygon"].includes(feature?.geometry?.type)) return null;
  try {
    const box = bbox(feature, { recompute: true });
    return box.every(Number.isFinite) && box[0] < box[2] && box[1] < box[3]
      && box[1] >= -90 && box[3] <= 90 ? box : null;
  } catch {
    return null;
  }
}

export function getProjectMapBounds(layers, boundary) {
  let bounds = null;
  for (const features of Object.values(layers || {})) {
    if (!Array.isArray(features)) continue;
    for (const feature of features) {
      const box = polygonBounds(feature);
      if (!box) continue;
      bounds = bounds ? [
        Math.min(bounds[0], box[0]), Math.min(bounds[1], box[1]),
        Math.max(bounds[2], box[2]), Math.max(bounds[3], box[3]),
      ] : box;
    }
  }
  return bounds || polygonBounds(boundary);
}

// Fitting needs a sized viewport, not downloaded imagery or a loaded style.
export function frameOpenedProject(map, bounds) {
  if (!bounds) return;
  const container = map.getContainer();
  let observer;
  const fit = () => {
    const size = Math.min(container.clientWidth, container.clientHeight);
    if (!size) return false;
    observer?.disconnect();
    map.resize();
    map.fitBounds(bounds, { padding: Math.min(50, Math.floor(size / 8)), maxZoom: 21, animate: false });
    return true;
  };
  if (!fit()) {
    observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }
}
