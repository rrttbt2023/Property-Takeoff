import { isGuestTour, workspaceStorage } from "../tour/guestRuntime.js";
import { useEffect, useMemo, useState } from "react";

const DRAFT_KEY = "property-takeoff-proposal-draft-v1";
const LAYERS = [
  ["plowable", "Plowable pavement", "ac", 0],
  ["sidewalks", "Sidewalks", "sq ft", 0],
  ["turf", "Turf / lawn", "ac", 0],
  ["mulch", "Landscape beds", "sq ft", 0],
];

function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(safeNumber(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function initialDraft() {
  try {
    const stored = JSON.parse(workspaceStorage("localStorage").getItem(DRAFT_KEY) || "null");
    if (stored && typeof stored === "object") return stored;
  } catch {
    // Ignore malformed local proposal drafts.
  }
  return {
    projectId: "",
    customer: "",
    proposalTitle: "Snow & Landscape Service Proposal",
    validDays: 30,
    labor: 0,
    materials: 0,
    equipment: 0,
    markupPercent: 15,
    notes: "Pricing is based on the measured site quantities and requested scope shown below.",
    lineItems: LAYERS.map(([key, label, unit, unitPrice]) => ({ key, label, unit, quantity: 0, unitPrice })),
  };
}

async function projectQuantities(project) {
  const layers = project?.payload?.layerFeatures;
  if (!layers || typeof layers !== "object") return null;
  const turf = await import("@turf/turf");
  const result = {};
  for (const [key, , unit] of LAYERS) {
    let squareFeet = 0;
    for (const feature of layers[key] || []) {
      try {
        squareFeet += turf.area(feature) * 10.76391041671;
      } catch {
        squareFeet += safeNumber(feature?.properties?.sqft || feature?.properties?.areaSqFt);
      }
    }
    result[key] = unit === "ac" ? squareFeet / 43_560 : squareFeet;
  }
  return result;
}

function proposalHtml(draft, selectedProject, totals) {
  const rows = draft.lineItems
    .filter((item) => safeNumber(item.quantity) > 0)
    .map((item) => `<tr><td>${escapeHtml(item.label)}</td><td>${safeNumber(item.quantity).toLocaleString(undefined, { maximumFractionDigits: item.unit === "ac" ? 2 : 0 })} ${escapeHtml(item.unit)}</td><td>${money(item.unitPrice)}</td><td>${money(safeNumber(item.quantity) * safeNumber(item.unitPrice))}</td></tr>`)
    .join("");
  // Keep the closing script tag escaped inside the generated standalone document.
  // eslint-disable-next-line no-useless-escape
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(draft.proposalTitle)}</title><style>body{font-family:Georgia,serif;color:#142019;margin:0;background:#eef2ed}.page{max-width:850px;margin:28px auto;background:#fff;padding:54px;box-shadow:0 8px 30px #0002}.brand{color:#245f35;text-transform:uppercase;letter-spacing:.12em;font:700 13px Arial}.top{display:flex;justify-content:space-between;gap:30px;border-bottom:3px solid #4e9c45;padding-bottom:22px}.top h1{font-size:34px;margin:10px 0}.meta{text-align:right;font-family:Arial;font-size:13px}.site{background:#f2f7f0;padding:18px;margin:24px 0}.site strong{font-size:20px}.site span{display:block;margin-top:6px;color:#526158}table{width:100%;border-collapse:collapse;margin:22px 0;font-family:Arial;font-size:14px}th{text-align:left;background:#163f29;color:#fff;padding:11px}td{padding:12px 10px;border-bottom:1px solid #dce4dc}th:last-child,td:last-child{text-align:right}.totals{margin-left:auto;width:330px;font-family:Arial}.totals div{display:flex;justify-content:space-between;padding:7px}.totals .grand{font-size:20px;font-weight:800;border-top:2px solid #163f29}.notes{margin-top:34px;line-height:1.55;white-space:pre-wrap}.footer{margin-top:50px;border-top:1px solid #ccd7cd;padding-top:14px;font:12px Arial;color:#607064}@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:24px}}</style></head><body><main class="page"><div class="brand">McKenna Site Management</div><div class="top"><div><h1>${escapeHtml(draft.proposalTitle)}</h1><p>Prepared for <strong>${escapeHtml(draft.customer || "Client")}</strong></p></div><div class="meta"><b>${new Date().toLocaleDateString()}</b><br>Valid for ${safeNumber(draft.validDays)} days</div></div><div class="site"><strong>${escapeHtml(selectedProject?.projectName || "Measured property")}</strong><span>${escapeHtml(selectedProject?.payload?.propertyAddress || selectedProject?.payload?.address || "Property address on file")}</span></div><table><thead><tr><th>Service</th><th>Measured quantity</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${rows || "<tr><td colspan=4>No measured line items selected.</td></tr>"}</tbody></table><div class="totals"><div><span>Measured services</span><b>${money(totals.services)}</b></div><div><span>Labor</span><b>${money(draft.labor)}</b></div><div><span>Materials</span><b>${money(draft.materials)}</b></div><div><span>Equipment</span><b>${money(draft.equipment)}</b></div><div><span>Markup (${safeNumber(draft.markupPercent)}%)</span><b>${money(totals.markup)}</b></div><div class="grand"><span>Proposal total</span><b>${money(totals.total)}</b></div></div><div class="notes"><h3>Scope and notes</h3>${escapeHtml(draft.notes)}</div><div class="footer">Quantities were prepared in Property Takeoff and should be reviewed with the final service scope before acceptance.</div></main><script>window.addEventListener('load',()=>window.print())<\/script></body></html>`;
}

export default function ProposalBuilder({ projects = [] }) {
  const [draft, setDraft] = useState(initialDraft);
  const [loadingProject, setLoadingProject] = useState(false);
  const [message, setMessage] = useState("");
  const selectableProjects = useMemo(() => projects.filter((project) => project?.payload?.layerFeatures), [projects]);
  const selectedProject = selectableProjects.find((project) => String(project.id) === String(draft.projectId)) || null;

  useEffect(() => {
    workspaceStorage("localStorage").setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [draft]);

  const totals = useMemo(() => {
    const services = draft.lineItems.reduce((sum, item) => sum + safeNumber(item.quantity) * safeNumber(item.unitPrice), 0);
    const subtotal = services + safeNumber(draft.labor) + safeNumber(draft.materials) + safeNumber(draft.equipment);
    const markup = subtotal * (safeNumber(draft.markupPercent) / 100);
    return { services, subtotal, markup, total: subtotal + markup };
  }, [draft]);

  const chooseProject = async (projectId) => {
    setDraft((previous) => ({ ...previous, projectId }));
    const project = selectableProjects.find((item) => String(item.id) === String(projectId));
    if (!project) return;
    setLoadingProject(true);
    setMessage("");
    try {
      const quantities = await projectQuantities(project);
      if (!quantities) throw new Error("This project does not have measurable polygons on this device.");
      setDraft((previous) => ({
        ...previous,
        projectId,
        lineItems: previous.lineItems.map((item) => ({ ...item, quantity: Number((quantities[item.key] || 0).toFixed(item.unit === "ac" ? 3 : 0)) })),
      }));
      setMessage("Measured quantities loaded from the selected project.");
    } catch (error) {
      setMessage(error?.message || "Project quantities could not be loaded.");
    } finally {
      setLoadingProject(false);
    }
  };

  const updateItem = (key, field, value) => setDraft((previous) => ({ ...previous, lineItems: previous.lineItems.map((item) => item.key === key ? { ...item, [field]: value } : item) }));
  const printProposal = () => {
    const popup = window.open("", "_blank");
    if (!popup) {
      setMessage("Allow pop-ups to print or save the proposal as a PDF.");
      return;
    }
    popup.opener = null;
    popup.document.open();
    popup.document.write(proposalHtml(draft, selectedProject, totals));
    popup.document.close();
  };

  return <section className="hd-proposal-builder">
    <div className="hd-page-intro"><span className="hd-page-kicker">Measured-site pricing</span><h2>Proposal Builder</h2><p>Load quantities from a saved project, add labor, materials, equipment, and markup, then print or save a client-ready PDF.</p></div>
    <div className="hd-proposal-grid">
      <form className="hd-card hd-proposal-form" onSubmit={(event) => { event.preventDefault(); printProposal(); }}>
        <div className="hd-proposal-fields"><label>Measured project<select data-tour-target={isGuestTour ? "project" : undefined} value={draft.projectId} onChange={(event) => void chooseProject(event.target.value)}><option value="">Choose a project</option>{selectableProjects.map((project) => <option key={project.id} value={project.id}>{project.projectName || "Untitled Project"}</option>)}</select></label><label>Customer / company<input value={draft.customer} onChange={(event) => setDraft((previous) => ({ ...previous, customer: event.target.value }))} /></label><label>Proposal title<input value={draft.proposalTitle} onChange={(event) => setDraft((previous) => ({ ...previous, proposalTitle: event.target.value }))} /></label><label>Valid for<input type="number" min="1" max="365" value={draft.validDays} onChange={(event) => setDraft((previous) => ({ ...previous, validDays: event.target.value }))} /><small>days</small></label></div>
        <div className="hd-proposal-items"><div className="hd-proposal-item header"><span>Service</span><span>Quantity</span><span>Unit</span><span>Unit price</span><span>Amount</span></div>{draft.lineItems.map((item) => <div className="hd-proposal-item" key={item.key}><strong>{item.label}</strong><input aria-label={`${item.label} quantity`} type="number" min="0" step={item.unit === "ac" ? ".001" : "1"} value={item.quantity} onChange={(event) => updateItem(item.key, "quantity", event.target.value)} /><span>{item.unit}</span><input data-tour-target={isGuestTour && selectedProject && item.key === "plowable" ? "unit-price" : undefined} aria-label={`${item.label} unit price`} type="number" min="0" step=".01" value={item.unitPrice} onChange={(event) => updateItem(item.key, "unitPrice", event.target.value)} /><b>{money(safeNumber(item.quantity) * safeNumber(item.unitPrice))}</b></div>)}</div>
        <div className="hd-proposal-costs"><label>Labor<input type="number" min="0" step=".01" value={draft.labor} onChange={(event) => setDraft((previous) => ({ ...previous, labor: event.target.value }))} /></label><label>Materials<input type="number" min="0" step=".01" value={draft.materials} onChange={(event) => setDraft((previous) => ({ ...previous, materials: event.target.value }))} /></label><label>Equipment<input type="number" min="0" step=".01" value={draft.equipment} onChange={(event) => setDraft((previous) => ({ ...previous, equipment: event.target.value }))} /></label><label>Markup<input type="number" min="0" max="500" step=".5" value={draft.markupPercent} onChange={(event) => setDraft((previous) => ({ ...previous, markupPercent: event.target.value }))} /><small>%</small></label></div>
        <label className="hd-proposal-notes">Scope and notes<textarea value={draft.notes} onChange={(event) => setDraft((previous) => ({ ...previous, notes: event.target.value }))} /></label>
        <div className="hd-proposal-actions"><span>{loadingProject ? "Calculating project quantities..." : message || (isGuestTour ? "Tour draft only. Changes disappear when you leave." : "Draft automatically saved on this device.")}</span><button className="hd-button hd-button-primary" type="submit">Print / Save PDF</button></div>
      </form>
      <aside className="hd-card hd-proposal-total"><small>Proposal total</small><strong>{money(totals.total)}</strong><span>Services {money(totals.services)}</span><span>Labor, materials & equipment {money(safeNumber(draft.labor) + safeNumber(draft.materials) + safeNumber(draft.equipment))}</span><span>Markup {money(totals.markup)}</span><p>Review contract language, taxes, exclusions, and service frequency before sending.</p></aside>
    </div>
  </section>;
}
