import React from "react";

function StatusChip({ label, state, detail }) {
  const palette =
    state === "ready"
      ? { border: "rgba(120,255,180,0.35)", bg: "rgba(0,120,60,0.18)", text: "#cffff1" }
      : state === "checking"
      ? { border: "rgba(130,220,255,0.35)", bg: "rgba(0,100,160,0.18)", text: "#d9f5ff" }
      : { border: "rgba(255,170,96,0.35)", bg: "rgba(120,60,0,0.2)", text: "#ffd9b8" };
  return (
    <div
      style={{
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.text,
        borderRadius: 10,
        padding: "8px 9px",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 800 }}>{label}</div>
      <div style={{ fontSize: 11, opacity: 0.82, marginTop: 2 }}>{detail}</div>
    </div>
  );
}

export default function SystemStatusPanel({
  backendHealth,
  hasMaptiler,
  hasMapbox,
  hasAzure,
  hasGoogle,
  aiEnabled,
  sharedAccessAuthenticated,
  sharedProjectLibraryStatus,
  apiBaseUrl,
}) {
  return (
    <div
      style={{
        padding: 10,
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 12,
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>System Status</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <StatusChip
          label="Backend"
          state={backendHealth.state}
          detail={backendHealth.message}
        />
        <StatusChip
          label="Shared Files"
          state={sharedAccessAuthenticated ? "ready" : "warning"}
          detail={
            sharedAccessAuthenticated
              ? `Unlocked (${sharedProjectLibraryStatus})`
              : "Locked until login"
          }
        />
        <StatusChip
          label="AI / CV"
          state={aiEnabled ? "ready" : "warning"}
          detail={aiEnabled ? "Available in location mode" : "Disabled in review mode"}
        />
        <StatusChip
          label="API Route"
          state={apiBaseUrl ? "ready" : "warning"}
          detail={apiBaseUrl || "Using local fallbacks"}
        />
      </div>
      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 10, marginBottom: 6 }}>
        Map providers
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <StatusChip label="MapTiler" state={hasMaptiler ? "ready" : "warning"} detail={hasMaptiler ? "Configured" : "Missing key"} />
        <StatusChip label="Mapbox" state={hasMapbox ? "ready" : "warning"} detail={hasMapbox ? "Configured" : "Missing token"} />
        <StatusChip label="Azure" state={hasAzure ? "ready" : "warning"} detail={hasAzure ? "Configured" : "Missing key"} />
        <StatusChip label="Google" state={hasGoogle ? "ready" : "warning"} detail={hasGoogle ? "Configured" : "Missing key"} />
      </div>
    </div>
  );
}
