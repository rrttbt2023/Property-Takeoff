import { useEffect, useRef, useState } from "react";
import PublicDialog from "../components/PublicDialog";
import App from "../App";
import "./guest-tour.css";

const stops = [
  ["Project dashboard", "Open Evergreen Office with Continue measuring, or browse its project folder."],
  ["Location measuring", "Select a colored polygon to inspect it. Try another surface layer or draw on this sample site."],
  ["PDF / Image measuring", "Use the drawing tools on the sample sheet. Use the 60 ft reference if you want to try calibration."],
  ["Proposal Builder", "Choose Evergreen Office to load its measured quantities. Change a unit price to see the proposal total update."],
  ["Managed takeoffs", "Choose the surfaces you need, then draw a boundary on the sample site. Nothing is submitted."],
  ["Choose your next step", "Start with your own site when you're ready."],
];

export default function GuestTour() {
  const [step, go] = useState(0);
  const [toolsOpen,setToolsOpen] = useState(false);
  const title = useRef(null);
  useEffect(() => { title.current?.focus({preventScroll:true}); }, [step]);
  const navigate = index => { setToolsOpen(false); go(index); };
  const leave = intent => { window.location.assign(intent ? "?start="+intent : window.location.pathname); };
  return <div className={"guest-tour"+(toolsOpen ? " tour-tools-open" : "")}>
    <header className="guest-guide" aria-label="Workspace tour">
      <div><small>LIVE WORKSPACE TOUR · {step+1} OF {stops.length}</small>
        <h2 ref={title} tabIndex={-1}>{stops[step][0]}</h2>
        <p>{stops[step][1]} <span>Sample data only.</span></p></div>
      <nav aria-label="Tour controls">
        {(step===1 || step===2) && <button className="guest-tool-toggle" aria-expanded={toolsOpen} onClick={()=>setToolsOpen(!toolsOpen)}>{toolsOpen ? "Show canvas" : "Show tools"}</button>}
        {step>0 && <button onClick={()=>navigate(step-1)}>Back</button>}
        {step<stops.length-1 && <button className="guest-next" onClick={()=>navigate(step+1)}>Next step</button>}
        <button onClick={()=>leave("")}>Exit tour</button>
      </nav>
    </header>
    <div className="guest-workspace"><App tourStep={step} onTourStep={navigate} /></div>
    {step===stops.length-1 && <PublicDialog title="Your next step" label="Finish workspace tour" onClose={()=>navigate(step-1)}>
      <div className="guest-finish"><h2>Who will measure your site?</h2><p>Tour edits are temporary. Choose how you want to work on a real property.</p>
        <div className="tour-choices"><button onClick={()=>leave("quote")}><strong>Request a measured takeoff</strong><span>Create a free account and submit your site for a quote.</span></button>
        <button onClick={()=>leave("measure")}><strong>Sign up for the monthly plan</strong><span>Measure it yourself with Basic for $9.99/month.</span></button></div>
        <button className="guest-exit" onClick={()=>leave("")}>Back to sign in</button>
      </div>
    </PublicDialog>}
  </div>;
}
