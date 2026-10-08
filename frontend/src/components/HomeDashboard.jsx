import { useMemo, useRef, useState } from "react";

import {
  DEFAULT_PROJECT_FOLDER_NAME,
  WORKFLOW_MODE_LOCATION,
  WORKFLOW_MODE_PDF,
} from "../projects/projectLibrary";
import "./home-dashboard.css";

const PREVIEW_LAYER_COLORS = {
  plowable: "#2586e8",
  sidewalks: "#f5a524",
  turf: "#57b44a",
  mulch: "#b66bd8",
};

function Icon({ name, size = 18, strokeWidth = 1.8 }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-7h6v7" /></>,
    pin: <><path d="M12 21s7-5.3 7-12a7 7 0 1 0-14 0c0 6.7 7 12 7 12Z" /><circle cx="12" cy="9" r="2.2" /></>,
    file: <><path d="M6 2h8l4 4v16H6Z" /><path d="M14 2v5h5" /><path d="M9 12h6M9 16h6" /></>,
    upload: <><path d="M12 16V3" /><path d="m7 8 5-5 5 5" /><path d="M4 14v6h16v-6" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20c.3-4 2.4-6 6-6s5.7 2 6 6" /><circle cx="17" cy="9" r="2.2" /><path d="M16 15c3.1.2 4.8 1.9 5 5" /></>,
    folder: <path d="M3 6h7l2 2h9v11H3Z" />,
    report: <><path d="M5 3h10l4 4v14H5Z" /><path d="M15 3v5h5M8 12h8M8 16h6" /></>,
    shield: <><path d="M12 2 20 5v6c0 5.2-3.4 8.6-8 11-4.6-2.4-8-5.8-8-11V5Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>,
    sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7.5 7.5 0 1 1-2-5.1L20 9" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    map: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2Z" /><path d="M9 3v16M15 5v16" /></>,
    polygon: <path d="m5 6 7-3 7 5-2 10-9 3-5-8Z" />,
    edit: <><path d="m4 20 4.5-1 10.8-10.8a2.3 2.3 0 0 0-3.3-3.3L5.2 15.7Z" /><path d="m14.5 6.5 3 3" /></>,
    logout: <><path d="M10 4H4v16h6" /><path d="M14 8l4 4-4 4M8 12h10" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14" /><path d="M10 11v6M14 11v6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    cloud: <><path d="M7 18h10a4 4 0 0 0 .7-7.9A6 6 0 0 0 6.4 8.4 4.8 4.8 0 0 0 7 18Z" /><path d="m9 13 2 2 4-4" /></>,
    warning: <><path d="M12 3 2.8 20h18.4Z" /><path d="M12 9v4M12 17h.01" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  };

  return (
    <svg
      aria-hidden="true"
      className="hd-icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    >
      {paths[name] || paths.grid}
    </svg>
  );
}

function formatDate(value, options = {}) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return options.fallback || "Not saved yet";
  return date.toLocaleString([], options.short
    ? { month: "short", day: "numeric", year: "numeric" }
    : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function entryMode(entry) {
  return String(entry?.workflowMode || entry?.payload?.workflowMode || "").toLowerCase() === WORKFLOW_MODE_PDF
    ? WORKFLOW_MODE_PDF
    : WORKFLOW_MODE_LOCATION;
}

function entryEditedAt(entry) {
  return entry?.lastEditedAt || entry?.savedAt || entry?.payload?.savedAt || "";
}

function sortedProjects(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort(
    (a, b) => new Date(entryEditedAt(b)).getTime() - new Date(entryEditedAt(a)).getTime()
  );
}

function getInitials(name) {
  const parts = String(name || "Shared user").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "MS";
}

function collectPolygonRings(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === "Polygon") return geometry.coordinates.slice(0, 1);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flatMap((polygon) => polygon.slice(0, 1));
  }
  return [];
}

function previewShapes(entry) {
  const payload = entry?.payload || {};
  const raw = [];
  const addFeature = (feature, layer) => {
    for (const ring of collectPolygonRings(feature?.geometry || feature)) {
      if (Array.isArray(ring) && ring.length >= 3) raw.push({ layer, ring });
    }
  };

  addFeature(payload.boundary, "boundary");
  const layers = payload.layerFeatures || payload.layers || {};
  for (const layer of Object.keys(PREVIEW_LAYER_COLORS)) {
    const features = Array.isArray(layers?.[layer]) ? layers[layer].slice(0, 80) : [];
    for (const feature of features) addFeature(feature, layer);
  }
  if (!raw.length) return [];

  const points = raw.flatMap(({ ring }) => ring).filter(
    (point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
  );
  if (!points.length) return [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const x = Number(point[0]);
    const y = Number(point[1]);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const spanX = Math.max(0.000001, maxX - minX);
  const spanY = Math.max(0.000001, maxY - minY);
  const scale = Math.min(660 / spanX, 320 / spanY);
  const offsetX = 50 + (660 - spanX * scale) / 2;
  const offsetY = 35 + (320 - spanY * scale) / 2;

  return raw.map(({ layer, ring }, index) => ({
    layer,
    key: `${layer}-${index}`,
    points: ring.map((point) => {
      const x = offsetX + (Number(point[0]) - minX) * scale;
      const y = 355 - (offsetY + (Number(point[1]) - minY) * scale);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" "),
  }));
}

async function imageFileToPreviewDataUrl(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("Choose a PNG, JPG, or WebP image.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("That image could not be opened."));
      nextImage.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image preview is unavailable in this browser.");
    const sourceRatio = image.naturalWidth / Math.max(1, image.naturalHeight);
    const targetRatio = canvas.width / canvas.height;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = image.naturalWidth;
    let sourceHeight = image.naturalHeight;
    if (sourceRatio > targetRatio) {
      sourceWidth = image.naturalHeight * targetRatio;
      sourceX = (image.naturalWidth - sourceWidth) / 2;
    } else {
      sourceHeight = image.naturalWidth / targetRatio;
      sourceY = (image.naturalHeight - sourceHeight) / 2;
    }
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    return canvas.toDataURL("image/jpeg", 0.78);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function ProjectGeometryPreview({ entry, imageUrl = "" }) {
  const shapes = useMemo(() => previewShapes(entry), [entry]);
  const [zoom, setZoom] = useState(1);

  return (
    <div className="hd-plan-preview" aria-label="Saved project geometry preview">
      <div className="hd-preview-stage" style={{ transform: `scale(${zoom})` }}>
      {imageUrl ? (
        <img src={imageUrl} alt={`Preview for ${entry?.projectName || "saved project"}`} />
      ) : <svg viewBox="0 0 760 390" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="hd-aerial" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#274536" />
            <stop offset="0.48" stopColor="#385641" />
            <stop offset="1" stopColor="#1f3940" />
          </linearGradient>
          <pattern id="hd-grid" width="50" height="50" patternUnits="userSpaceOnUse" patternTransform="rotate(14)">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="760" height="390" fill="url(#hd-aerial)" />
        <path d="M-60 110 820 290M-40 285 760 35" stroke="rgba(210,216,202,.22)" strokeWidth="46" />
        <path d="M-60 110 820 290M-40 285 760 35" stroke="rgba(30,38,39,.38)" strokeWidth="34" />
        <rect width="760" height="390" fill="url(#hd-grid)" />
        {shapes.length ? shapes.map((shape) => (
          <polygon
            key={shape.key}
            points={shape.points}
            fill={shape.layer === "boundary" ? "rgba(255,255,255,.06)" : `${PREVIEW_LAYER_COLORS[shape.layer]}55`}
            stroke={shape.layer === "boundary" ? "#ffffff" : PREVIEW_LAYER_COLORS[shape.layer]}
            strokeWidth={shape.layer === "boundary" ? 3 : 2.4}
            vectorEffect="non-scaling-stroke"
          />
        )) : (
          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="m112 292 52-166 148-51 93 67 122-35 116 80-31 125-196 31-117-52Z" fill="rgba(62,145,219,.24)" stroke="#4fa7f2" strokeWidth="5" />
            <path d="m182 245 33-89 87-31 51 38-31 91-94 28Z" fill="rgba(88,181,75,.3)" stroke="#64c653" strokeWidth="4" />
            <path d="m432 151 84-23 74 53-27 70-95 15-42-48Z" fill="rgba(245,165,36,.28)" stroke="#f5a524" strokeWidth="4" />
          </g>
        )}
      </svg>}
      </div>
      <div className="hd-preview-controls">
        <button type="button" onClick={() => setZoom((value) => Math.min(2, value + 0.2))} aria-label="Zoom preview in">+</button>
        <button type="button" onClick={() => setZoom((value) => Math.max(1, value - 0.2))} aria-label="Zoom preview out">-</button>
        {zoom > 1 ? <button type="button" onClick={() => setZoom(1)} aria-label="Reset preview zoom">1:1</button> : null}
      </div>
      <div className="hd-preview-badge"><Icon name={imageUrl ? "file" : "polygon"} size={14} /> {imageUrl ? "Selected project image" : "Live project geometry"}</div>
    </div>
  );
}

function SectionTitle({ title, action, onAction }) {
  return (
    <div className="hd-section-title">
      <h2>{title}</h2>
      {action ? <button type="button" className="hd-text-action" onClick={onAction}>{action}</button> : null}
    </div>
  );
}

function HomeDashboard({
  theme,
  onToggleTheme,
  resumeCard,
  onResume,
  stats,
  projects,
  groupedProjects,
  pinnedProjects,
  pinnedProjectIds,
  projectPreviewImages,
  onSetProjectPreviewImage,
  projectTab,
  onProjectTabChange,
  projectSearch,
  onProjectSearchChange,
  folderFilter,
  onFolderFilterChange,
  folderOptions,
  newFolderName,
  onNewFolderNameChange,
  collapsedFolders,
  onToggleFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onAssignFolder,
  onOpenProject,
  onTogglePinned,
  onRemoveProject,
  onNewLocation,
  onNewPdf,
  onImportProject,
  sharedAuthenticated,
  sharedAuthChecking,
  sharedUsername,
  sharedExpiresAt,
  loginUsername,
  onLoginUsernameChange,
  loginPassword,
  onLoginPasswordChange,
  loginSubmitting,
  onLogin,
  onLogout,
  sharedStatusLabel,
  sharedQueueCount,
  sharedQueue,
  sharedConnectionState,
  conflictProjectId,
  sharedRefreshing,
  sharedSyncing,
  onRefreshShared,
  onSyncShared,
  folderUploadState,
  onUploadAllFolders,
  recoveryRecords,
  recoveryStorageState,
  recoveryRefreshing,
  onRefreshRecoveries,
  onRestoreRecovery,
  auditEvents,
  auditSyncing,
  onRefreshAudit,
}) {
  const importInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const mainRef = useRef(null);
  const recentProjects = useMemo(() => sortedProjects(projects), [projects]);
  const recentProject = recentProjects[0] || null;
  const localProjectCount = recentProjects.filter(
    (entry) =>
      String(entry?.storageScope || "").trim().toLowerCase() !== "shared" &&
      entry?.payload
  ).length;
  const [selectedPreviewProjectId, setSelectedPreviewProjectId] = useState("");
  const [activeNavigation, setActiveNavigation] = useState("dashboard");
  const [folderMessage, setFolderMessage] = useState("");
  const [previewImageLoadingId, setPreviewImageLoadingId] = useState("");
  const [previewImageError, setPreviewImageError] = useState("");
  const [restoringRecoveryId, setRestoringRecoveryId] = useState("");
  const previewProject =
    recentProjects.find((entry) => entry.id === selectedPreviewProjectId) || recentProject;
  const activityProjects = recentProjects.slice(0, 4);
  const pinnedSet = pinnedProjectIds instanceof Set ? pinnedProjectIds : new Set();
  const queuedProjectOperations = new Map(
    (Array.isArray(sharedQueue) ? sharedQueue : []).map((operation) => [
      String(operation?.id || "").trim(),
      operation,
    ])
  );
  const recoveryByProjectId = new Map(
    (Array.isArray(recoveryRecords) ? recoveryRecords : []).map((record) => [
      String(record?.projectId || "").trim(),
      record,
    ])
  );
  const latestRecovery = Array.isArray(recoveryRecords) ? recoveryRecords[0] || null : null;
  const latestSharedProject = recentProjects.find(
    (entry) => String(entry?.storageScope || "").trim().toLowerCase() === "shared"
  ) || null;
  const allPinnedProjects = recentProjects.filter((entry) => pinnedSet.has(String(entry.id || "").trim()));
  const folderCards = (folderOptions || []).map((folderName) => ({
    name: folderName,
    count: recentProjects.filter((entry) => (
      entryMode(entry) === projectTab
      && (String(entry.folderName || "").trim() || DEFAULT_PROJECT_FOLDER_NAME) === folderName
    )).length,
  }));
  const isDark = theme !== "light";
  const pageDetails = {
    dashboard: {
      title: resumeCard?.title || "Project Dashboard",
      description: resumeCard?.workflowMode === WORKFLOW_MODE_PDF ? "PDF / Image Mode" : "Location Mode",
    },
    "location-projects": { title: "Location Projects", description: "Map-based property takeoffs" },
    "pdf-projects": { title: "PDF / Image Projects", description: "Plans, markups, and calibrated measurements" },
    import: { title: "Import Project", description: "Open a saved Property Takeoff JSON file" },
    "all-projects": { title: "All Projects", description: "Search and manage the complete shared library" },
    "pinned-sites": { title: "Pinned Sites", description: "Quick access to your priority properties" },
    folders: { title: "Folders", description: "Organize projects by team, route, or service area" },
    activity: { title: "Project Activity", description: "Recent saves, edits, and shared updates" },
    recovery: { title: "Recovery Center", description: "Autosave snapshots and shared-sync health" },
    admin: { title: "Admin Tools", description: "Security, access, and audit information" },
  };
  const currentPage = pageDetails[activeNavigation] || pageDetails.dashboard;

  const showPage = (page) => {
    setActiveNavigation(page);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
      mainRef.current?.focus({ preventScroll: true });
    });
  };
  const showMode = (mode) => {
    onProjectTabChange(mode);
    onFolderFilterChange("all");
    showPage(mode === WORKFLOW_MODE_PDF ? "pdf-projects" : "location-projects");
  };
  const showAllProjects = () => {
    onFolderFilterChange("all");
    onProjectSearchChange("");
    showPage("all-projects");
  };
  const showFolderTools = () => {
    showPage("folders");
    window.setTimeout(() => folderInputRef.current?.focus(), 80);
  };
  const showFolderInProjects = (folderName) => {
    onProjectSearchChange("");
    onFolderFilterChange(folderName);
    showPage("all-projects");
  };
  const createFolder = () => {
    const normalizedName = String(newFolderName || "").trim();
    if (!normalizedName) {
      setFolderMessage("Enter a folder name first.");
      folderInputRef.current?.focus();
      return;
    }
    const alreadyExists = folderOptions.some(
      (folder) => String(folder || "").trim().toLowerCase() === normalizedName.toLowerCase()
    );
    onCreateFolder();
    setFolderMessage(alreadyExists ? "That folder already exists and is now selected." : `Created ${normalizedName}.`);
    window.setTimeout(() => setFolderMessage(""), 3600);
  };
  const chooseProjectPreview = async (projectId, file) => {
    const normalizedId = String(projectId || "").trim();
    if (!normalizedId || !file) return;
    setPreviewImageLoadingId(normalizedId);
    setPreviewImageError("");
    try {
      const dataUrl = await imageFileToPreviewDataUrl(file);
      onSetProjectPreviewImage(normalizedId, dataUrl);
    } catch (error) {
      setPreviewImageError(error?.message || "That image could not be used.");
    } finally {
      setPreviewImageLoadingId("");
    }
  };
  const getProjectHealth = (entryOrId) => {
    const entry = typeof entryOrId === "object" ? entryOrId : null;
    const projectId = String(entry?.id || entryOrId || "").trim();
    const queued = queuedProjectOperations.get(projectId);
    if (projectId && String(conflictProjectId || "").trim() === projectId) {
      return { key: "conflict", label: "Conflict", icon: "warning", detail: "A newer shared version needs review." };
    }
    if (queued) {
      return {
        key: "queued",
        label: queued.op === "delete" ? "Delete queued" : "Waiting upload",
        icon: "upload",
        detail: "Saved on this device and waiting for shared sync.",
      };
    }
    if (String(entry?.storageScope || "").trim().toLowerCase() === "shared") {
      return { key: "synced", label: "Fully synced", icon: "check", detail: "The latest saved project is in shared storage." };
    }
    return { key: "local", label: "Local only", icon: "database", detail: "This project is currently stored only on this device." };
  };
  const previewProjectHealth = previewProject ? getProjectHealth(previewProject) : null;
  const restoreRecovery = async (record) => {
    const restoreId = `${record?.projectId || "recovery"}:${record?.savedAt || "latest"}`;
    setRestoringRecoveryId(restoreId);
    try {
      await onRestoreRecovery(record);
    } finally {
      setRestoringRecoveryId("");
    }
  };
  const renderPinnedProject = (entry, expanded = false) => {
    const projectId = String(entry.id || "").trim();
    const previewImage = projectPreviewImages?.[projectId] || "";
    const health = getProjectHealth(entry);
    return (
      <div key={entry.id} className={`hd-pinned-project${expanded ? " hd-pinned-project-large" : ""}`}>
        <button type="button" className="hd-pinned-open" onClick={() => onOpenProject(entry.id)}>
          <span className="hd-mini-map">
            {previewImage ? <img src={previewImage} alt={`Preview for ${entry.projectName || "pinned project"}`} /> : <Icon name={entryMode(entry) === WORKFLOW_MODE_PDF ? "file" : "map"} size={expanded ? 30 : 18} />}
          </span>
          <span>
            <strong>{entry.projectName || "Untitled Project"}</strong>
            <small>{entryMode(entry) === WORKFLOW_MODE_PDF ? "PDF / Image" : "Location"} · Edited {formatDate(entryEditedAt(entry), { short: true })}</small>
          </span>
          <Icon name="chevron" size={15} />
        </button>
        <div className="hd-pinned-preview-actions">
          <i className={`hd-project-health ${health.key}`} title={health.detail}><Icon name={health.icon} size={11} />{health.label}</i>
          <label>
            {previewImageLoadingId === projectId ? "Preparing..." : previewImage ? "Change preview image" : "Choose preview image"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={previewImageLoadingId === projectId}
              onChange={(event) => {
                const file = event.target.files?.[0];
                void chooseProjectPreview(entry.id, file);
                event.target.value = "";
              }}
            />
          </label>
          {previewImage ? <button type="button" onClick={() => onSetProjectPreviewImage(entry.id, "")}>Remove image</button> : null}
          {expanded ? <button type="button" onClick={() => onTogglePinned(entry.id)}>Unpin</button> : null}
        </div>
      </div>
    );
  };

  return (
    <div className="home-dashboard" data-theme={isDark ? "dark" : "light"}>
      <aside className="hd-sidebar">
        <div className="hd-brand">
          <img src="/logo.png" alt="McKenna Site Management" />
          <div><strong>McKenna</strong><span>Site Management</span></div>
        </div>

        <nav className="hd-nav" aria-label="Home dashboard navigation">
          <button type="button" className={activeNavigation === "dashboard" ? "active" : ""} aria-current={activeNavigation === "dashboard" ? "page" : undefined} onClick={() => showPage("dashboard")}><Icon name="home" />Dashboard</button>
          <p>Measure</p>
          <button type="button" className={activeNavigation === "location-projects" ? "active" : ""} onClick={() => showMode(WORKFLOW_MODE_LOCATION)}><Icon name="pin" />Location Projects</button>
          <button type="button" className={activeNavigation === "pdf-projects" ? "active" : ""} onClick={() => showMode(WORKFLOW_MODE_PDF)}><Icon name="file" />PDF / Image Projects</button>
          <button type="button" className={activeNavigation === "import" ? "active" : ""} onClick={() => showPage("import")}><Icon name="upload" />Import Project</button>
          <p>Project Library</p>
          <button type="button" className={activeNavigation === "all-projects" ? "active" : ""} onClick={showAllProjects}><Icon name="grid" />All Projects</button>
          <button type="button" className={activeNavigation === "pinned-sites" ? "active" : ""} onClick={() => showPage("pinned-sites")}><Icon name="star" />Pinned Sites</button>
          <button type="button" className={activeNavigation === "folders" ? "active" : ""} onClick={showFolderTools}><Icon name="folder" />Folders</button>
          <p>Tools</p>
          <button type="button" className={activeNavigation === "activity" ? "active" : ""} onClick={() => showPage("activity")}><Icon name="report" />Project Activity</button>
          <button type="button" className={activeNavigation === "recovery" ? "active" : ""} onClick={() => showPage("recovery")}><Icon name="database" />Recovery Center</button>
          <button type="button" className={activeNavigation === "admin" ? "active" : ""} onClick={() => showPage("admin")}><Icon name="shield" />Admin Tools</button>
        </nav>

        <div className="hd-account">
          {sharedAuthenticated ? (
            <>
              <div className="hd-avatar">{getInitials(sharedUsername)}</div>
              <div className="hd-account-copy"><strong>{sharedUsername || "Shared user"}</strong><span>{sharedStatusLabel}</span></div>
              <button type="button" className="hd-icon-button" onClick={onLogout} title="Log out"><Icon name="logout" /></button>
            </>
          ) : (
            <form className="hd-login" onSubmit={onLogin}>
              <strong>Shared project login</strong>
              <input value={loginUsername} onChange={(event) => onLoginUsernameChange(event.target.value)} placeholder="Username" autoComplete="username" />
              <input type="password" value={loginPassword} onChange={(event) => onLoginPasswordChange(event.target.value)} placeholder="Password" autoComplete="current-password" />
              <button type="submit" disabled={loginSubmitting || sharedAuthChecking}>{loginSubmitting ? "Signing in..." : "Sign in"}</button>
            </form>
          )}
        </div>
      </aside>

      <main ref={mainRef} className="hd-main" id="dashboard-top" tabIndex={-1}>
        <header className="hd-topbar">
          <div className="hd-current-project">
            <Icon name="pin" size={24} />
            <div>
              <h1>{currentPage.title}</h1>
              <p><span className="hd-status-dot" />{currentPage.description}{activeNavigation === "dashboard" ? <><span className="hd-meta-separator" />Last edited: {formatDate(resumeCard?.lastEditedAt, { short: true, fallback: "No recent edit" })}</> : null}</p>
            </div>
          </div>
          <div className="hd-top-actions">
            <button type="button" className="hd-theme-toggle" onClick={onToggleTheme} aria-pressed={isDark}>
              <Icon name={isDark ? "moon" : "sun"} size={17} />
              <span>{isDark ? "Dark project hub" : "Brighter project hub"}</span>
              <i><b /></i>
            </button>
            {resumeCard ? <button type="button" className="hd-button hd-button-outline" onClick={onResume}>Resume Where I Left Off</button> : null}
            <button type="button" className="hd-button hd-button-primary" onClick={onNewLocation}><Icon name="plus" />New Project</button>
          </div>
        </header>

        {activeNavigation === "dashboard" ? <>
        <section className="hd-hero">
          <div className="hd-hero-copy">
            <h2>Plan smarter.<br />Measure faster.<br /><em>Win more.</em></h2>
            <p>Accurate snow and landscape takeoffs from map or plan in minutes.</p>
            <div className="hd-hero-actions">
              <button type="button" className="hd-button hd-button-primary" onClick={onNewLocation}><Icon name="pin" />Measure on Map</button>
              <button type="button" className="hd-button hd-button-glass" onClick={onNewPdf}><Icon name="file" />Measure from PDF/Image</button>
            </div>
          </div>
          <div className="hd-summary-card">
            <SectionTitle title="Today's Summary" action="View Projects" onAction={showAllProjects} />
            <div className="hd-summary-grid">
              <div><Icon name="polygon" /><strong>{stats.totalVisible.toLocaleString()}</strong><span>{stats.activeModeLabel} Projects</span></div>
              <div><Icon name="star" /><strong>{stats.pinnedCount.toLocaleString()}</strong><span>Pinned Sites</span></div>
              <div><Icon name="map" /><strong>{stats.activePolygonCount.toLocaleString()}</strong><span>{projectTab === WORKFLOW_MODE_PDF ? "Marked-up Files" : "Measured Polygons"}</span></div>
              <div><Icon name="folder" /><strong>{stats.folderCount.toLocaleString()}</strong><span>Project Folders</span></div>
            </div>
          </div>
        </section>

        {!sharedAuthenticated ? (
          <section className="hd-auth-notice">
            <Icon name="shield" size={22} />
            <div><strong>Your shared library is locked.</strong><span>Local projects and recovery snapshots remain available. Sign in to load and sync team projects.</span></div>
          </section>
        ) : null}

        <section className="hd-recovery-overview">
          <div className="hd-recovery-overview-title">
            <span><Icon name="database" size={22} /></span>
            <div><strong>Autosave Recovery</strong><small>{latestRecovery ? `${latestRecovery.projectName} is recoverable` : "No recovery snapshot found yet"}</small></div>
          </div>
          <div className="hd-recovery-overview-fact"><span>Last device save</span><strong>{latestRecovery ? formatDate(latestRecovery.savedAt) : "Not available"}</strong></div>
          <div className="hd-recovery-overview-fact"><span>Last shared save</span><strong>{latestSharedProject ? formatDate(entryEditedAt(latestSharedProject)) : "Not synced yet"}</strong></div>
          <div className={`hd-recovery-overview-fact ${sharedQueueCount ? "warn" : ""}`}><span>Waiting to upload</span><strong>{sharedQueueCount} change{sharedQueueCount === 1 ? "" : "s"}</strong></div>
          <button type="button" className="hd-button hd-button-outline" onClick={() => showPage("recovery")}>Open Recovery Center</button>
        </section>

        <section className="hd-overview-grid">
          <article className="hd-card hd-recent-card">
            <SectionTitle title="Recent Project Preview" action={previewProject ? "Open Project" : null} onAction={() => previewProject && onOpenProject(previewProject.id)} />
            {recentProjects.length > 1 ? (
              <label className="hd-preview-selector">
                <span>Previewing</span>
                <select value={previewProject?.id || ""} onChange={(event) => setSelectedPreviewProjectId(event.target.value)}>
                  {recentProjects.slice(0, 10).map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.projectName || "Untitled Project"}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="hd-recent-content">
              <div>
                <ProjectGeometryPreview
                  key={`${previewProject?.id || "empty"}-${projectPreviewImages?.[String(previewProject?.id || "").trim()] ? "image" : "geometry"}`}
                  entry={previewProject}
                  imageUrl={projectPreviewImages?.[String(previewProject?.id || "").trim()] || ""}
                />
                <div className="hd-preview-legend">
                  {Object.entries(PREVIEW_LAYER_COLORS).map(([layer, color]) => (
                    <span key={layer}><i style={{ background: color }} />{layer === "plowable" ? "Plowable" : layer[0].toUpperCase() + layer.slice(1)}</span>
                  ))}
                </div>
              </div>
              <div className="hd-recent-details">
                <span>Most recent project</span>
                <h3>{previewProject?.projectName || "Your next takeoff starts here"}</h3>
                <strong>{previewProject ? (entryMode(previewProject) === WORKFLOW_MODE_PDF ? `Page ${Math.max(1, Number(previewProject.pdfPageNumber) || 1)}` : `${Number(previewProject.polygonCount || 0).toLocaleString()} polygons`) : "No project selected"}</strong>
                {previewProjectHealth ? <i className={`hd-project-health hd-preview-health ${previewProjectHealth.key}`} title={previewProjectHealth.detail}><Icon name={previewProjectHealth.icon} size={11} />{previewProjectHealth.label}</i> : null}
                {previewProject ? <div className="hd-preview-facts">
                  <span><Icon name={entryMode(previewProject) === WORKFLOW_MODE_PDF ? "file" : "map"} size={14} />{entryMode(previewProject) === WORKFLOW_MODE_PDF ? "PDF / Image" : "Location"}</span>
                  <span><Icon name="polygon" size={14} />Boundary {previewProject.hasBoundary ? "saved" : "not set"}</span>
                  <span><Icon name="folder" size={14} />{String(previewProject.folderName || "").trim() || DEFAULT_PROJECT_FOLDER_NAME}</span>
                </div> : null}
                <p>{previewProject ? `Last edited ${formatDate(entryEditedAt(previewProject))}${previewProject.savedBy ? ` by ${previewProject.savedBy}` : ""}` : "Create a location or PDF project to see a live geometry preview."}</p>
                {previewProject ? <button type="button" className="hd-button hd-button-primary hd-preview-open" onClick={() => onOpenProject(previewProject.id)}>Continue Measuring</button> : null}
              </div>
            </div>
          </article>

          <article className="hd-card" id="pinned-sites">
            <SectionTitle title="Pinned Sites" action="View All" onAction={() => showPage("pinned-sites")} />
            <div className="hd-pinned-list">
              {pinnedProjects.length ? pinnedProjects.slice(0, 5).map((entry) => renderPinnedProject(entry)) : <div className="hd-empty-state"><Icon name="star" /><span>Pin the projects your team uses most and they will stay here.</span></div>}
              {previewImageError ? <div className="hd-preview-error">{previewImageError}</div> : null}
            </div>
          </article>

          <article className="hd-card" id="activity-feed">
            <SectionTitle title="Activity Feed" action={sharedAuthenticated ? "Refresh" : null} onAction={onRefreshShared} />
            <div className="hd-activity-list">
              {activityProjects.length ? activityProjects.map((entry, index) => (
                <div className="hd-activity-item" key={entry.id}>
                  <span><Icon name={index === 0 ? "edit" : entryMode(entry) === WORKFLOW_MODE_PDF ? "file" : "polygon"} /></span>
                  <div><strong>{index === 0 ? "Project updated" : entryMode(entry) === WORKFLOW_MODE_PDF ? "Plan saved" : "Measurement saved"}</strong><p>{entry.projectName || "Untitled Project"}</p><small>{formatDate(entryEditedAt(entry))}</small></div>
                </div>
              )) : <div className="hd-empty-state"><Icon name="clock" /><span>Recent project updates will appear here.</span></div>}
              {sharedQueueCount > 0 ? <div className="hd-activity-item hd-activity-warning"><span><Icon name="refresh" /></span><div><strong>{sharedQueueCount} update{sharedQueueCount === 1 ? "" : "s"} waiting to sync</strong><button type="button" onClick={onSyncShared} disabled={sharedSyncing}>{sharedSyncing ? "Syncing..." : "Sync now"}</button></div></div> : null}
            </div>
          </article>
        </section>

        <section className="hd-dashboard-folders">
          <div className="hd-dashboard-folder-heading">
            <SectionTitle title="Project Folders" action="Manage Folders" onAction={showFolderTools} />
            <button
              type="button"
              className="hd-button hd-button-outline hd-folder-upload"
              onClick={onUploadAllFolders}
              disabled={
                !sharedAuthenticated ||
                folderUploadState?.running ||
                localProjectCount === 0
              }
              title={!sharedAuthenticated ? "Sign in to Shared Projects first" : "Upload every browser-only project and preserve its folder"}
            >
              <Icon name="upload" size={17} />
              {folderUploadState?.running
                ? `Uploading ${folderUploadState.completed}/${folderUploadState.total}`
                : `Upload All Folders${localProjectCount ? ` (${localProjectCount})` : ""}`}
            </button>
            <div className="hd-mode-tabs" aria-label="Dashboard folder type">
              <button type="button" className={projectTab === WORKFLOW_MODE_LOCATION ? "active" : ""} onClick={() => onProjectTabChange(WORKFLOW_MODE_LOCATION)}>Location</button>
              <button type="button" className={projectTab === WORKFLOW_MODE_PDF ? "active" : ""} onClick={() => onProjectTabChange(WORKFLOW_MODE_PDF)}>PDF / Image</button>
            </div>
          </div>
          <div className="hd-folder-grid hd-dashboard-folder-grid">
            {folderCards.map((folder) => (
              <article className="hd-folder-card" key={folder.name}>
                <button type="button" className="hd-folder-card-open" onClick={() => showFolderInProjects(folder.name)}>
                  <span className="hd-folder-card-icon"><Icon name="folder" size={44} strokeWidth={1.45} /></span>
                  <span><strong>{folder.name}</strong><small>{folder.count} project{folder.count === 1 ? "" : "s"}</small></span>
                  <Icon name="chevron" size={18} />
                </button>
              </article>
            ))}
          </div>
        </section>
        </> : null}

        {activeNavigation === "import" ? (
          <section className="hd-page hd-import-page">
            <div className="hd-page-intro">
              <span className="hd-page-kicker">Saved project file</span>
              <h2>Bring a takeoff back into your workspace.</h2>
              <p>Choose a Property Takeoff JSON export. The project will open with its saved folders, measurements, polygons, and drawing data.</p>
            </div>
            <button type="button" className="hd-import-dropzone" onClick={() => importInputRef.current?.click()}>
              <span><Icon name="upload" size={42} /></span>
              <strong>Select a project JSON file</strong>
              <small>Choose a file from this device, iCloud Drive, or a shared team folder.</small>
              <i>Browse files</i>
            </button>
          </section>
        ) : null}

        {activeNavigation === "pinned-sites" ? (
          <section className="hd-page">
            <div className="hd-page-intro hd-page-intro-row">
              <div><span className="hd-page-kicker">Priority properties</span><h2>Your pinned sites</h2><p>Open frequently used properties quickly and choose a recognizable photo or map image for each card.</p></div>
              <button type="button" className="hd-button hd-button-outline" onClick={showAllProjects}>Find more projects</button>
            </div>
            <div className="hd-pinned-page-grid">
              {allPinnedProjects.length ? allPinnedProjects.map((entry) => renderPinnedProject(entry, true)) : <div className="hd-card hd-empty-state"><Icon name="star" size={34} /><span>No projects are pinned yet. Open All Projects and select the star beside a project.</span></div>}
            </div>
            {previewImageError ? <div className="hd-preview-error">{previewImageError}</div> : null}
          </section>
        ) : null}

        {activeNavigation === "folders" ? (
          <section className="hd-page">
            <div className="hd-page-intro hd-folder-page-header">
              <div><span className="hd-page-kicker">Project organization</span><h2>Folders</h2><p>Create service-area or team folders, then open one to see only its projects.</p></div>
              <button
                type="button"
                className="hd-button hd-button-outline hd-folder-upload"
                onClick={onUploadAllFolders}
                disabled={
                  !sharedAuthenticated ||
                  folderUploadState?.running ||
                  localProjectCount === 0
                }
                title={!sharedAuthenticated ? "Sign in to Shared Projects first" : "Upload every browser-only project and preserve its folder"}
              >
                <Icon name="upload" size={17} />
                {folderUploadState?.running
                  ? `Uploading ${folderUploadState.completed}/${folderUploadState.total}`
                  : `Upload All Folders${localProjectCount ? ` (${localProjectCount})` : ""}`}
              </button>
              <div className="hd-mode-tabs hd-folder-mode-tabs">
                <button type="button" className={projectTab === WORKFLOW_MODE_LOCATION ? "active" : ""} onClick={() => onProjectTabChange(WORKFLOW_MODE_LOCATION)}>Location</button>
                <button type="button" className={projectTab === WORKFLOW_MODE_PDF ? "active" : ""} onClick={() => onProjectTabChange(WORKFLOW_MODE_PDF)}>PDF / Image</button>
              </div>
              <div className="hd-create-folder hd-folder-page-create">
                <input
                  ref={folderInputRef}
                  value={newFolderName}
                  onChange={(event) => { onNewFolderNameChange(event.target.value); setFolderMessage(""); }}
                  onKeyDown={(event) => { if (event.key === "Enter") createFolder(); }}
                  placeholder="Name a new folder"
                  aria-label="New folder name"
                />
                <button type="button" className="hd-button hd-button-primary" onClick={createFolder}><Icon name="plus" size={17} />Create Folder</button>
                {folderMessage ? <span className="hd-folder-message" role="status">{folderMessage}</span> : null}
              </div>
            </div>
            <div className="hd-folder-grid">
              {folderCards.map((folder) => (
                <article className="hd-folder-card" key={folder.name}>
                  <button type="button" className="hd-folder-card-open" onClick={() => { onFolderFilterChange(folder.name); showPage(projectTab === WORKFLOW_MODE_PDF ? "pdf-projects" : "location-projects"); }}>
                    <span className="hd-folder-card-icon"><Icon name="folder" size={44} strokeWidth={1.45} /></span>
                    <span><strong>{folder.name}</strong><small>{folder.count} project{folder.count === 1 ? "" : "s"}</small></span>
                    <Icon name="chevron" size={18} />
                  </button>
                  {folder.name !== DEFAULT_PROJECT_FOLDER_NAME ? <div className="hd-folder-card-actions"><button type="button" onClick={() => onRenameFolder(projectTab, folder.name)}>Rename</button><button type="button" onClick={() => onDeleteFolder(projectTab, folder.name)} disabled={folder.count > 0}>Delete</button></div> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {activeNavigation === "activity" ? (
          <section className="hd-page">
            <div className="hd-page-intro hd-page-intro-row">
              <div><span className="hd-page-kicker">Shared workspace</span><h2>Project activity</h2><p>Review the latest location and PDF saves across the project library.</p></div>
              <button type="button" className="hd-button hd-button-outline" onClick={onRefreshShared} disabled={!sharedAuthenticated || sharedRefreshing}><Icon name="refresh" size={16} />{sharedRefreshing ? "Refreshing..." : "Refresh activity"}</button>
            </div>
            <div className="hd-card hd-activity-page-list">
              {recentProjects.length ? recentProjects.map((entry, index) => (
                <button type="button" className="hd-activity-page-item" key={entry.id} onClick={() => onOpenProject(entry.id)}>
                  <span><Icon name={index === 0 ? "edit" : entryMode(entry) === WORKFLOW_MODE_PDF ? "file" : "polygon"} size={22} /></span>
                  <span><strong>{entry.projectName || "Untitled Project"}</strong><small>{entryMode(entry) === WORKFLOW_MODE_PDF ? "PDF / Image plan saved" : "Location measurement saved"}</small></span>
                  <time>{formatDate(entryEditedAt(entry))}</time>
                  <Icon name="chevron" size={17} />
                </button>
              )) : <div className="hd-empty-state"><Icon name="clock" size={34} /><span>Recent project updates will appear here.</span></div>}
              {sharedQueueCount > 0 ? <div className="hd-activity-page-sync"><Icon name="refresh" /><strong>{sharedQueueCount} update{sharedQueueCount === 1 ? "" : "s"} waiting to sync</strong><button type="button" onClick={onSyncShared} disabled={sharedSyncing}>{sharedSyncing ? "Syncing..." : "Sync now"}</button></div> : null}
            </div>
          </section>
        ) : null}

        {activeNavigation === "recovery" ? (
          <section className="hd-page">
            <div className="hd-page-intro hd-page-intro-row">
              <div><span className="hd-page-kicker">Protected on this device</span><h2>Autosave Recovery Center</h2><p>Inspect the latest device snapshots, compare them with shared saves, and restore a project after a refresh, crash, or temporary network outage.</p></div>
              <div className="hd-recovery-page-actions">
                {sharedQueueCount > 0 ? <button type="button" className="hd-button hd-button-primary" onClick={onSyncShared} disabled={sharedSyncing || !sharedAuthenticated}><Icon name="upload" size={16} />{sharedSyncing ? "Syncing..." : `Sync ${sharedQueueCount} change${sharedQueueCount === 1 ? "" : "s"}`}</button> : null}
                <button type="button" className="hd-button hd-button-outline" onClick={onRefreshRecoveries} disabled={recoveryRefreshing}><Icon name="refresh" size={16} />{recoveryRefreshing ? "Checking..." : "Refresh recovery"}</button>
              </div>
            </div>

            <div className="hd-recovery-summary-grid">
              <article className={`hd-card hd-recovery-summary ${recoveryStorageState === "ready" ? "healthy" : "warning"}`}><span><Icon name="database" /></span><div><small>Device recovery</small><strong>{recoveryStorageState === "ready" ? "Protected" : recoveryStorageState === "checking" ? "Checking" : "Unavailable"}</strong></div></article>
              <article className="hd-card hd-recovery-summary"><span><Icon name="clock" /></span><div><small>Latest autosave</small><strong>{latestRecovery ? formatDate(latestRecovery.savedAt) : "None yet"}</strong></div></article>
              <article className={`hd-card hd-recovery-summary ${sharedQueueCount ? "warning" : "healthy"}`}><span><Icon name={sharedQueueCount ? "upload" : "check"} /></span><div><small>Shared queue</small><strong>{sharedQueueCount ? `${sharedQueueCount} pending` : "Up to date"}</strong></div></article>
              <article className={`hd-card hd-recovery-summary ${sharedConnectionState === "connected" ? "healthy" : "warning"}`}><span><Icon name="cloud" /></span><div><small>Shared connection</small><strong>{sharedConnectionState === "connected" ? "Connected" : sharedConnectionState === "offline" ? "Offline" : sharedConnectionState === "connecting" ? "Connecting" : "Login required"}</strong></div></article>
            </div>

            <div className="hd-card hd-recovery-list-card">
              <SectionTitle title={`Restorable Device Snapshots${recoveryRecords?.length ? ` (${recoveryRecords.length})` : ""}`} />
              <div className="hd-recovery-list">
                {recoveryRecords?.length ? recoveryRecords.map((record) => {
                  const linkedProject = recentProjects.find(
                    (entry) => String(entry?.id || "").trim() === String(record?.projectId || "").trim()
                  ) || null;
                  const health = getProjectHealth(linkedProject || record?.projectId);
                  const restoreId = `${record?.projectId || "recovery"}:${record?.savedAt || "latest"}`;
                  return (
                    <article className="hd-recovery-item" key={restoreId}>
                      <span className="hd-recovery-item-icon"><Icon name={entryMode(linkedProject || {}) === WORKFLOW_MODE_PDF ? "file" : "map"} size={24} /></span>
                      <div className="hd-recovery-item-main"><strong>{record.projectName || "Recovered Project"}</strong><small>{record.reason === "browser-autosave" ? "Browser close/refresh fallback" : "IndexedDB autosave checkpoint"}</small></div>
                      <div className="hd-recovery-item-details"><span><small>Device autosave</small><strong>{formatDate(record.savedAt)}</strong></span><span><small>Shared save</small><strong>{linkedProject && String(linkedProject.storageScope || "").toLowerCase() === "shared" ? formatDate(entryEditedAt(linkedProject)) : "Not synced"}</strong></span><span><small>Snapshot size</small><strong>{Number(record.polygonCount || 0).toLocaleString()} polygons</strong></span></div>
                      <div className="hd-recovery-item-health"><i className={`hd-project-health ${health.key}`} title={health.detail}><Icon name={health.icon} size={13} />{health.label}</i></div>
                      <button type="button" className="hd-button hd-button-primary hd-recovery-restore" onClick={() => void restoreRecovery(record)} disabled={restoringRecoveryId === restoreId}>{restoringRecoveryId === restoreId ? "Restoring..." : "Restore snapshot"}</button>
                    </article>
                  );
                }) : <div className="hd-empty-state"><Icon name="database" size={34} /><span>No recovery snapshots exist yet. While editing, the app creates a device checkpoint every 30 seconds and after polygon changes.</span></div>}
              </div>
            </div>
          </section>
        ) : null}

        {["location-projects", "pdf-projects", "all-projects"].includes(activeNavigation) ? <section className="hd-card hd-library" id="project-library">
          <div className="hd-library-toolbar">
            <div className="hd-library-heading">
              <h2>{activeNavigation === "all-projects" ? "All " : ""}{projectTab === WORKFLOW_MODE_PDF ? "PDF / Image" : "Location"} Projects</h2>
              {activeNavigation === "all-projects" ? <div className="hd-mode-tabs">
                <button type="button" className={projectTab === WORKFLOW_MODE_LOCATION ? "active" : ""} onClick={() => onProjectTabChange(WORKFLOW_MODE_LOCATION)}>Location</button>
                <button type="button" className={projectTab === WORKFLOW_MODE_PDF ? "active" : ""} onClick={() => onProjectTabChange(WORKFLOW_MODE_PDF)}>PDF / Image</button>
              </div> : null}
            </div>
            <label className="hd-search"><Icon name="search" size={16} /><input value={projectSearch} onChange={(event) => onProjectSearchChange(event.target.value)} placeholder="Search projects..." /></label>
            <select value={folderFilter} onChange={(event) => onFolderFilterChange(event.target.value)}><option value="all">All Folders</option>{folderOptions.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select>
            <button type="button" className="hd-icon-button hd-refresh" onClick={onRefreshShared} disabled={!sharedAuthenticated || sharedRefreshing} title="Refresh shared projects"><Icon name="refresh" /></button>
            <button type="button" className="hd-button hd-button-outline hd-manage-folders" onClick={showFolderTools}><Icon name="folder" size={17} />Manage Folders</button>
          </div>

          <div className="hd-project-table" role="table" aria-label="Project library">
            <div className="hd-table-header" role="row"><span>Project Name</span><span>Folder</span><span>Last Edited</span><span>Measured</span><span>Project Health</span><span>Actions</span></div>
            {groupedProjects.length === 0 ? <div className="hd-table-empty">{projectSearch.trim() ? "No projects matched your search." : sharedAuthenticated ? "No projects are in this view yet." : "No local projects are in this view. Sign in to load shared projects."}</div> : groupedProjects.map(([folderName, entries]) => {
              const collapsed = Boolean(collapsedFolders?.[`${projectTab}:${folderName}`]);
              return (
                <div className="hd-folder-group" key={folderName}>
                  <div className="hd-folder-row">
                    <button type="button" onClick={() => onToggleFolder(projectTab, folderName)}><Icon name="folder" size={26} /><strong>{folderName}</strong><span>{entries.length} project{entries.length === 1 ? "" : "s"}</span><Icon name="chevron" size={16} /></button>
                    {folderName !== DEFAULT_PROJECT_FOLDER_NAME ? <div><button type="button" onClick={() => onRenameFolder(projectTab, folderName)}>Rename</button><button type="button" onClick={() => onDeleteFolder(projectTab, folderName)} disabled={entries.length > 0}>Delete</button></div> : null}
                  </div>
                  {!collapsed ? entries.length ? entries.map((entry) => {
                    const health = getProjectHealth(entry);
                    const hasRecovery = recoveryByProjectId.has(String(entry?.id || "").trim());
                    return <div className="hd-project-row" role="row" key={entry.id}>
                      <div className="hd-project-name"><button type="button" className={`hd-star-button ${pinnedSet.has(String(entry.id || "").trim()) ? "active" : ""}`} onClick={() => onTogglePinned(entry.id)} title="Pin project"><Icon name="star" size={17} /></button><button type="button" className="hd-project-open" onClick={() => onOpenProject(entry.id)}><strong>{entry.projectName || "Untitled Project"}</strong><small>{entryMode(entry) === WORKFLOW_MODE_PDF ? "PDF / Image plan" : entry.hasBoundary ? "Boundary saved" : "Location takeoff"}</small></button></div>
                      <select value={String(entry.folderName || "").trim() || DEFAULT_PROJECT_FOLDER_NAME} onChange={(event) => onAssignFolder(entry.id, event.target.value)}>{folderOptions.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select>
                      <span data-label="Last Edited">{formatDate(entryEditedAt(entry), { short: true })}</span>
                      <strong data-label="Measured">{entryMode(entry) === WORKFLOW_MODE_PDF ? `Page ${Math.max(1, Number(entry.pdfPageNumber) || 1)}` : `${Number(entry.polygonCount || 0).toLocaleString()} polygons`}</strong>
                      <span className="hd-project-health-cell"><i className={`hd-project-health ${health.key}`} title={health.detail}><Icon name={health.icon} size={12} />{health.label}</i>{hasRecovery ? <small><Icon name="database" size={11} />Recovery ready</small> : null}</span>
                      <details className="hd-row-menu"><summary aria-label="Project actions">...</summary><div><button type="button" onClick={() => onOpenProject(entry.id)}>Open</button><button type="button" onClick={() => onTogglePinned(entry.id)}>{pinnedSet.has(String(entry.id || "").trim()) ? "Unpin" : "Pin"}</button><button type="button" className="danger" onClick={() => onRemoveProject(entry.id)}>Remove</button></div></details>
                    </div>
                  }) : <div className="hd-table-empty hd-folder-empty">No projects in this folder yet.</div> : null}
                </div>
              );
            })}
          </div>
        </section> : null}

        {activeNavigation === "admin" ? <section className="hd-admin" id="admin-tools">
          <details className="hd-card">
            <summary><span><Icon name="shield" />Security & Legal</span><Icon name="chevron" /></summary>
            <div className="hd-admin-content"><p>Authorized business use only. Shared login events and project actions are logged for accountability and security review.</p><p>Audit events follow the backend retention policy. Shared project files remain available until deleted by a logged-in user.</p>{sharedExpiresAt ? <small>Current session expires {formatDate(sharedExpiresAt)}.</small> : null}</div>
          </details>
          <details className="hd-card" onToggle={(event) => { if (event.currentTarget.open && sharedAuthenticated) onRefreshAudit(); }}>
            <summary><span><Icon name="report" />Access Audit Log</span><Icon name="chevron" /></summary>
            <div className="hd-admin-content"><button type="button" className="hd-button hd-button-outline" onClick={onRefreshAudit} disabled={!sharedAuthenticated || auditSyncing}>{auditSyncing ? "Refreshing..." : "Refresh Log"}</button>{!sharedAuthenticated ? <p>Sign in to view audit events.</p> : auditEvents.length ? <div className="hd-audit-list">{auditEvents.slice(0, 30).map((event) => <div key={event.id}><span>{formatDate(event.created_at)}</span><strong>{event.username || "unknown"}</strong><p>{event.action || "action"} · {event.outcome || "unknown"}</p></div>)}</div> : <p>No audit events yet.</p>}</div>
          </details>
        </section> : null}

        <input ref={importInputRef} hidden type="file" accept=".json,application/json" onChange={onImportProject} />
      </main>
    </div>
  );
}

export default HomeDashboard;
