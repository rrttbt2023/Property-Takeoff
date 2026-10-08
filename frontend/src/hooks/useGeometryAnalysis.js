import { useEffect, useRef, useState } from "react";

const EMPTY_ANALYSIS = {
  totals: {
    plowable: { sqft: 0, acres: 0 },
    sidewalks: { sqft: 0, acres: 0 },
    turf: { sqft: 0, acres: 0 },
    mulch: { sqft: 0, acres: 0 },
  },
  polygonRows: [],
  qcSummary: {
    polygons: 0,
    overlaps: 0,
    overlapSqft: 0,
    outside: 0,
    tiny: 0,
    invalidArea: 0,
    overlapScanDeferred: false,
    overlapScanThreshold: 180,
  },
};

export default function useGeometryAnalysis({
  layerFeatures,
  boundary,
  overlapScanNonce = 0,
}) {
  const [analysis, setAnalysis] = useState(EMPTY_ANALYSIS);
  const workerRef = useRef(null);
  const requestRef = useRef(0);
  const lastForcedOverlapNonceRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/geometry.worker.js", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (Number(message.requestId) !== requestRef.current) return;
      if (message.ok && message.analysis) {
        setAnalysis(message.analysis);
      }
    };
    return () => {
      workerRef.current = null;
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const normalizedNonce = Math.max(0, Number(overlapScanNonce) || 0);
    const forceOverlapScan =
      normalizedNonce > 0 && normalizedNonce !== lastForcedOverlapNonceRef.current;
    if (forceOverlapScan) lastForcedOverlapNonceRef.current = normalizedNonce;
    worker.postMessage({
      requestId,
      layerFeatures,
      boundary,
      forceOverlapScan,
    });
  }, [boundary, layerFeatures, overlapScanNonce]);

  return analysis;
}
