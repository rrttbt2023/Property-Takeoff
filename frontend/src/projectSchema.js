export const PROJECT_SCHEMA_VERSION = 2;

export const LAYER_KEYS = ["plowable", "sidewalks", "turf", "mulch"];

export const DEFAULT_LAYER_VISIBILITY = {
  plowable: true,
  sidewalks: true,
  turf: true,
  mulch: true,
};

export function createEmptyLayers() {
  return {
    plowable: [],
    sidewalks: [],
    turf: [],
    mulch: [],
  };
}

export function isValidProjectPayload(data) {
  if (!data || typeof data !== "object") return false;

  const versionOk =
    typeof data.version === "number" &&
    Number.isFinite(data.version) &&
    data.version >= 1 &&
    data.version <= PROJECT_SCHEMA_VERSION;

  if (!versionOk) return false;
  if (!data.layerFeatures || typeof data.layerFeatures !== "object") return false;

  for (const k of LAYER_KEYS) {
    if (!Array.isArray(data.layerFeatures[k])) return false;
  }

  return true;
}

export function normalizeLayerVisibility(input) {
  if (!input || typeof input !== "object") return { ...DEFAULT_LAYER_VISIBILITY };
  return {
    plowable: input.plowable !== false,
    sidewalks: input.sidewalks !== false,
    turf: input.turf !== false,
    mulch: input.mulch !== false,
  };
}
