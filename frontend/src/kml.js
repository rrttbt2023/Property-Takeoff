import { kml } from "@mapbox/togeojson";
import { unzipSync, strFromU8 } from "fflate";

function extractPlacemarkMetadata(dom) {
  const placemarks = Array.from(dom.querySelectorAll("Placemark"));
  return placemarks.map((placemark) => {
    const folderNames = [];
    let parent = placemark.parentElement;
    while (parent) {
      if (parent.tagName === "Folder") {
        const folderName = parent.querySelector(":scope > name")?.textContent?.trim() || "";
        if (folderName) folderNames.unshift(folderName);
      }
      parent = parent.parentElement;
    }
    const placemarkName =
      placemark.querySelector(":scope > name")?.textContent?.trim() || "";
    const styleUrl =
      placemark.querySelector(":scope > styleUrl")?.textContent?.trim() || "";
    return {
      folderNames,
      folderName: folderNames[folderNames.length - 1] || "",
      folderPath: folderNames.join(" / "),
      placemarkName,
      styleUrl,
    };
  });
}

function parseKmlDocument(dom) {
  const geo = kml(dom);
  const metadata = extractPlacemarkMetadata(dom);
  const features = (Array.isArray(geo?.features) ? geo.features : []).map((feature, idx) => {
    const meta = metadata[idx] || {};
    return {
      ...feature,
      properties: {
        ...(feature?.properties || {}),
        kmlFolderName: String(meta.folderName || "").trim(),
        kmlFolderPath: String(meta.folderPath || "").trim(),
        kmlPlacemarkName: String(meta.placemarkName || "").trim(),
        kmlStyleUrl: String(meta.styleUrl || "").trim(),
      },
    };
  });
  return {
    ...geo,
    features,
  };
}

export async function loadKmlOrKmz(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  if (name.endsWith(".kmz")) {
    const unzipped = unzipSync(buf);
    const kmlFileName = Object.keys(unzipped).find((n) =>
      n.toLowerCase().endsWith(".kml")
    );
    if (!kmlFileName) throw new Error("KMZ did not contain a .kml file");

    const xmlText = strFromU8(unzipped[kmlFileName]);
    const dom = new DOMParser().parseFromString(xmlText, "text/xml");
    return parseKmlDocument(dom);
  }

  const xmlText = new TextDecoder().decode(buf);
  const dom = new DOMParser().parseFromString(xmlText, "text/xml");
  return parseKmlDocument(dom);
}
