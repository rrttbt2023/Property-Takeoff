import { isValidProjectPayload } from "../projectSchema";

const LAYER_KEYS = ["plowable", "sidewalks", "turf", "mulch"];

export const WORKFLOW_MODE_STORAGE_KEY = "takeoff-workflow-mode-v1";
export const PROJECT_LIBRARY_STORAGE_KEY = "takeoff-project-library-v1";
export const PROJECT_FOLDER_LIBRARY_STORAGE_KEY = "takeoff-project-folders-v1";
export const PROJECT_FOLDER_COLLAPSE_STORAGE_KEY = "takeoff-project-folders-collapsed-v1";
export const PROJECT_VERSION_HISTORY_STORAGE_KEY = "takeoff-project-version-history-v1";
export const SHARED_PROJECT_QUEUE_STORAGE_KEY = "takeoff-shared-project-queue-v1";
export const SHARED_AUTH_STORAGE_KEY = "takeoff-shared-auth-v1";
export const HOME_PINNED_PROJECTS_STORAGE_KEY = "takeoff-home-pinned-projects-v1";
export const HOME_PROJECT_PREVIEWS_STORAGE_KEY = "takeoff-home-project-previews-v1";
export const HOME_RESUME_PROJECT_STORAGE_KEY = "takeoff-home-resume-project-v1";
export const HOME_APPEARANCE_STORAGE_KEY = "takeoff-home-appearance-v1";
export const SHARED_PROJECT_LIBRARY_FETCH_LIMIT = 500;
export const PROJECT_VERSION_HISTORY_MAX_PER_PROJECT = 16;
export const WORKFLOW_MODE_LOCATION = "location";
export const WORKFLOW_MODE_PDF = "pdf";
export const DEFAULT_PROJECT_FOLDER_NAME = "Unfiled";

export function readStoredWorkflowMode() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WORKFLOW_MODE_STORAGE_KEY);
    if (raw === WORKFLOW_MODE_LOCATION || raw === WORKFLOW_MODE_PDF) return raw;
  } catch {
    /* Local storage is optional. */
  }
  return null;
}

export function buildProjectLibraryId(projectName) {
  const normalized = String(projectName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return `untitled-${Date.now()}`;
  return `name-${normalized}`;
}

export function countProjectPayloadPolygons(payload) {
  return LAYER_KEYS.reduce(
    (count, key) =>
      count +
      (Array.isArray(payload?.layerFeatures?.[key])
        ? payload.layerFeatures[key].length
        : 0),
    0
  );
}

export function readStoredProjectLibrary() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROJECT_LIBRARY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const entry of parsed) {
      const payload = entry?.payload;
      const hasValidPayload = isValidProjectPayload(payload);
      const projectName =
        String(entry?.projectName || payload?.projectName || "").trim() ||
        "Untitled Project";
      const id = String(entry?.id || buildProjectLibraryId(projectName)).trim();
      if (!id) continue;
      const storageScope =
        String(entry?.storageScope || "").trim().toLowerCase() === "shared"
          ? "shared"
          : "local";
      if (!hasValidPayload && storageScope !== "shared") continue;
      out.push({
        id,
        projectName,
        savedAt: String(entry?.savedAt || payload?.savedAt || new Date().toISOString()),
        savedBy: String(entry?.savedBy || "").trim(),
        lastEditedAt: String(
          entry?.lastEditedAt || entry?.savedAt || payload?.savedAt || ""
        ).trim(),
        revision: Math.max(0, Number(entry?.revision) || 0),
        storageScope,
        workflowMode:
          String(entry?.workflowMode || payload?.workflowMode || "").trim().toLowerCase() ===
          WORKFLOW_MODE_PDF
            ? WORKFLOW_MODE_PDF
            : WORKFLOW_MODE_LOCATION,
        folderName:
          String(entry?.folderName || entry?.folder || "").trim() ||
          DEFAULT_PROJECT_FOLDER_NAME,
        polygonCount: Number.isFinite(Number(entry?.polygonCount))
          ? Math.max(0, Number(entry.polygonCount))
          : hasValidPayload
          ? countProjectPayloadPolygons(payload)
          : 0,
        hasBoundary:
          typeof entry?.hasBoundary === "boolean"
            ? entry.hasBoundary
            : hasValidPayload
            ? !!payload?.boundary
            : false,
        payload: hasValidPayload ? payload : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function readStoredProjectFolders() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROJECT_FOLDER_LIBRARY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        const name = String(entry?.name || entry?.folderName || "").trim();
        if (!name) return null;
        return {
          name,
          workflowMode:
            String(entry?.workflowMode || "").trim().toLowerCase() === WORKFLOW_MODE_PDF
              ? WORKFLOW_MODE_PDF
              : WORKFLOW_MODE_LOCATION,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readStoredProjectFolderCollapseState() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROJECT_FOLDER_COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function buildProjectPayloadSignature(payload) {
  if (!payload || typeof payload !== "object") return "";
  try {
    const stable = { ...payload };
    delete stable.savedAt;
    delete stable.autosavedAt;
    delete stable.pdfPageSaveMeta;
    delete stable.pdfSourceAsset;
    return JSON.stringify(stable);
  } catch {
    return "";
  }
}

export function readStoredProjectVersionHistory() {
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
        const id =
          String(version?.id || "").trim() ||
          `${savedAt}-${Math.random().toString(36).slice(2, 8)}`;
        const payload = version.payload;
        normalized.push({
          id,
          savedAt,
          source,
          savedBy,
          note: String(version?.note || "").trim(),
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

export function readStoredPinnedProjectIds() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HOME_PINNED_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 24)
      : [];
  } catch {
    return [];
  }
}

export function readStoredProjectPreviewImages() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(HOME_PROJECT_PREVIEWS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const previews = {};
    for (const [projectId, imageDataUrl] of Object.entries(parsed)) {
      const normalizedId = String(projectId || "").trim();
      const normalizedImage = String(imageDataUrl || "").trim();
      if (!normalizedId || !/^data:image\/(?:jpe?g|png|webp);base64,/i.test(normalizedImage)) {
        continue;
      }
      previews[normalizedId] = normalizedImage;
      if (Object.keys(previews).length >= 24) break;
    }
    return previews;
  } catch {
    return {};
  }
}

export function readStoredResumeProject() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(HOME_RESUME_PROJECT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const projectId = String(parsed.projectId || "").trim();
    const projectName = String(parsed.projectName || "").trim();
    if (!projectId && !projectName) return null;
    return {
      projectId,
      projectName: projectName || "Untitled Project",
      workflowMode:
        String(parsed.workflowMode || "").trim().toLowerCase() === WORKFLOW_MODE_PDF
          ? WORKFLOW_MODE_PDF
          : WORKFLOW_MODE_LOCATION,
      pdfPageNumber: Math.max(1, Math.round(Number(parsed.pdfPageNumber) || 1)),
      lastEditedAt: String(parsed.lastEditedAt || parsed.savedAt || "").trim(),
      savedBy: String(parsed.savedBy || "").trim(),
    };
  } catch {
    return null;
  }
}

export function readStoredHomeAppearance() {
  if (typeof window === "undefined") return "dark";
  try {
    const raw = String(window.localStorage.getItem(HOME_APPEARANCE_STORAGE_KEY) || "")
      .trim()
      .toLowerCase();
    return raw === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function normalizeSharedQueueOperation(op) {
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
    baseRevision:
      Number.isFinite(Number(op?.baseRevision)) && Number(op.baseRevision) >= 1
        ? Math.trunc(Number(op.baseRevision))
        : null,
    payload,
  };
}

export function readStoredSharedProjectQueue() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SHARED_PROJECT_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSharedQueueOperation).filter(Boolean).slice(0, 500);
  } catch {
    return [];
  }
}

export function readStoredSharedAuth() {
  if (typeof window === "undefined") return { token: "", username: "", expiresAt: "" };
  try {
    const raw = window.localStorage.getItem(SHARED_AUTH_STORAGE_KEY);
    if (!raw) return { token: "", username: "", expiresAt: "" };
    const parsed = JSON.parse(raw);
    return {
      token: String(parsed?.token || "").trim(),
      username: String(parsed?.username || "").trim(),
      expiresAt: String(parsed?.expiresAt || "").trim(),
    };
  } catch {
    return { token: "", username: "", expiresAt: "" };
  }
}

export function isAuthError(error) {
  const text = String(error?.message || "").toLowerCase();
  return (
    text.includes("401") ||
    text.includes("login required") ||
    text.includes("session expired")
  );
}

export function upsertSharedQueueOperation(prevQueue, nextOp) {
  const queue = Array.isArray(prevQueue) ? prevQueue : [];
  const normalized = normalizeSharedQueueOperation(nextOp);
  if (!normalized) return queue;
  const filtered = queue.filter((item) => String(item?.id) !== normalized.id);
  return [...filtered, normalized].slice(-500);
}

export function buildProjectLibraryEntryFromPayload(
  payload,
  fallbackProjectName = "",
  metadata = null
) {
  if (!isValidProjectPayload(payload)) return null;
  const projectName =
    String(payload?.projectName || fallbackProjectName || "").trim() || "Untitled Project";
  const workflowMode =
    String(metadata?.workflowMode || payload?.workflowMode || "").trim().toLowerCase() ===
    WORKFLOW_MODE_PDF
      ? WORKFLOW_MODE_PDF
      : WORKFLOW_MODE_LOCATION;
  return {
    id: buildProjectLibraryId(projectName),
    projectName,
    savedAt: String(payload?.savedAt || new Date().toISOString()),
    savedBy: String(metadata?.savedBy || "").trim(),
    lastEditedAt: String(
      metadata?.lastEditedAt || payload?.savedAt || new Date().toISOString()
    ).trim(),
    revision: Math.max(0, Number(metadata?.revision || payload?.revision) || 0),
    storageScope:
      String(metadata?.storageScope || "").trim().toLowerCase() === "shared"
        ? "shared"
        : "local",
    workflowMode,
    folderName:
      String(metadata?.folderName || metadata?.folder || "").trim() ||
      DEFAULT_PROJECT_FOLDER_NAME,
    polygonCount: countProjectPayloadPolygons(payload),
    hasBoundary: !!payload?.boundary,
    payload,
  };
}

export function upsertProjectLibraryEntries(
  prevEntries,
  payload,
  fallbackProjectName = "",
  metadata = null
) {
  const nextEntry = buildProjectLibraryEntryFromPayload(payload, fallbackProjectName, metadata);
  if (!nextEntry) return Array.isArray(prevEntries) ? prevEntries : [];
  const prev = Array.isArray(prevEntries) ? prevEntries : [];
  const existing = prev.find((entry) => entry?.id === nextEntry.id);
  const incomingFolder = String(metadata?.folderName || metadata?.folder || "").trim();
  if (!nextEntry.savedBy && existing?.savedBy) nextEntry.savedBy = String(existing.savedBy).trim();
  if (!nextEntry.lastEditedAt && existing?.lastEditedAt) {
    nextEntry.lastEditedAt = String(existing.lastEditedAt).trim();
  }
  if (!nextEntry.revision && existing?.revision) {
    nextEntry.revision = Math.max(0, Number(existing.revision) || 0);
  }
  if (
    !incomingFolder &&
    String(existing?.folderName || "").trim() &&
    String(nextEntry.folderName || "").trim() === DEFAULT_PROJECT_FOLDER_NAME
  ) {
    nextEntry.folderName = String(existing.folderName).trim();
  }
  if (
    String(existing?.workflowMode || "").trim().toLowerCase() === WORKFLOW_MODE_PDF &&
    String(nextEntry.workflowMode || "").trim().toLowerCase() !== WORKFLOW_MODE_PDF
  ) {
    nextEntry.workflowMode = WORKFLOW_MODE_PDF;
  }
  if (
    String(existing?.storageScope || "").trim().toLowerCase() === "shared" &&
    String(nextEntry.storageScope || "").trim().toLowerCase() !== "shared"
  ) {
    nextEntry.storageScope = "shared";
  }
  return [nextEntry, ...prev.filter((entry) => entry?.id !== nextEntry.id)];
}

export function mergeSharedProjectLibrarySummaries(prevEntries, remoteEntries) {
  const previous = Array.isArray(prevEntries) ? prevEntries : [];
  const remote = Array.isArray(remoteEntries) ? remoteEntries : [];
  const localOnlyEntries = previous.filter(
    (entry) => String(entry?.storageScope || "").trim().toLowerCase() !== "shared"
  );
  const payloadById = new Map(
    previous
      .filter((entry) => entry?.id && entry?.payload && isValidProjectPayload(entry.payload))
      .map((entry) => [String(entry.id), entry.payload])
  );
  const previousById = new Map(
    previous.filter((entry) => entry?.id).map((entry) => [String(entry.id), entry])
  );

  const merged = remote.map((entry) => {
    const id = String(entry?.id || "").trim();
    const projectName = String(entry?.project_name || entry?.projectName || "").trim();
    const savedAt = String(entry?.saved_at || entry?.savedAt || new Date().toISOString());
    const savedBy = String(entry?.saved_by || entry?.savedBy || "").trim();
    const lastEditedAt = String(
      entry?.last_edited_at || entry?.lastEditedAt || savedAt
    ).trim();
    const revision = Math.max(0, Number(entry?.revision) || 0);
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
    const previousEntry = previousById.get(id) || null;
    const previousRevision = Math.max(0, Number(previousEntry?.revision) || 0);
    const cachedPayload = payloadById.get(id) || previousEntry?.payload || null;
    const payload =
      !revision || !previousRevision || revision === previousRevision ? cachedPayload : null;
    return {
      id,
      projectName: projectName || "Untitled Project",
      savedAt,
      savedBy,
      lastEditedAt,
      revision,
      storageScope: "shared",
      workflowMode:
        String(previousEntry?.workflowMode || payload?.workflowMode || "").trim().toLowerCase() ===
        WORKFLOW_MODE_PDF
          ? WORKFLOW_MODE_PDF
          : WORKFLOW_MODE_LOCATION,
      folderName:
        String(previousEntry?.folderName || previousEntry?.folder || "").trim() ||
        DEFAULT_PROJECT_FOLDER_NAME,
      polygonCount,
      hasBoundary,
      payload,
    };
  });
  return [...merged.filter((entry) => !!entry.id), ...localOnlyEntries];
}
