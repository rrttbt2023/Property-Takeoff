export function safeFilenamePart(value, fallback) {
  const cleaned = Array.from(String(value ?? "").trim())
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code >= 0 && code <= 31) return "-";
      return /[<>:"/\\|?*]/.test(char) ? "-" : char;
    })
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

export function exportTotalsCSV(totals, projectName) {
  const rows = [["Layer", "SqFt", "Acres"]];
  for (const [k, v] of Object.entries(totals)) {
    rows.push([k, v.sqft, v.acres]);
  }
  const csv = rows.map((r) => r.join(",")).join("\n");
  const baseProject = safeFilenamePart(projectName, "takeoff-project");
  downloadBlob(csv, "text/csv", `${baseProject}.csv`);
}

const KML_LAYER_STYLE_MAP = {
  plowable: {
    folderName: "Plowable",
    line: "#0088ff",
    fill: "#00ffff",
  },
  sidewalks: {
    folderName: "Sidewalks",
    line: "#ffaa00",
    fill: "#ffff00",
  },
  turf: {
    folderName: "Turf",
    line: "#00cc00",
    fill: "#00ff00",
  },
  mulch: {
    folderName: "Mulch",
    line: "#ff5500",
    fill: "#ff6600",
  },
};

function hexToKmlColor(hex, alpha = 1) {
  const normalized = String(hex || "")
    .trim()
    .replace(/^#/, "");
  const sixChar =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized.padStart(6, "0").slice(0, 6);
  const rr = sixChar.slice(0, 2);
  const gg = sixChar.slice(2, 4);
  const bb = sixChar.slice(4, 6);
  const aa = Math.max(0, Math.min(255, Math.round((Number(alpha) || 0) * 255)))
    .toString(16)
    .padStart(2, "0");
  return `${aa}${bb}${gg}${rr}`;
}

function formatKmlCoord(point) {
  if (!Array.isArray(point) || point.length < 2) return "";
  const lng = Number(point[0]);
  const lat = Number(point[1]);
  const alt = Number.isFinite(Number(point[2])) ? Number(point[2]) : 0;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return "";
  return `${lng.toFixed(6)},${lat.toFixed(6)},${alt.toFixed(2)}`;
}

function buildKmlCoordBlock(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point) => formatKmlCoord(point))
    .filter(Boolean)
    .join(" ");
}

function closeRing(points = []) {
  const ring = (Array.isArray(points) ? points : []).filter(
    (point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(Number(point[0])) &&
      Number.isFinite(Number(point[1]))
  );
  if (!ring.length) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Number(first[0]) === Number(last[0]) && Number(first[1]) === Number(last[1])) {
    return ring;
  }
  return [...ring, first];
}

function buildKmlPolygonGeometry(coordinates = []) {
  const rings = Array.isArray(coordinates) ? coordinates : [];
  const outer = closeRing(rings[0] || []);
  if (outer.length < 4) return "";
  const innerRings = rings
    .slice(1)
    .map((ring) => closeRing(ring))
    .filter((ring) => ring.length >= 4);
  return `<Polygon>
    <tessellate>1</tessellate>
    <outerBoundaryIs><LinearRing><coordinates>${buildKmlCoordBlock(outer)}</coordinates></LinearRing></outerBoundaryIs>
    ${innerRings
      .map(
        (ring) =>
          `<innerBoundaryIs><LinearRing><coordinates>${buildKmlCoordBlock(
            ring
          )}</coordinates></LinearRing></innerBoundaryIs>`
      )
      .join("")}
  </Polygon>`;
}

function buildKmlGeometry(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return "";
  if (geometry.type === "Polygon") {
    return buildKmlPolygonGeometry(geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = (Array.isArray(geometry.coordinates) ? geometry.coordinates : [])
      .map((polygon) => buildKmlPolygonGeometry(polygon))
      .filter(Boolean);
    if (!polygons.length) return "";
    return `<MultiGeometry>${polygons.join("")}</MultiGeometry>`;
  }
  if (geometry.type === "LineString") {
    const coords = buildKmlCoordBlock(geometry.coordinates);
    return coords
      ? `<LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`
      : "";
  }
  if (geometry.type === "Point") {
    const coord = formatKmlCoord(geometry.coordinates);
    return coord ? `<Point><coordinates>${coord}</coordinates></Point>` : "";
  }
  return "";
}

function buildKmlPlacemark(feature, fallbackName = "Feature") {
  const props = feature?.properties || {};
  const geometryMarkup = buildKmlGeometry(feature);
  if (!geometryMarkup) return "";
  const name = String(props.name || props.label || fallbackName).trim() || fallbackName;
  const layerKey = String(props.layer || "").trim().toLowerCase();
  const styleUrl = KML_LAYER_STYLE_MAP[layerKey] ? `#style-${layerKey}` : "#style-default";
  return `<Placemark>
    <name>${escapeXml(name)}</name>
    <styleUrl>${styleUrl}</styleUrl>
    ${geometryMarkup}
  </Placemark>`;
}

function buildKmlStyles() {
  const styleEntries = Object.entries(KML_LAYER_STYLE_MAP).map(([layerKey, style]) => {
    return `<Style id="style-${layerKey}">
      <LineStyle>
        <color>${hexToKmlColor(style.line, 1)}</color>
        <width>4</width>
      </LineStyle>
      <PolyStyle>
        <color>${hexToKmlColor(style.fill, 0)}</color>
        <fill>0</fill>
        <outline>1</outline>
      </PolyStyle>
    </Style>`;
  });
  styleEntries.push(`<Style id="style-default">
    <LineStyle><color>${hexToKmlColor("#ffffff", 1)}</color><width>4</width></LineStyle>
    <PolyStyle><color>${hexToKmlColor("#cccccc", 0)}</color><fill>0</fill><outline>1</outline></PolyStyle>
  </Style>`);
  return styleEntries.join("");
}

function buildStyledKml(features = [], projectName = "") {
  const grouped = new Map();
  for (const [layerKey, style] of Object.entries(KML_LAYER_STYLE_MAP)) {
    grouped.set(layerKey, {
      folderName: style.folderName,
      items: [],
    });
  }
  const uncategorized = {
    folderName: "Other",
    items: [],
  };
  for (const feature of Array.isArray(features) ? features : []) {
    const layerKey = String(feature?.properties?.layer || "").trim().toLowerCase();
    if (grouped.has(layerKey)) {
      grouped.get(layerKey).items.push(feature);
    } else {
      uncategorized.items.push(feature);
    }
  }
  const folders = [];
  for (const [, group] of grouped) {
    if (!group.items.length) continue;
    folders.push(`<Folder>
      <name>${escapeXml(group.folderName)}</name>
      ${group.items
        .map((feature, idx) => buildKmlPlacemark(feature, `${group.folderName} ${idx + 1}`))
        .join("")}
    </Folder>`);
  }
  if (uncategorized.items.length) {
    folders.push(`<Folder>
      <name>${escapeXml(uncategorized.folderName)}</name>
      ${uncategorized.items
        .map((feature, idx) => buildKmlPlacemark(feature, `Feature ${idx + 1}`))
        .join("")}
    </Folder>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(String(projectName || "takeoff-project"))}</name>
    ${buildKmlStyles()}
    ${folders.join("")}
  </Document>
</kml>`;
}

export async function exportLayersKML(features, projectName) {
  const kmlText = buildStyledKml(features, projectName);
  const baseProject = safeFilenamePart(projectName, "takeoff-project");
  downloadBlob(kmlText, "application/vnd.google-earth.kml+xml", `${baseProject}.kml`);
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

function canvasToBlob(canvas, mimeType = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Could not prepare image export."));
    }, mimeType);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image for PDF export."));
    image.src = url;
  });
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSvgNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return String(Number(num.toFixed(3)));
}

function pointsToSvgString(points) {
  return (Array.isArray(points) ? points : [])
    .filter(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(Number(point[0])) &&
        Number.isFinite(Number(point[1]))
    )
    .map((point) => `${formatSvgNumber(point[0])},${formatSvgNumber(point[1])}`)
    .join(" ");
}

function measurementPointsToSvgString(points) {
  return (Array.isArray(points) ? points : [])
    .map((point) => {
      const x = Number.isFinite(Number(point?.x)) ? Number(point.x) : Number(point?.[0]);
      const y = Number.isFinite(Number(point?.y)) ? Number(point.y) : Number(point?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return `${formatSvgNumber(x)},${formatSvgNumber(y)}`;
    })
    .filter(Boolean)
    .join(" ");
}

async function imageUrlToDataUrl(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error("Could not load image for export.");
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not prepare image for export."));
    reader.readAsDataURL(blob);
  });
}

function getArrowHeadPoints(points, size = 16) {
  const coords = Array.isArray(points) ? points : [];
  if (coords.length < 2) return [];
  const tip = coords[coords.length - 1];
  let base = coords[coords.length - 2];
  for (let idx = coords.length - 2; idx >= 0; idx -= 1) {
    const candidate = coords[idx];
    if (
      Array.isArray(candidate) &&
      candidate.length >= 2 &&
      Number.isFinite(Number(candidate[0])) &&
      Number.isFinite(Number(candidate[1])) &&
      (Number(candidate[0]) !== Number(tip?.[0]) || Number(candidate[1]) !== Number(tip?.[1]))
    ) {
      base = candidate;
      break;
    }
  }
  const tx = Number(tip?.[0]);
  const ty = Number(tip?.[1]);
  const bx = Number(base?.[0]);
  const by = Number(base?.[1]);
  if (![tx, ty, bx, by].every(Number.isFinite)) return [];
  const dx = tx - bx;
  const dy = ty - by;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 0.001) return [];
  const ux = dx / length;
  const uy = dy / length;
  const headLength = Math.max(8, Number(size) || 16);
  const headWidth = Math.max(5, headLength * 0.52);
  const backX = tx - ux * headLength;
  const backY = ty - uy * headLength;
  const perpX = -uy;
  const perpY = ux;
  return [
    [tx, ty],
    [backX + perpX * headWidth, backY + perpY * headWidth],
    [backX - perpX * headWidth, backY - perpY * headWidth],
  ];
}

function getCalloutTextBounds(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 1) return null;
  const anchor = coordinates[0];
  if (!Array.isArray(anchor) || anchor.length < 2) return null;
  const x = Number(anchor[0]);
  const y = Number(anchor[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const label = String(feature?.properties?.label || "").trim();
  const textSize = Math.max(10, Math.min(72, Number(feature?.properties?.textSize) || 15));
  const boxWidth = Math.max(textSize * 2.2, label.length * textSize * 0.56 + 22);
  const boxHeight = Math.max(textSize * 1.9, 28);
  const tip = Array.isArray(coordinates[coordinates.length - 1])
    ? coordinates[coordinates.length - 1]
    : null;
  const tipX = Number(tip?.[0]);
  const alignLeft = !Number.isFinite(tipX) || tipX >= x;
  const minX = alignLeft ? x + 10 : x - boxWidth - 10;
  const minY = y - boxHeight * 0.5;
  return {
    minX,
    minY,
    boxWidth,
    boxHeight,
    textX: minX + 10,
    textY: minY + boxHeight * 0.66,
  };
}

function getPdfStrokeTextureStyle(kind) {
  const normalizedKind = String(kind || "").toLowerCase();
  if (normalizedKind === "pen") {
    return {
      textureDash: [1.4, 3.6],
      textureOpacityScale: 0.2,
      textureWidthScale: 0.34,
      edgeOpacityScale: 0.26,
      edgeWidthScale: 1.16,
      overlayBlend: "source-over",
    };
  }
  if (normalizedKind === "pencil") {
    return {
      textureDash: [0.65, 3.4],
      textureOpacityScale: 0.5,
      textureWidthScale: 0.42,
      edgeOpacityScale: 0.18,
      edgeWidthScale: 1.22,
      overlayBlend: "source-over",
    };
  }
  if (normalizedKind === "crayon") {
    return {
      textureDash: [2.1, 3.1],
      textureOpacityScale: 0.4,
      textureWidthScale: 0.58,
      edgeOpacityScale: 0.14,
      edgeWidthScale: 1.32,
      overlayBlend: "source-over",
    };
  }
  if (normalizedKind === "marker") {
    return {
      textureDash: [5.5, 3.8],
      textureOpacityScale: 0.12,
      textureWidthScale: 0.72,
      edgeOpacityScale: 0.22,
      edgeWidthScale: 1.08,
      overlayBlend: "source-over",
    };
  }
  return {
    textureDash: [],
    textureOpacityScale: 0,
    textureWidthScale: 0,
    edgeOpacityScale: 0,
    edgeWidthScale: 0,
    overlayBlend: "source-over",
  };
}

function buildSvgStrokeMarkup(points, feature) {
  const kind = String(feature?.properties?.kind || "").toLowerCase();
  const color = String(feature?.properties?.color || "#ff4d00");
  const strokeScale = Math.max(0.5, Number(feature?.__exportStrokeScale) || 1);
  const width = Math.max(1, (Number(feature?.properties?.width) || 2) * strokeScale);
  const opacity = Math.max(0.05, Math.min(1, Number(feature?.properties?.opacity) || 1));
  const textureStyle = getPdfStrokeTextureStyle(kind);
  const strokeCap = kind === "marker" ? "square" : "round";
  const pointsAttr = pointsToSvgString(points);
  if (!pointsAttr) return "";
  const segments = [];
  if (textureStyle.edgeWidthScale > 0) {
    segments.push(
      `<polyline points="${pointsAttr}" fill="none" stroke="${escapeXml(color)}" stroke-width="${formatSvgNumber(
        Math.max(1, width * textureStyle.edgeWidthScale)
      )}" stroke-opacity="${formatSvgNumber(
        Math.max(0.06, opacity * textureStyle.edgeOpacityScale)
      )}" stroke-linecap="${strokeCap}" stroke-linejoin="round" />`
    );
  }
  segments.push(
    `<polyline points="${pointsAttr}" fill="none" stroke="${escapeXml(color)}" stroke-width="${formatSvgNumber(
      width
    )}" stroke-opacity="${formatSvgNumber(opacity)}" stroke-linecap="${strokeCap}" stroke-linejoin="round" />`
  );
  if (textureStyle.textureDash.length) {
    segments.push(
      `<polyline points="${pointsAttr}" fill="none" stroke="${escapeXml(color)}" stroke-width="${formatSvgNumber(
        Math.max(1, width * textureStyle.textureWidthScale)
      )}" stroke-opacity="${formatSvgNumber(
        Math.max(0.08, opacity * textureStyle.textureOpacityScale)
      )}" stroke-linecap="${strokeCap}" stroke-linejoin="round" stroke-dasharray="${textureStyle.textureDash
        .map(formatSvgNumber)
        .join(" ")}" />`
    );
  }
  if (kind === "arrow" || kind === "callout") {
    const arrowHead = getArrowHeadPoints(points, Math.max(10, width * 2.1));
    if (arrowHead.length === 3) {
      segments.push(
        `<polygon points="${pointsToSvgString(arrowHead)}" fill="${escapeXml(
          color
        )}" fill-opacity="${formatSvgNumber(Math.max(0.12, opacity))}" stroke="${escapeXml(
          color
        )}" stroke-opacity="${formatSvgNumber(Math.max(0.24, opacity))}" stroke-width="${formatSvgNumber(
          Math.max(1, width * 0.18)
        )}" />`
      );
    }
  }
  return segments.join("");
}

function buildSvgPolygonMarkup(points, feature) {
  const stroke = String(feature?.properties?.color || "#ff4d00");
  const fill = String(feature?.properties?.fillColor || stroke);
  const strokeScale = Math.max(0.5, Number(feature?.__exportStrokeScale) || 1);
  const width = Math.max(1, (Number(feature?.properties?.width) || 2) * strokeScale);
  const opacity = Math.max(0.05, Math.min(1, Number(feature?.properties?.opacity) || 1));
  const fillOpacity = Math.max(
    0.01,
    Math.min(1, Number(feature?.properties?.fillOpacity) || 0.16)
  );
  const pointsAttr = pointsToSvgString(points);
  if (!pointsAttr) return "";
  return `<polygon points="${pointsAttr}" fill="${escapeXml(fill)}" fill-opacity="${formatSvgNumber(
    fillOpacity
  )}" stroke="${escapeXml(stroke)}" stroke-width="${formatSvgNumber(width)}" stroke-opacity="${formatSvgNumber(
    opacity
  )}" stroke-linejoin="round" stroke-linecap="round" />`;
}

function buildSvgTextMarkup(feature) {
  const [x, y] = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates
    : [null, null];
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return "";
  const label = String(feature?.properties?.label || "");
  if (!label.trim()) return "";
  const color = String(feature?.properties?.color || "#ff4d00");
  const strokeScale = Math.max(0.5, Number(feature?.__exportStrokeScale) || 1);
  const fontSize = Math.max(
    10,
    Math.min(72 * strokeScale, (Number(feature?.properties?.textSize) || 15) * strokeScale)
  );
  return `<text x="${formatSvgNumber(x)}" y="${formatSvgNumber(
    Number(y) + fontSize
  )}" font-size="${formatSvgNumber(fontSize)}" font-weight="700" fill="${escapeXml(
    color
  )}" style="paint-order:stroke;stroke:rgba(0,0,0,0.42);stroke-width:1.25">${escapeXml(
    label
  )}</text>`;
}

function buildSvgCalloutMarkup(feature) {
  const bounds = getCalloutTextBounds(feature);
  if (!bounds) return "";
  const color = String(feature?.properties?.color || "#ff4d00");
  const label = String(feature?.properties?.label || "");
  const strokeScale = Math.max(0.5, Number(feature?.__exportStrokeScale) || 1);
  const textSize = Math.max(
    10,
    Math.min(72 * strokeScale, (Number(feature?.properties?.textSize) || 15) * strokeScale)
  );
  const opacity = Math.max(0.28, Number(feature?.properties?.opacity) || 1);
  return `<g>
    <rect x="${formatSvgNumber(bounds.minX)}" y="${formatSvgNumber(
      bounds.minY
    )}" width="${formatSvgNumber(bounds.boxWidth * strokeScale)}" height="${formatSvgNumber(
    bounds.boxHeight * strokeScale
  )}" rx="${formatSvgNumber(8 * strokeScale)}" ry="${formatSvgNumber(
    8 * strokeScale
  )}" fill="rgba(11,16,24,0.78)" stroke="${escapeXml(
    color
  )}" stroke-width="${formatSvgNumber(1.4 * strokeScale)}" stroke-opacity="${formatSvgNumber(
    opacity
  )}" />
    <text x="${formatSvgNumber(bounds.textX)}" y="${formatSvgNumber(
      bounds.textY
    )}" font-size="${formatSvgNumber(textSize)}" font-weight="700" fill="${escapeXml(
    color
  )}" style="paint-order:stroke;stroke:rgba(0,0,0,0.38);stroke-width:1.1">${escapeXml(
    label
  )}</text>
  </g>`;
}

function buildSvgMeasurementMarkup(measurement = {}) {
  const points = Array.isArray(measurement?.points) ? measurement.points : [];
  if (!points.length) return "";
  const normalizedPoints = (Array.isArray(points) ? points : [])
    .map((point) => {
      const x = Number.isFinite(Number(point?.x)) ? Number(point.x) : Number(point?.[0]);
      const y = Number.isFinite(Number(point?.y)) ? Number(point.y) : Number(point?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return [x, y];
    })
    .filter(Boolean);
  if (!normalizedPoints.length) return "";
  const strokeScale = Math.max(0.5, Number(measurement?.strokeScale) || 1);
  const pointCircles = normalizedPoints
    .map(
      (point) => `<g>
        <circle cx="${formatSvgNumber(point[0])}" cy="${formatSvgNumber(
        point[1]
      )}" r="${formatSvgNumber(6 * strokeScale)}" fill="rgba(109,214,255,0.95)" stroke="rgba(11,16,24,1)" stroke-width="${formatSvgNumber(
        2 * strokeScale
      )}" />
      </g>`
    )
    .join("");
  const pointsAttr = measurementPointsToSvgString(points);
  if (measurement?.kind === "area") {
    if (measurement?.complete && normalizedPoints.length >= 3) {
      return `<g>
        <polygon points="${pointsAttr}" fill="rgba(109,214,255,0.18)" stroke="#6dd6ff" stroke-width="${formatSvgNumber(
          3 * strokeScale
        )}" stroke-dasharray="${formatSvgNumber(8 * strokeScale)} ${formatSvgNumber(
          5 * strokeScale
        )}" />
        ${pointCircles}
      </g>`;
    }
    if (normalizedPoints.length >= 2) {
      return `<g>
        <polyline points="${pointsAttr}" fill="none" stroke="#6dd6ff" stroke-width="${formatSvgNumber(
          3 * strokeScale
        )}" stroke-dasharray="${formatSvgNumber(8 * strokeScale)} ${formatSvgNumber(
          5 * strokeScale
        )}" />
        ${pointCircles}
      </g>`;
    }
    return pointCircles;
  }
  if (normalizedPoints.length >= 2) {
    return `<g>
      <line x1="${formatSvgNumber(normalizedPoints[0][0])}" y1="${formatSvgNumber(
      normalizedPoints[0][1]
    )}" x2="${formatSvgNumber(normalizedPoints[1][0])}" y2="${formatSvgNumber(
      normalizedPoints[1][1]
    )}" stroke="#6dd6ff" stroke-width="${formatSvgNumber(
      3 * strokeScale
    )}" stroke-dasharray="${formatSvgNumber(8 * strokeScale)} ${formatSvgNumber(
      5 * strokeScale
    )}" />
      ${pointCircles}
    </g>`;
  }
  return pointCircles;
}

function buildSvgMeasurementLabelMarkup(measurement = {}, normalizedPoints = []) {
  const label = String(measurement?.label || "").trim();
  const value = String(measurement?.displayValue || "").trim();
  const caption = [label, value].filter(Boolean).join(" - ");
  if (!caption || !normalizedPoints.length) return "";
  const anchor =
    measurement?.kind === "area" && normalizedPoints.length >= 3
      ? normalizedPoints.reduce(
          (acc, point) => [acc[0] + point[0] / normalizedPoints.length, acc[1] + point[1] / normalizedPoints.length],
          [0, 0]
        )
      : normalizedPoints[Math.max(0, normalizedPoints.length - 1)];
  const fontSize = 12;
  const paddingX = 10;
  const boxWidth = Math.max(88, caption.length * 6.8 + paddingX * 2);
  const boxHeight = 24;
  const x = Number(anchor?.[0]) + 10;
  const y = Number(anchor?.[1]) - 30;
  return `<g>
    <rect x="${formatSvgNumber(x)}" y="${formatSvgNumber(y)}" width="${formatSvgNumber(
    boxWidth
  )}" height="${formatSvgNumber(boxHeight)}" rx="8" ry="8" fill="rgba(10,12,18,0.88)" stroke="rgba(109,214,255,0.42)" stroke-width="1" />
    <text x="${formatSvgNumber(x + paddingX)}" y="${formatSvgNumber(
    y + 16
  )}" font-size="${formatSvgNumber(fontSize)}" font-weight="700" fill="#ffffff">${escapeXml(
    caption
  )}</text>
  </g>`;
}

function buildSvgSavedMeasurementMarkup(measurement = {}) {
  const points = normalizeMeasurementPointsForSvg(measurement?.points);
  if (!points.length) return "";
  return `<g>${buildSvgMeasurementMarkup(measurement)}${buildSvgMeasurementLabelMarkup(
    measurement,
    points
  )}</g>`;
}

function normalizeMeasurementPointsForSvg(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point) => {
      const x = Number.isFinite(Number(point?.x)) ? Number(point.x) : Number(point?.[0]);
      const y = Number.isFinite(Number(point?.y)) ? Number(point.y) : Number(point?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return [x, y];
    })
    .filter(Boolean);
}

function buildAnnotatedPlanSvgMarkup({
  imageHref,
  width,
  height,
  annotations = [],
  measurement = null,
  savedMeasurements = [],
}) {
  const annotationMarkup = (Array.isArray(annotations) ? annotations : [])
    .map((feature) => {
      const kind = String(feature?.properties?.kind || "").toLowerCase();
      if (kind === "text") return buildSvgTextMarkup(feature);
      const geometry = feature?.geometry;
      if (!geometry) return "";
      if (geometry.type === "LineString") {
        const points = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
        return `<g>${buildSvgStrokeMarkup(points, feature)}${
          kind === "callout" ? buildSvgCalloutMarkup(feature) : ""
        }</g>`;
      }
      if (geometry.type === "Polygon") {
        const ring = Array.isArray(geometry.coordinates?.[0]) ? geometry.coordinates[0] : [];
        return buildSvgPolygonMarkup(ring, feature);
      }
      return "";
    })
    .join("");
  const measurementMarkup = buildSvgMeasurementMarkup(measurement);
  const savedMeasurementMarkup = (Array.isArray(savedMeasurements) ? savedMeasurements : [])
    .map((savedMeasurement) => buildSvgSavedMeasurementMarkup(savedMeasurement))
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${formatSvgNumber(width)}" height="${formatSvgNumber(
    height
  )}" viewBox="0 0 ${formatSvgNumber(width)} ${formatSvgNumber(height)}">
  <image href="${escapeXml(imageHref)}" x="0" y="0" width="${formatSvgNumber(
    width
  )}" height="${formatSvgNumber(height)}" preserveAspectRatio="none" />
  ${annotationMarkup}
  ${savedMeasurementMarkup}
  ${measurementMarkup}
</svg>`;
}

async function renderAnnotatedPlanCanvas({
  imageUrl,
  annotations = [],
  measurement = null,
  savedMeasurements = [],
  renderScale = 2,
  maxOutputDimension = 5200,
}) {
  if (!imageUrl) throw new Error("No PDF/image page is loaded.");
  const image = await loadImage(imageUrl);
  const width = Math.max(1, Number(image.naturalWidth) || Number(image.width) || 1);
  const height = Math.max(1, Number(image.naturalHeight) || Number(image.height) || 1);
  const requestedScale = Math.max(1, Number(renderScale) || 2);
  const scaleCap = Math.max(1, Number(maxOutputDimension) || 5200);
  const effectiveScale = Math.max(
    1,
    Math.min(requestedScale, scaleCap / Math.max(width, height))
  );

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * effectiveScale));
  canvas.height = Math.max(1, Math.round(height * effectiveScale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare PDF export canvas.");
  ctx.setTransform(effectiveScale, 0, 0, effectiveScale, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const embeddedImageHref = await imageUrlToDataUrl(imageUrl);
  const svgMarkup = buildAnnotatedPlanSvgMarkup({
    imageHref: embeddedImageHref,
    width,
    height,
    annotations,
    measurement,
    savedMeasurements,
  });
  const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const composed = await loadImage(svgUrl);
    ctx.drawImage(composed, 0, 0, width, height);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }

  return { canvas, width, height, renderScale: effectiveScale };
}

function downloadExistingBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportAnnotatedPlanPNG({
  imageUrl,
  projectName,
  annotations = [],
  measurement = null,
  savedMeasurements = [],
  renderScale = 2,
}) {
  const { canvas } = await renderAnnotatedPlanCanvas({
    imageUrl,
    annotations,
    measurement,
    savedMeasurements,
    renderScale,
  });
  const pngBlob = await canvasToBlob(canvas, "image/png");
  const baseProject = safeFilenamePart(projectName, "takeoff-project");
  downloadExistingBlob(pngBlob, `${baseProject}.png`);
}

export async function exportAnnotatedPlanPDF({
  imageUrl,
  projectName,
  annotations = [],
  measurement = null,
  savedMeasurements = [],
  renderScale = 2,
}) {
  const { canvas, width, height } = await renderAnnotatedPlanCanvas({
    imageUrl,
    annotations,
    measurement,
    savedMeasurements,
    renderScale,
  });

  const jsPdfModule = await import("jspdf");
  const jsPDF = jsPdfModule?.default || jsPdfModule;
  const maxPageWidth = 792;
  const maxPageHeight = 612;
  const scale = Math.min(maxPageWidth / width, maxPageHeight / height);
  const pageWidth = Math.max(72, width * scale);
  const pageHeight = Math.max(72, height * scale);
  const orientation = pageWidth >= pageHeight ? "landscape" : "portrait";
  const doc = new jsPDF({ orientation, unit: "pt", format: [pageWidth, pageHeight] });
  const dataUrl = canvas.toDataURL("image/png");
  doc.addImage(dataUrl, "PNG", 0, 0, pageWidth, pageHeight);
  const baseProject = safeFilenamePart(projectName, "takeoff-project");
  doc.save(`${baseProject}.pdf`);
}

function getPdfPageLayout(width, height) {
  const maxPageWidth = 792;
  const maxPageHeight = 612;
  const scale = Math.min(maxPageWidth / width, maxPageHeight / height);
  const pageWidth = Math.max(72, width * scale);
  const pageHeight = Math.max(72, height * scale);
  const orientation = pageWidth >= pageHeight ? "landscape" : "portrait";
  return { pageWidth, pageHeight, orientation };
}

export async function exportAnnotatedPlanPDFBundle({
  projectName,
  pages = [],
  renderScale = 2,
}) {
  const normalizedPages = Array.isArray(pages) ? pages.filter((page) => page?.imageUrl) : [];
  if (!normalizedPages.length) {
    throw new Error("No marked-up pages were available to export.");
  }

  const renderedPages = [];
  for (const page of normalizedPages) {
    renderedPages.push(
      await renderAnnotatedPlanCanvas({
        imageUrl: page.imageUrl,
        annotations: Array.isArray(page.annotations) ? page.annotations : [],
        measurement: page.measurement || null,
        savedMeasurements: Array.isArray(page.savedMeasurements) ? page.savedMeasurements : [],
        renderScale,
      })
    );
  }

  const jsPdfModule = await import("jspdf");
  const jsPDF = jsPdfModule?.default || jsPdfModule;
  const firstPage = renderedPages[0];
  const firstLayout = getPdfPageLayout(firstPage.width, firstPage.height);
  const doc = new jsPDF({
    orientation: firstLayout.orientation,
    unit: "pt",
    format: [firstLayout.pageWidth, firstLayout.pageHeight],
  });

  renderedPages.forEach((page, index) => {
    const layout = getPdfPageLayout(page.width, page.height);
    if (index > 0) {
      doc.addPage([layout.pageWidth, layout.pageHeight], layout.orientation);
    }
    const dataUrl = page.canvas.toDataURL("image/png");
    doc.addImage(dataUrl, "PNG", 0, 0, layout.pageWidth, layout.pageHeight);
  });

  const baseProject = safeFilenamePart(projectName, "takeoff-project");
  doc.save(`${baseProject}.pdf`);
}

function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
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
export function exportPolygonsCSV(rows, projectName) {
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

  const csv = `\uFEFF${lines.join("\n")}`;
  const baseProject = safeFilenamePart(projectName, "takeoff-project");
  downloadBlob(csv, "text/csv", `${baseProject}-polygons.csv`);
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.split('"').join('""')}"`;
  }
  return s;
}
