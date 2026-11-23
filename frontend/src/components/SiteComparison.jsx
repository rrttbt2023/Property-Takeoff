import { useId, useState } from "react";
import aerialUrl from "../assets/field-study-aerial.jpg";
import { studyLayers, studyWidth, studyHeight } from "./fieldStudyGeometry";

export default function SiteComparison({ onStart }) {
  const [split, setSplit] = useState(48);
  const [hidden, setHidden] = useState([]);
  const id = useId().replace(/:/g, "");
  const toggle = (key) => setHidden(previous => previous.includes(key)
    ? previous.filter(layer => layer !== key) : [...previous, key]);

  return <section className="field-study" aria-label="Interactive example takeoff">
    <header><strong>Field study / 01</strong><span>Fictional office property</span></header>
    <div className="field-study-map">
      <img src={aerialUrl} width={studyWidth} height={studyHeight}
        alt="Example aerial view of an office, its parking lot, concrete walks, lawn and planted mulch beds" />
      <svg className="field-study-overlay" viewBox={`0 0 ${studyWidth} ${studyHeight}`} aria-hidden="true">
        <defs><clipPath id={id + "-reveal"}><rect x={split * studyWidth / 100}
          width={(100 - split) * studyWidth / 100} height={studyHeight} /></clipPath></defs>
        <g clipPath={`url(#${id}-reveal)`} fillRule="evenodd" strokeLinejoin="round">
          {studyLayers.filter(layer => !hidden.includes(layer.key)).map(layer =>
            <path key={layer.key} data-surface={layer.key} d={layer.path} fill={layer.color} fillOpacity=".53"
              stroke={layer.color} strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        </g>
      </svg>
      {split >= 23 && <span className="field-study-tag before" aria-hidden="true">Aerial</span>}
      {split <= 77 && <span className="field-study-tag after" aria-hidden="true">Measured</span>}
      <span className="field-study-divider" style={{left: split+"%"}} aria-hidden="true"><i>&lsaquo; &rsaquo;</i></span>
      <input type="range" min="0" max="100" value={split} aria-label="Compare unmarked site and measured surfaces"
        aria-valuetext={`${100 - split}% measured overlay visible`} onChange={(event) => setSplit(Number(event.target.value))} />
    </div>
    <div className="field-study-key" role="group" aria-labelledby={id+"-key"}>
      <div className="field-study-key-heading"><h2 id={id+"-key"}>Measurement key</h2><small>Drag to compare. Select a surface to show or hide it.</small></div>
      <div className="field-study-layers">{studyLayers.map(layer =>
        <button type="button" key={layer.key} aria-pressed={!hidden.includes(layer.key)} style={{"--layer-color": layer.color}}
          onClick={() => toggle(layer.key)}>{layer.label}</button>)}</div>
    </div>
    {onStart && <div className="field-study-actions"><button type="button" onClick={() => onStart("measure")}>Measure it myself</button><button type="button" onClick={() => onStart("quote")}>Request a measured takeoff</button></div>}
  </section>;
}
