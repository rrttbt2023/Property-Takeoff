import { useEffect, useRef } from "react";

// A native modal makes the rest of the public page inert, including on iPad.
export default function PublicDialog({ label, onClose, busy = false, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const returnTo = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} aria-label={label} className={"public-dialog" + (wide ? " public-dialog-wide" : "")}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="public-dialog-bar"><span>Property Takeoff</span>
      <button type="button" disabled={busy} onClick={onClose} aria-label={"Close " + label}>Close</button>
    </header>
    {children}
  </dialog>;
}
