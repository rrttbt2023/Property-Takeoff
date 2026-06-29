import React from "react";

export default function WorkflowSummaryCard({
  workflowMode,
  workflowModeLocation,
  workflowModePdf,
  openMeasurementScreen,
  setShowWorkflowPicker,
  saveStatusLabel,
}) {
  const isPdf = workflowMode === workflowModePdf;

  return (
    <div
      style={{
        padding: 10,
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 12,
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Workflow</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button
          type="button"
          onClick={() => openMeasurementScreen(workflowModeLocation)}
          style={{
            padding: "9px 10px",
            borderRadius: 10,
            cursor: "pointer",
            border: !isPdf
              ? "1px solid rgba(130, 220, 255, 0.8)"
              : "1px solid rgba(255,255,255,0.12)",
            background: !isPdf ? "rgba(0, 140, 255, 0.2)" : "rgba(255,255,255,0.06)",
            color: "#fff",
            fontWeight: 700,
            fontSize: 12,
          }}
        >
          Measure Location
        </button>
        <button
          type="button"
          onClick={() => openMeasurementScreen(workflowModePdf)}
          style={{
            padding: "9px 10px",
            borderRadius: 10,
            cursor: "pointer",
            border: isPdf
              ? "1px solid rgba(130, 220, 255, 0.8)"
              : "1px solid rgba(255,255,255,0.12)",
            background: isPdf ? "rgba(0, 140, 255, 0.2)" : "rgba(255,255,255,0.06)",
            color: "#fff",
            fontWeight: 700,
            fontSize: 12,
          }}
        >
          Measure PDF/Image
        </button>
      </div>
      <div style={{ fontSize: 12, opacity: 0.74, marginTop: 8, lineHeight: 1.35 }}>
        {isPdf
          ? "PDF/Image workspace is file-only. Upload a PDF or image, calibrate scale, then annotate directly on the page."
          : "Location workspace is map-first. Load a KML/KMZ boundary or look up the property before measuring."}
      </div>
      <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>
        Current page: {isPdf ? "PDF/Image Measuring Page" : "Location Measuring Page"}
      </div>
      <div style={{ fontSize: 12, opacity: 0.74, marginTop: 4 }}>
        Save status:{" "}
        <span style={{ color: "#d9fdbf", fontWeight: 700 }}>{saveStatusLabel}</span>
      </div>
      <button
        type="button"
        onClick={() => setShowWorkflowPicker(true)}
        style={{
          marginTop: 8,
          width: "100%",
          padding: "8px 10px",
          borderRadius: 10,
          cursor: "pointer",
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(255,255,255,0.05)",
          color: "#fff",
          fontWeight: 700,
          fontSize: 12,
        }}
      >
        Open Page Picker
      </button>
    </div>
  );
}
