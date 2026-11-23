import { useEffect, useRef, useState } from "react";
import aerial from "../assets/field-study-aerial.jpg";
import SiteComparison from "./SiteComparison";
import PublicDialog from "./PublicDialog";

const stops = [
  ["Project library", "Start with a property", "In your workspace, folders keep jobs together. Select the example office below to open its map."],
  ["Map measuring", "See what gets measured", "On a job, trace each surface with the polygon tool. In this example, drag the divider and toggle the measurement key to inspect each layer."],
  ["PDF / Image", "Measure a plan to scale", "On a plan, mark two points with a known distance to calibrate the page. Try the 60-foot reference below to see the area of this 60 by 40 foot pad."],
  ["Managed takeoffs", "Send a site for a quote", "In the quote form, enter an address, choose the surfaces, and draw the boundary. Try outlining this example site. Nothing is submitted during the tour."],
  ["Next steps", "Who will measure your site?", "Measure it yourself with Basic, or have McKenna quote the work. Both start with your own company account."],
];

export default function PublicTour({ onClose, onStart }) {
  const [step, setStep] = useState(0);
  const [scaled, setScaled] = useState(false);
  const [outlined, setOutlined] = useState(false);
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step]);
  const [section, title, instruction] = stops[step];
  return <PublicDialog wide label="Guided tour" onClose={onClose}>
    <div className="tour-content">
      <div className="tour-track" aria-label="Tour stops">{stops.map(([name], index) =>
        <button type="button" key={name} aria-label={`Step ${index + 1}: ${name}`} aria-current={index === step ? "step" : undefined}
          onClick={() => setStep(index)}>{index + 1}</button>)}</div>
      <section className="tour-guide">
        <small>Step {step + 1} of {stops.length} / {section}</small>
        <h2 ref={heading} tabIndex={-1}>{title}</h2>
        <p>{instruction}</p>
      </section>
      {step === 0 && <div className="tour-sample">
        <small>Project folders / Office sites</small>
        <button type="button" className="tour-project" onClick={() => setStep(1)}>
          <img src={aerial} alt="" /><span><small>Fictional project</small><strong>Evergreen Office</strong><span>Open measured property &rarr;</span></span>
        </button>
      </div>}
      {step === 1 && <SiteComparison />}
      {step === 2 && <div className="tour-sample tour-plan">
        <small>Site plan / Sheet 01</small>
        <svg viewBox="0 0 360 170" role="img" aria-label="Example rectangular service pad, sixty feet wide and forty feet long">
          <path d="M68 35H230V143H68Z" fill={scaled ? "#a6d4b1" : "#f3f6ea"} stroke="#376c54" strokeWidth="2" />
          <path d="M68 13v12m0-6h162m0-6v12M244 35h12m-6 0v108m-6 0h12" stroke="#47645c" fill="none"/>
          <g fill="#1a4737" fontSize="13"><text x="149" y="15" textAnchor="middle">60 ft</text><text x="258" y="93">40 ft</text>
          <text x="149" y="94" textAnchor="middle">{scaled ? "2,400 sq ft" : "Service pad"}</text></g>
        </svg>
        <button type="button" aria-pressed={scaled} onClick={() => setScaled(!scaled)}>{scaled ? "Reset sample scale" : "Calibrate with 60 ft"}</button>
      </div>}
      {step === 3 && <div className="tour-sample"><small>Quote request / Example only</small>
        <div className="tour-boundary"><img src={aerial} alt="Example office property to outline" />
          {outlined && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M5 6H92L95 92H5Z" fill="#ffda5a33" stroke="#ffdf66" vectorEffect="non-scaling-stroke" strokeWidth="3"/></svg>}
        </div>
        <button type="button" aria-pressed={outlined} onClick={() => setOutlined(!outlined)}>{outlined ? "Clear sample boundary" : "Show sample boundary"}</button>
        <p>Approve your quote before work begins. Delivery is within 24 hours of approval.</p>
      </div>}
      {step === 4 && <div className="tour-choices">
        <button type="button" onClick={() => onStart("quote")}><strong>Request a measured takeoff</strong><span>Quote per site. No monthly subscription.</span></button>
        <button type="button" onClick={() => onStart("measure")}><strong>Sign up for the monthly plan</strong><span>$9.99/month for manual map and PDF measuring.</span></button>
      </div>}
      <footer className="tour-footer"><button type="button" onClick={step ? () => setStep(step - 1) : onClose}>{step ? "Back" : "Exit tour"}</button>
        {step < stops.length - 1 && <button type="button" onClick={() => setStep(step + 1)}>Next step &rarr;</button>}</footer>
    </div>
  </PublicDialog>;
}
