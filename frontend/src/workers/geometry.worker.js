import * as turf from "@turf/turf";

const LAYERS = ["plowable", "sidewalks", "turf", "mulch"];
const LABELS = {
  plowable: "Plowable",
  sidewalks: "Sidewalks",
  turf: "Turf",
  mulch: "Mulch",
};
const SQM_TO_SQFT = 10.7639104167097;
const TINY_POLYGON_SQFT = 25;
const OVERLAP_SCAN_LIMIT = 180;

function isPolygonLike(feature) {
  const type = feature?.geometry?.type;
  return type === "Polygon" || type === "MultiPolygon";
}

function areaSqft(feature) {
  try {
    return turf.area(feature) * SQM_TO_SQFT;
  } catch {
    return 0;
  }
}

function bboxIntersects(left, right) {
  return !(
    left[2] < right[0] ||
    left[0] > right[2] ||
    left[3] < right[1] ||
    left[1] > right[3]
  );
}

function intersectFeatures(left, right) {
  try {
    return turf.intersect(turf.featureCollection([left, right]));
  } catch {
    try {
      return turf.intersect(left, right);
    } catch {
      return null;
    }
  }
}

function isOutsideBoundary(feature, boundary) {
  if (!isPolygonLike(boundary)) return !!feature?.properties?.outside;
  try {
    return !turf.booleanWithin(feature, boundary);
  } catch {
    return !!feature?.properties?.outside;
  }
}

function analyze(layerFeatures, boundary, forceOverlapScan) {
  const totals = {};
  const polygonRows = [];
  const all = [];
  let outside = 0;
  let tiny = 0;
  let invalidArea = 0;

  for (const layer of LAYERS) {
    let layerSqft = 0;
    for (const feature of layerFeatures?.[layer] || []) {
      if (!isPolygonLike(feature)) continue;
      const sqft = areaSqft(feature);
      const featureOutside = isOutsideBoundary(feature, boundary);
      layerSqft += sqft;
      if (!Number.isFinite(sqft) || sqft <= 0) invalidArea += 1;
      if (Number.isFinite(sqft) && sqft > 0 && sqft < TINY_POLYGON_SQFT) tiny += 1;
      if (featureOutside) outside += 1;
      let bbox = null;
      try {
        bbox = turf.bbox(feature);
      } catch {
        bbox = null;
      }
      all.push({ layer, feature, bbox });
      polygonRows.push({
        layer: LABELS[layer],
        name: feature?.properties?.name || "(unnamed)",
        sqft: Math.round(sqft),
        acres: Number((sqft / 43560).toFixed(4)),
        id: feature?.id || "",
        outside: featureOutside,
      });
    }
    totals[layer] = {
      sqft: Math.round(layerSqft),
      acres: layerSqft / 43560,
    };
  }

  polygonRows.sort((a, b) => (a.layer + a.name).localeCompare(b.layer + b.name));
  const overlapScanDeferred = all.length > OVERLAP_SCAN_LIMIT && !forceOverlapScan;
  let overlaps = 0;
  let overlapSqft = 0;
  if (!overlapScanDeferred) {
    for (let leftIndex = 0; leftIndex < all.length; leftIndex += 1) {
      const left = all[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < all.length; rightIndex += 1) {
        const right = all[rightIndex];
        if (left.bbox && right.bbox && !bboxIntersects(left.bbox, right.bbox)) continue;
        const intersection = intersectFeatures(left.feature, right.feature);
        if (!isPolygonLike(intersection)) continue;
        const sqft = areaSqft(intersection);
        if (!Number.isFinite(sqft) || sqft <= 1) continue;
        overlaps += 1;
        overlapSqft += sqft;
      }
    }
  }

  return {
    totals,
    polygonRows,
    qcSummary: {
      polygons: all.length,
      overlaps,
      overlapSqft: Math.round(overlapSqft),
      outside,
      tiny,
      invalidArea,
      overlapScanDeferred,
      overlapScanThreshold: OVERLAP_SCAN_LIMIT,
    },
  };
}

self.onmessage = (event) => {
  const { requestId, layerFeatures, boundary, forceOverlapScan } = event.data || {};
  try {
    self.postMessage({
      requestId,
      ok: true,
      analysis: analyze(layerFeatures || {}, boundary || null, !!forceOverlapScan),
    });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error?.message || "Geometry analysis failed.",
    });
  }
};
