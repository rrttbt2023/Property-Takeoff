import { kml } from "@mapbox/togeojson";
import { unzipSync, strFromU8 } from "fflate";

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
    return kml(dom);
  }

  const xmlText = new TextDecoder().decode(buf);
  const dom = new DOMParser().parseFromString(xmlText, "text/xml");
  return kml(dom);
}