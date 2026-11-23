import { useId, useState } from "react";

const pavement = "M42 54H492V140H528V173H491V207H44Q30 207 30 192V68Q30 54 42 54Z";
const roof = "M89 77H241V104H258V160H229V176H89Z";
const walk = "M77 65H252V94H271V169H241V188H77Z";
const turf = "M302 89H462Q470 89 470 95Q470 101 462 101H302Q294 101 294 95Q294 89 302 89ZM302 147H462Q470 147 470 153Q470 159 462 159H302Q294 159 294 153Q294 147 302 147Z";

export default function SiteComparison({ onStart }) {
  const [split, setSplit] = useState(48);
  const id = useId().replace(/:/g, "");
  return <section className="field-study" aria-label="Interactive example takeoff">
    <header><strong>Field study / 01</strong><span>Illustrated fictional site</span></header>
    <div className="field-study-map">
      <svg viewBox="0 0 560 240" role="img" aria-label="A commercial site before and after surface measurement">
        <defs>
          <clipPath id={id + "-reveal"}><rect x={split * 5.6} width={560 - split * 5.6} height="240" /></clipPath>
          <pattern id={id + "-bays"} width="11" height="34" patternUnits="userSpaceOnUse"><path d="M1 0V34" stroke="#e4dfc6" strokeWidth="1.25" /></pattern>
          <pattern id={id + "-seams"} width="14" height="14" patternUnits="userSpaceOnUse"><path d="M0 0V14" stroke="#a7aaa3" /></pattern>
          <g id={id + "-tree"}><ellipse cx="4" cy="5" rx="11" ry="9" fill="#233e3d" opacity=".45"/><circle r="10" fill="#496344"/><circle cx="-3" cy="-3" r="7" fill="#67805c"/></g>
        </defs>
        <rect width="560" height="240" fill="#849678"/>
        <path d="M-20 29L561 11M520 -10L540 253" fill="none" stroke="#b9b8a8" strokeWidth="36"/>
        <path d="M-20 29L561 11M520 -10L540 253" fill="none" stroke="#626d70" strokeWidth="30"/>
        <path d="M-20 29L561 11M520 -10L540 253" fill="none" stroke="#d6cd9a" strokeDasharray="9 9" strokeWidth="1.5"/>
        <path d={pavement} fill="#747d7d" stroke="#c4c5ad" strokeWidth="3"/>
        {[66,102,124,160].map(y => <rect key={y} x="299" y={y} width="166" height="21" fill={`url(#${id}-bays)`}/>)}
        <path d={turf} fill="#899873"/>
        <path d={walk} fill="#cfcdba"/><path d={roof} fill="#424b4a" transform="translate(5 5)"/>
        <path d={roof} fill="#b8b9ac" stroke="#e8e3ce" strokeWidth="2"/><path d={roof} fill={`url(#${id}-seams)`}/>
        {[105,132,159].map(x => <g key={x}><rect x={x} y="88" width="15" height="10" fill="#83908b" stroke="#d1d4c8"/><circle cx={x+7} cy="93" r="3" fill="#5f706d"/></g>)}
        {[[25,47],[60,43],[98,43],[138,40],[274,43],[355,42],[425,40],[23,220],[57,223],[112,225],[178,226],[273,222],[394,224],[478,219]].map(([x,y]) => <use key={x} href={`#${id}-tree`} x={x} y={y}/>)}
        <g clipPath={`url(#${id}-reveal)`} strokeWidth="2" fillRule="evenodd">
          <path d={pavement+" "+walk+" "+turf} fill="#458fc8" fillOpacity=".48" stroke="#97d4ff"/>
          <path d={walk+" "+roof} fill="#ffd16e" fillOpacity=".68" stroke="#ffe293"/>
          <path d={turf} fill="#95cc73" stroke="#c5f298"/>
        </g>
      </svg>
      <span className="field-study-divider" style={{left: split+"%"}} aria-hidden="true"><i>&lsaquo; &rsaquo;</i></span>
      <input type="range" min="0" max="100" value={split} aria-label="Compare unmarked site and measured surfaces"
        aria-valuetext={`${100 - split}% measured overlay visible`} onChange={(event) => setSplit(Number(event.target.value))}/>
    </div>
    <div className="field-study-key"><span>Drag to compare</span><b>Pavement</b><b>Sidewalk</b><b>Turf</b></div>
    <div className="field-study-actions"><button type="button" onClick={() => onStart("measure")}>Measure it myself</button><button type="button" onClick={() => onStart("quote")}>Request a measured takeoff</button></div>
  </section>;
}
