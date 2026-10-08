import React from "react";

export default function CvWorkflowPanel({
  workflowMode,
  workflowModePdf,
  aiEnabled,
  measurementImageFile,
  boundary,
  pdfConverting,
  segmentingImage,
  trainingExporting,
  segmentationResult,
  segmentationStatus,
  showCvUncertainty,
  setShowCvUncertainty,
  backendMeasurementResult,
  measurementHistory,
  activeLearningQueue,
  activeLayer,
  setActiveLayer,
  cycleActiveLayer,
  refreshMeasurementHistory,
  runBackendMeasurement,
  autoMeasureExperimental,
  capturingMapImage,
  backendSubmitting,
  autoMeasuring,
  runSegmentationMeasurement,
  markCvPredictionWrongAndExport,
  selectedReviewLayer,
  setSelectedReviewLayer,
  layerKeys,
  layerMeta,
  layerFeatures,
}) {
  const isPdf = workflowMode === workflowModePdf;
  const canRunCv = aiEnabled && !pdfConverting && !segmentingImage && (!!measurementImageFile || !!boundary);
  const selectedLayerPolygons = Array.isArray(layerFeatures?.[selectedReviewLayer])
    ? layerFeatures[selectedReviewLayer].length
    : 0;
  const selectedConfidence = segmentationResult?.[selectedReviewLayer]?.confidence;
  const diagnostics = segmentationResult?.diagnostics || segmentationStatus || {};
  const engineLabel = String(diagnostics.engine || "unknown").replaceAll("-", " ");
  const trainedOutputActive = String(diagnostics.engine || "").startsWith("torchscript");
  const modelStatusLabel = trainedOutputActive
    ? diagnostics.engine === "torchscript-ready"
      ? "Trained model ready"
      : "Trained model active"
    : diagnostics.model_loaded
      ? "Model ready; fallback used"
      : "Heuristic fallback";
  const uncertaintyPct = Math.round(
    Math.max(0, Math.min(1, Number(diagnostics.uncertain_fraction || 0))) * 100
  );
  const uncertaintyRegionCount = Array.isArray(segmentationResult?.uncertain_polygons)
    ? segmentationResult.uncertain_polygons.length
    : 0;

  return (
    <div
      style={{
        padding: 10,
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 12,
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
        AI / CV Review
      </div>

      {isPdf ? (
        <div style={{ fontSize: 12, opacity: 0.78, lineHeight: 1.35 }}>
          PDF mode is manual-only. Switch to `Measure Location` to use AI measurement or CV segmentation.
        </div>
      ) : (
        <>
          <div
            style={{
              padding: 9,
              borderRadius: 10,
              border: trainedOutputActive
                ? "1px solid rgba(120,220,150,0.30)"
                : "1px solid rgba(255,190,105,0.34)",
              background: trainedOutputActive
                ? "rgba(38,145,76,0.12)"
                : "rgba(180,110,30,0.12)",
              marginBottom: 8,
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ textTransform: "capitalize" }}>{engineLabel}</strong>
              <span>{modelStatusLabel}</span>
            </div>
            <div style={{ opacity: 0.78, marginTop: 3 }}>
              Model: {diagnostics.model_version || "not loaded"}
              {Number(diagnostics.tile_count || 0) > 0
                ? ` • ${diagnostics.tile_count} tile${diagnostics.tile_count === 1 ? "" : "s"}`
                : ""}
              {diagnostics.tiled_inference
                ? ` • ${diagnostics.tile_size}px / ${diagnostics.tile_overlap}px overlap`
                : ""}
            </div>
            {diagnostics.model_error ? (
              <div style={{ color: "#ffd39d", marginTop: 3 }}>
                {String(diagnostics.model_error).slice(0, 180)}
              </div>
            ) : null}
            {segmentationResult ? (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  marginTop: 7,
                  cursor: uncertaintyRegionCount ? "pointer" : "default",
                  opacity: uncertaintyRegionCount ? 1 : 0.65,
                }}
              >
                <input
                  type="checkbox"
                  checked={!!showCvUncertainty}
                  onChange={(event) => setShowCvUncertainty(event.target.checked)}
                  disabled={!uncertaintyRegionCount}
                />
                Show low-confidence review areas ({uncertaintyPct}% of image, {uncertaintyRegionCount} regions)
              </label>
            ) : null}
          </div>

          <div
            style={{
              padding: 8,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.03)",
              marginBottom: 8,
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.82, marginBottom: 6 }}>
              Review class
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
              {layerKeys.map((key) => (
                <button
                  key={`review-layer-${key}`}
                  type="button"
                  onClick={() => setSelectedReviewLayer(key)}
                  style={{
                    padding: "8px 9px",
                    borderRadius: 10,
                    cursor: "pointer",
                    border:
                      selectedReviewLayer === key
                        ? "1px solid rgba(130,220,255,0.8)"
                        : "1px solid rgba(255,255,255,0.12)",
                    background:
                      selectedReviewLayer === key
                        ? "rgba(0,140,255,0.2)"
                        : "rgba(255,255,255,0.05)",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  {layerMeta[key].name}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, opacity: 0.78, lineHeight: 1.35 }}>
              Selected: <strong>{layerMeta[selectedReviewLayer].name}</strong>
              {" "}• Current polygons: {selectedLayerPolygons}
              {" "}• Last confidence:{" "}
              {Number.isFinite(selectedConfidence) ? `${Math.round(selectedConfidence * 100)}%` : "n/a"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 8 }}>
              <button
                type="button"
                onClick={() => runSegmentationMeasurement([selectedReviewLayer])}
                disabled={!canRunCv}
                style={{
                  padding: "8px 9px",
                  borderRadius: 10,
                  cursor: canRunCv ? "pointer" : "not-allowed",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: canRunCv ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.03)",
                  color: "#fff",
                  opacity: canRunCv ? 1 : 0.6,
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {segmentingImage ? "Running..." : "Run Selected"}
              </button>
              <button
                type="button"
                onClick={() => setActiveLayer(selectedReviewLayer)}
                disabled={activeLayer === selectedReviewLayer}
                style={{
                  padding: "8px 9px",
                  borderRadius: 10,
                  cursor: activeLayer === selectedReviewLayer ? "not-allowed" : "pointer",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background:
                    activeLayer === selectedReviewLayer
                      ? "rgba(255,255,255,0.03)"
                      : "rgba(255,255,255,0.05)",
                  color: "#fff",
                  opacity: activeLayer === selectedReviewLayer ? 0.6 : 1,
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {activeLayer === selectedReviewLayer ? "Active Layer" : "Edit Selected"}
              </button>
              <button
                type="button"
                onClick={cycleActiveLayer}
                style={{
                  padding: "8px 9px",
                  borderRadius: 10,
                  cursor: "pointer",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.05)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                Next Layer
              </button>
            </div>
          </div>

          <button
            onClick={boundary ? autoMeasureExperimental : runBackendMeasurement}
            disabled={boundary ? autoMeasuring || pdfConverting : backendSubmitting || capturingMapImage || pdfConverting}
            style={{
              width: "100%",
              padding: "9px 10px",
              borderRadius: 12,
              cursor:
                boundary
                  ? autoMeasuring || pdfConverting
                    ? "not-allowed"
                    : "pointer"
                  : backendSubmitting || capturingMapImage || pdfConverting
                  ? "not-allowed"
                  : "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background:
                boundary
                  ? autoMeasuring || pdfConverting
                    ? "rgba(255,255,255,0.03)"
                    : "rgba(255,255,255,0.06)"
                  : backendSubmitting || capturingMapImage || pdfConverting
                  ? "rgba(255,255,255,0.03)"
                  : "rgba(255,255,255,0.06)",
              color: "#fff",
              opacity:
                boundary
                  ? autoMeasuring || pdfConverting
                    ? 0.6
                    : 1
                  : backendSubmitting || capturingMapImage || pdfConverting
                  ? 0.6
                  : 1,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            {boundary
              ? autoMeasuring
                ? "Running AI Takeoff..."
                : pdfConverting
                ? "Converting PDF..."
                : "Run AI Takeoff (Stable)"
              : capturingMapImage
              ? "Capturing Property View..."
              : pdfConverting
              ? "Converting PDF..."
              : backendSubmitting
              ? "Running Measurement..."
              : "Run AI Measurement"}
          </button>

          <button
            onClick={() => runSegmentationMeasurement()}
            disabled={!canRunCv}
            style={{
              width: "100%",
              padding: "9px 10px",
              borderRadius: 12,
              cursor: canRunCv ? "pointer" : "not-allowed",
              border: "1px solid rgba(255,255,255,0.12)",
              background: canRunCv ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
              color: "#fff",
              opacity: canRunCv ? 1 : 0.6,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            {pdfConverting ? "Converting PDF..." : segmentingImage ? "Running Segmentation..." : "Run CV Segmentation (All Classes)"}
          </button>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
            {layerKeys.map((key) => (
              <button
                key={`seg-class-${key}`}
                onClick={() => runSegmentationMeasurement([key])}
                disabled={!canRunCv}
                style={{
                  padding: "8px 9px",
                  borderRadius: 10,
                  cursor: canRunCv ? "pointer" : "not-allowed",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: canRunCv ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.03)",
                  color: "#fff",
                  opacity: canRunCv ? 1 : 0.6,
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {pdfConverting ? "Converting..." : segmentingImage ? "Running..." : `CV ${layerMeta[key].name}`}
              </button>
            ))}
          </div>

          <button
            onClick={refreshMeasurementHistory}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.05)",
              color: "#fff",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Refresh Measurement History
          </button>

          {backendMeasurementResult ? (
            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4, marginBottom: 8 }}>
              <div>Area: {backendMeasurementResult.total_area_sqft.toFixed(2)} sqft</div>
              <div>Length: {backendMeasurementResult.total_length_ft.toFixed(2)} ft</div>
              <div>Confidence: {(backendMeasurementResult.confidence * 100).toFixed(0)}%</div>
              {backendMeasurementResult.notes?.slice(0, 2).map((note, idx) => (
                <div key={`note-${idx}`}>- {note}</div>
              ))}
            </div>
          ) : null}

          {segmentationResult ? (
            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4, marginBottom: 8 }}>
              <div>
                Segmentation confidence:{" "}
                P {Math.round((segmentationResult.plowable?.confidence || 0) * 100)}%{" "}
                S {Math.round((segmentationResult.sidewalks?.confidence || 0) * 100)}%{" "}
                T {Math.round((segmentationResult.turf?.confidence || 0) * 100)}%{" "}
                M {Math.round((segmentationResult.mulch?.confidence || 0) * 100)}%
              </div>
              {(segmentationResult.notes || []).slice(0, 4).map((note, idx) => (
                <div key={`seg-note-${idx}`}>- {note}</div>
              ))}
              <button
                type="button"
                onClick={markCvPredictionWrongAndExport}
                disabled={trainingExporting}
                style={{
                  marginTop: 8,
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 10,
                  cursor: trainingExporting ? "not-allowed" : "pointer",
                  border: "1px solid rgba(255,170,96,0.55)",
                  background: "rgba(210,120,40,0.22)",
                  color: "#fff",
                  opacity: trainingExporting ? 0.6 : 1,
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {trainingExporting
                  ? "Saving Correction..."
                  : "Save Corrected Polygons for Training"}
              </button>
            </div>
          ) : null}

          <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
            {boundary?.geometry
              ? "KML boundary loaded: measuring directly from property geometry. "
              : !measurementImageFile
              ? "Using current map view screenshot. "
              : ""}
            {measurementHistory.length > 0
              ? `Recent jobs: ${measurementHistory
                  .slice(0, 3)
                  .map((item) => `#${item.id} ${item.measurement_type}`)
                  .join(" • ")}`
              : "No backend history yet."}
          </div>
        </>
      )}

      {aiEnabled ? (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px dashed rgba(255,255,255,0.10)",
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            Active Learning Queue
          </div>
          {!activeLearningQueue.length ? (
            <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
              No recent backend jobs yet. Run AI/CV jobs, correct polygons, then export training samples.
            </div>
          ) : (
            activeLearningQueue.map((item) => {
              const confidencePct = Math.round(
                Math.max(0, Math.min(1, Number(item.confidence || 0))) * 100
              );
              return (
                <div
                  key={`alq-${item.id || item.measurementType}-${confidencePct}`}
                  style={{
                    padding: "7px 0",
                    borderBottom: "1px dashed rgba(255,255,255,0.10)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ opacity: 0.92 }}>
                      #{item.id ?? "?"} {item.measurementType || "job"}
                    </span>
                    <span style={{ opacity: 0.85 }}>Conf: {confidencePct}%</span>
                  </div>
                  {item.notes?.length ? (
                    <div style={{ opacity: 0.66, marginTop: 2 }}>{String(item.notes[0])}</div>
                  ) : null}
                </div>
              );
            })
          )}
          <div style={{ fontSize: 12, opacity: 0.72, marginTop: 8, lineHeight: 1.35 }}>
            Focus labeling on low-confidence jobs first. Review one class at a time before exporting corrections.
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>
          Review mode is active. AI measurement and CV segmentation are disabled in this build.
        </div>
      )}
    </div>
  );
}
