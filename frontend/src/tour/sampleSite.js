import aerial from "../assets/field-study-aerial.jpg";

export const samplePhoto = aerial;
// The photograph is fictional. This small, bounded local image source needs no
// imagery account, address lookup, or customer coordinates.
const coordinate = ([x,y]) => [(x / 1672 - .5) * .0028, (.5 - y / 941) * .001576];
const rect = (x,y,w,h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];
const polygon = (name, ring) => ({
  type: "Feature", properties: { name },
  geometry: { type: "Polygon", coordinates: [ring.map(coordinate)] },
});
const corners = rect(0,0,1672,941).slice(0,4).map(coordinate);
export const sampleMapStyle = {
  version: 8,
  sources: { site: { type: "image", url: aerial, coordinates: corners } },
  layers: [{ id:"site-paper", type:"background", paint:{"background-color":"#1d322b"} },
    { id:"bm-maptiler", type:"raster", source:"site", paint:{"raster-fade-duration":0} }],
};
export const sampleBounds = [[-.005,-.005],[.005,.005]];
export const sampleFrame = [...corners[3], ...corners[1]];
export const sitePayload = {
  version: 2, projectName: "Evergreen Office", workflowMode: "location", activeLayer:"plowable",
  layerFeatures: {
    plowable: [polygon("South parking court", rect(168,590,1060,248))],
    sidewalks: [polygon("Entrance walk", rect(748,381,41,194))],
    turf: [polygon("South lawn", rect(325,879,900,55))],
    mulch: [polygon("Parking island", rect(1356,272,66,208))],
  },
};
const planName = "Evergreen Service Plan";
export const tourProjects = [sitePayload, {
  version:2, workflowMode:"pdf", projectName:planName, layerFeatures:{plowable:[],sidewalks:[],turf:[],mulch:[]},
}].map((payload,index) => ({
  id: index ? "tour-plan" : "tour-site", projectName:payload.projectName, payload,
  folderName:"Training sites", workflowMode:payload.workflowMode, storageScope:"local",
  lastEditedAt:new Date(Date.now()-index*60_000).toISOString(),
}));

export async function samplePlan() {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({orientation:"landscape", unit:"pt", format:[720,480]});
  doc.setTextColor("#214b3b").setFontSize(24).text("Evergreen Office | Service plan",32,46);
  doc.setFontSize(12).text("TRAINING SHEET 01    /    Use the 60 ft reference to calibrate the plan.",32,70);
  doc.setFillColor("#dbe9dd").setDrawColor("#365a4c").rect(145,150,330,220,"FD");
  doc.setFontSize(18).text("Service pad",252,270);
  doc.line(145,126,475,126).line(145,120,145,132).line(475,120,475,132);
  doc.setFontSize(12).text("60 ft",294,118).text("40 ft",485,266);
  doc.text("Fictional example / Not for construction",32,448);
  const base64 = doc.output("datauristring").split(",")[1];
  return {...tourProjects[1].payload, pdfPageNumber:1, pdfPageCount:1, pdfSourceName:"Evergreen service plan.pdf",
    pdfSourceAsset:{name:"Evergreen service plan.pdf",type:"application/pdf",kind:"pdf",base64,size:Math.floor(base64.length*.75)}};
}
