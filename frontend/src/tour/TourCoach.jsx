import { useLayoutEffect, useRef, useState } from "react";

const targets = [
  ["open-site"],
  ["no-map", "result", "finish", "add-point", "trace", "draw", "tools"],
  ["sheet", "pen", "tools"],
  ["unit-price", "project"],
  ["boundary-done", "boundary-finish", "boundary-map", "boundary-start", "surfaces"],
];

function guidance(key, count) {
  const nextCorner = count === 0 ? "the first corner" : count === 1 ? "a second corner" : "a third corner";
  const tips = {
    "open-site": ["Open the sample property", "Choose Continue measuring to open Evergreen Office on the map."],
    tools: ["Open your tools", "Tap Show tools to find the highlighted drawing button."],
    draw: ["Draw your first polygon", "Choose Draw Mode. You’ll trace a small patch of pavement on the sample property."],
    trace: ["Place corner " + (count + 1), "Click " + nextCorner + " on the pavement. Put each corner in a different spot."],
    "add-point": ["Place corner " + (count + 1), "Pan until the crosshair is over " + nextCorner + ", then tap Add Point."],
    finish: ["Close the outline", "Choose Finish to measure these corners, or keep adding points for a more detailed outline."],
    result: ["Your polygon is measured", "The highlighted result is for the outline you just drew. Square feet and acres describe the same area. Choose Next step when you’re ready."],
    "no-map": ["Interactive map unavailable", "This browser cannot draw a polygon here. Choose Next step to try the PDF tools."],
    pen: ["Try marking up a plan", "Select Pen, then draw a stroke on the sample sheet."],
    sheet: ["Draw on the sheet", "Drag across the service pad to leave a pen mark. Use Undo Last Markup to remove it."],
    project: ["Load measured quantities", "Choose Evergreen Office. Its measured surfaces become line items in the proposal."],
    "unit-price": ["Price a measured surface", "Enter a unit price here. The line amount and proposal total update from the measured quantity."],
    surfaces: ["Choose what needs measuring", "Select a surface, such as plowable pavement. Then you’ll outline the site."],
    "boundary-start": ["Start the quote boundary", "Choose Draw boundary to outline the area you want measured."],
    "boundary-map": ["Trace the quote boundary", "Tap or click three different corners on this map."],
    "boundary-finish": ["Finish the boundary", "Choose Finish boundary to calculate the enclosed area."],
    "boundary-done": ["Review the boundary area", "This is the size of your quote boundary. Nothing is submitted during the tour."],
  };
  return tips[key];
}

// Prefer open space beside the control. A full-screen canvas gets a note inside
// its edge instead; the note never captures pointer or touch events.
function position(element, note) {
  const r = element.getBoundingClientRect();
  const {width:w, height:h} = note.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const x = Math.max(8, Math.min(width-w-8, r.left+(r.width-w)/2));
  const y = Math.max(8, Math.min(height-h-8, r.top+(r.height-h)/2));
  const gap = 10;
  if (element.dataset.tourTarget === "add-point" && r.top-gap-h >= 8) return [x,r.top-gap-h,"bottom"];
  if (element.dataset.tourTarget === "finish" && r.bottom+gap+h <= height-8) return [x,r.bottom+gap,"top"];
  if (r.right + gap + w <= width-8) return [r.right+gap,y,"left"];
  if (r.left-gap-w >= 8) return [r.left-gap-w,y,"right"];
  if (r.bottom+gap+h <= height-8) return [x,r.bottom+gap,"top"];
  if (r.top-gap-h >= 8) return [x,r.top-gap-h,"bottom"];
  return [x,Math.max(8,Math.min(height-h-8,r.top+8)),"inside"];
}

export default function TourCoach({ step, toolsOpen }) {
  const note = useRef(null);
  const [tip,setTip] = useState(null);
  useLayoutEffect(() => {
    const root = note.current?.closest(".guest-tour");
    if (!root) return;
    let current = null;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const sizes = new ResizeObserver(schedule);
    const detach = () => {
      if (!current) return;
      sizes.unobserve(current);
      current.removeAttribute("data-coached");
      const descriptions = (current.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id !== "guest-coach");
      if (descriptions.length) current.setAttribute("aria-describedby",descriptions.join(" "));
      else current.removeAttribute("aria-describedby");
    };
    function update() {
      frame = 0;
      let target = null;
      for (const id of targets[step] || []) {
        target = Array.from(root.querySelectorAll('[data-tour-target="'+id+'"]')).find(el => {
          const box = el.getBoundingClientRect();
          return box.width > 4 && box.height > 4 && !el.closest("[inert]");
        });
        if (target) break;
      }
      if (target !== current) {
        detach();
        current = target;
        if (current) {
          current.setAttribute("data-coached","");
          current.setAttribute("aria-describedby", [current.getAttribute("aria-describedby"),"guest-coach"].filter(Boolean).join(" "));
          current.scrollIntoView({block:"nearest",inline:"nearest",behavior:"instant"});
          sizes.observe(current);
        }
      }
      if (!target) { setTip(null); return; }
      const box = target.getBoundingClientRect();
      if (box.bottom<=0 || box.right<=0 || box.top>=innerHeight || box.left>=innerWidth) { setTip(null); return; }
      const [heading,text] = guidance(target.dataset.tourTarget, Number(target.dataset.tourCount)||0);
      setTip(prev => prev?.heading===heading && prev?.text===text ? prev : {heading,text});
      const [left,top,side] = position(target,note.current);
      Object.assign(note.current.style,{left:left+"px",top:top+"px"});
      const horizontal = side === "top" || side === "bottom";
      const pointer = horizontal ? box.left+box.width/2-left : box.top+box.height/2-top;
      const extent = horizontal ? note.current.offsetWidth : note.current.offsetHeight;
      note.current.style.setProperty("--coach-pointer", Math.max(9,Math.min(pointer-4,extent-14))+"px");
      note.current.dataset.side = side;
    }
    sizes.observe(root);
    sizes.observe(note.current);
    const changes = new MutationObserver(schedule);
    changes.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:["data-tour-target","data-tour-count"]});
    window.addEventListener("resize",schedule);
    root.addEventListener("scroll",schedule,true);
    update();
    return () => {
      detach();
      changes.disconnect();
      sizes.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize",schedule);
      root.removeEventListener("scroll",schedule,true);
    };
  },[step,toolsOpen]);
  return <aside ref={note} id="guest-coach" role="note" aria-live="polite" aria-atomic="true"
    className="guest-coach" style={{visibility:tip ? "visible" : "hidden"}}>
    {tip && <><strong>{tip.heading}</strong><span>{tip.text}</span></>}
  </aside>;
}
