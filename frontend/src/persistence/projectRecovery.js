const DB_NAME = "property-takeoff-recovery";
const DB_VERSION = 1;
const LATEST_STORE = "latest";
const HISTORY_STORE = "history";
const DEFAULT_HISTORY_LIMIT = 40;
const CHECKPOINT_INTERVAL_MS = 15000;

let dbPromise = null;
let pendingWrite = null;
let writePromise = null;
const lastCheckpointAt = new Map();

function canUseIndexedDb() {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openRecoveryDb() {
  if (!canUseIndexedDb()) {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LATEST_STORE)) {
        db.createObjectStore(LATEST_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const history = db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
        history.createIndex("projectId", "projectId", { unique: false });
        history.createIndex("savedAt", "savedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open recovery storage."));
    request.onblocked = () => reject(new Error("Recovery storage upgrade is blocked."));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Recovery storage request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Recovery transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Recovery transaction was cancelled."));
  });
}

function normalizeProjectId(projectId, payload) {
  const direct = String(projectId || "").trim();
  if (direct) return direct;
  const projectName = String(payload?.projectName || "untitled-project").trim().toLowerCase();
  return projectName.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "untitled-project";
}

function countPayloadPolygons(payload) {
  const layers = payload?.layerFeatures;
  if (!layers || typeof layers !== "object") return 0;
  return ["plowable", "sidewalks", "turf", "mulch"].reduce(
    (total, key) => total + (Array.isArray(layers[key]) ? layers[key].length : 0),
    0
  );
}

async function pruneProjectHistory(db, projectId, limit) {
  const transaction = db.transaction(HISTORY_STORE, "readwrite");
  const store = transaction.objectStore(HISTORY_STORE);
  const index = store.index("projectId");
  const records = await requestResult(index.getAll(projectId));
  const ordered = (Array.isArray(records) ? records : []).sort((a, b) =>
    String(b?.savedAt || "").localeCompare(String(a?.savedAt || ""))
  );
  for (const stale of ordered.slice(Math.max(1, limit))) {
    store.delete(stale.id);
  }
  await transactionDone(transaction);
}

async function writeSnapshot(snapshot) {
  const db = await openRecoveryDb();
  const transaction = db.transaction([LATEST_STORE, HISTORY_STORE], "readwrite");
  const latest = transaction.objectStore(LATEST_STORE);
  const history = transaction.objectStore(HISTORY_STORE);
  latest.put({ ...snapshot, key: "active" });
  latest.put({ ...snapshot, key: `project:${snapshot.projectId}` });
  if (snapshot.checkpoint) {
    history.put({
      ...snapshot,
      id: `${snapshot.projectId}:${snapshot.savedAt}:${Math.random().toString(36).slice(2, 8)}`,
    });
  }
  await transactionDone(transaction);
  if (snapshot.checkpoint) {
    await pruneProjectHistory(db, snapshot.projectId, snapshot.historyLimit);
  }
  return snapshot;
}

async function drainPendingWrites() {
  while (pendingWrite) {
    const snapshot = pendingWrite;
    pendingWrite = null;
    await writeSnapshot(snapshot);
  }
}

export function queueProjectRecoverySnapshot(
  payload,
  { projectId = "", reason = "autosave", forceCheckpoint = false, historyLimit = DEFAULT_HISTORY_LIMIT } = {}
) {
  if (!canUseIndexedDb() || !payload || typeof payload !== "object") {
    return Promise.resolve(false);
  }
  const resolvedProjectId = normalizeProjectId(projectId, payload);
  const now = Date.now();
  const previousCheckpoint = Number(lastCheckpointAt.get(resolvedProjectId) || 0);
  const checkpoint = forceCheckpoint || now - previousCheckpoint >= CHECKPOINT_INTERVAL_MS;
  if (checkpoint) lastCheckpointAt.set(resolvedProjectId, now);
  pendingWrite = {
    projectId: resolvedProjectId,
    projectName: String(payload.projectName || "Untitled Project"),
    savedAt: String(payload.autosavedAt || payload.savedAt || new Date(now).toISOString()),
    reason: String(reason || "autosave"),
    polygonCount: countPayloadPolygons(payload),
    checkpoint,
    historyLimit: Math.max(10, Math.min(200, Number(historyLimit) || DEFAULT_HISTORY_LIMIT)),
    payload,
  };
  if (!writePromise) {
    writePromise = drainPendingWrites().finally(() => {
      writePromise = null;
      if (pendingWrite) queueProjectRecoverySnapshot(pendingWrite.payload, pendingWrite);
    });
  }
  return writePromise.then(() => true).catch(() => false);
}

export async function getLatestProjectRecovery(projectId = "") {
  if (!canUseIndexedDb()) return null;
  const db = await openRecoveryDb();
  const transaction = db.transaction(LATEST_STORE, "readonly");
  const key = String(projectId || "").trim() ? `project:${String(projectId).trim()}` : "active";
  const record = await requestResult(transaction.objectStore(LATEST_STORE).get(key));
  await transactionDone(transaction);
  return record && typeof record === "object" ? record : null;
}

export async function listProjectRecoveries(limit = 100) {
  if (!canUseIndexedDb()) return [];
  const db = await openRecoveryDb();
  const transaction = db.transaction(LATEST_STORE, "readonly");
  const records = await requestResult(transaction.objectStore(LATEST_STORE).getAll());
  await transactionDone(transaction);
  const maximum = Math.max(1, Math.min(500, Number(limit) || 100));
  return (Array.isArray(records) ? records : [])
    .filter((record) => String(record?.key || "").startsWith("project:"))
    .sort((a, b) => String(b?.savedAt || "").localeCompare(String(a?.savedAt || "")))
    .slice(0, maximum)
    .map((record) => ({
      projectId: String(record?.projectId || "").trim(),
      projectName: String(record?.projectName || "Untitled Project"),
      savedAt: String(record?.savedAt || ""),
      reason: String(record?.reason || "autosave"),
      polygonCount: Math.max(0, Number(record?.polygonCount) || 0),
      recoverySource: "indexeddb",
    }));
}

export async function hasProjectRecovery() {
  try {
    return !!(await getLatestProjectRecovery());
  } catch {
    return false;
  }
}

export async function clearProjectRecovery(projectId = "") {
  if (!canUseIndexedDb()) return false;
  const db = await openRecoveryDb();
  const normalized = String(projectId || "").trim();
  const transaction = db.transaction([LATEST_STORE, HISTORY_STORE], "readwrite");
  const latest = transaction.objectStore(LATEST_STORE);
  const history = transaction.objectStore(HISTORY_STORE);
  if (!normalized) {
    latest.clear();
    history.clear();
  } else {
    latest.delete(`project:${normalized}`);
    const records = await requestResult(history.index("projectId").getAll(normalized));
    for (const record of records || []) history.delete(record.id);
  }
  await transactionDone(transaction);
  return true;
}

export async function getRecoveryStorageStatus() {
  if (!canUseIndexedDb()) return { state: "unavailable", message: "Browser recovery storage unavailable" };
  try {
    await openRecoveryDb();
    return { state: "ready", message: "IndexedDB recovery is ready" };
  } catch (error) {
    return { state: "unavailable", message: error?.message || "Recovery storage unavailable" };
  }
}
