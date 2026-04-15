export function exportTotalsCSV(totals) {
  const rows = [["Layer", "SqFt", "Acres"]];
  for (const [k, v] of Object.entries(totals)) {
    rows.push([k, v.sqft, v.acres]);
  }
  const csv = rows.map((r) => r.join(",")).join("\n");
  downloadBlob(csv, "text/csv", "takeoff_totals.csv");
}

export async function exportLayersKML(features) {
  const tokmlModule = await import("tokml");
  const tokml = tokmlModule?.default || tokmlModule;
  const fc = { type: "FeatureCollection", features };
  const kmlText = tokml(fc);
  downloadBlob(kmlText, "application/vnd.google-earth.kml+xml", "takeoff_layers.kml");
}

export async function exportPDF(map, totals) {
  if (!map) return;
  const jsPdfModule = await import("jspdf");
  const jsPDF = jsPdfModule?.default || jsPdfModule;

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const dataUrl = map.getCanvas().toDataURL("image/png");

  doc.text("Property Takeoff", 40, 40);
  doc.addImage(dataUrl, "PNG", 40, 60, 720, 405);

  let y = 500;
  doc.text("Totals:", 40, y);
  y += 18;

  for (const [k, v] of Object.entries(totals)) {
    doc.text(`${k}: ${v.sqft.toLocaleString()} sq ft (${v.acres.toFixed(2)} ac)`, 40, y);
    y += 16;
  }

  doc.save("takeoff_report.pdf");
}

function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
export function exportProjectJSON(project) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `takeoff-project-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importProjectJSON(file) {
  const text = await file.text();
  return JSON.parse(text);
}
export function exportPolygonsCSV(rows) {
  // rows = [{ layer, name, sqft, acres, id }]
  const header = ["Layer", "Name", "SqFt", "Acres", "FeatureId"];
  const lines = [header.join(",")];

  for (const r of rows) {
    const line = [
      csvEscape(r.layer),
      csvEscape(r.name),
      r.sqft,
      r.acres,
      csvEscape(r.id),
    ].join(",");
    lines.push(line);
  }

  const csv = lines.join("\n");
  downloadBlob(csv, "text/csv", "takeoff_polygons.csv");
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}
