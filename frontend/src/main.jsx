import "maplibre-gl/dist/maplibre-gl.css";
import { setWorkerUrl } from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";

import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App.jsx";
import { isGuestTour } from "./tour/guestRuntime.js";
import GuestTour from "./tour/GuestTour";
import "./styles.css";

// The worker cannot infer its sibling URL after Vite bundles the map library.
setWorkerUrl(mapWorkerUrl);

const MODULE_RECOVERY_KEY = "property-takeoff-module-recovery";
let moduleReloadAttempted = false;
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  if (moduleReloadAttempted) return;
  moduleReloadAttempted = true;
  try {
    const previous = Number(window.sessionStorage.getItem(MODULE_RECOVERY_KEY) || 0);
    if (Date.now() - previous < 30_000) return;
    window.sessionStorage.setItem(MODULE_RECOVERY_KEY, String(Date.now()));
  } catch {
    // A reload still gives the browser a fresh module graph when storage is unavailable.
  }
  window.location.reload();
});

const sentryDsn = !isGuestTour && String(import.meta.env.VITE_SENTRY_DSN || "").trim();
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: String(import.meta.env.MODE || "production"),
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0.05),
    sendDefaultPii: false,
  });
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep stack in console for debugging while also showing a visible fallback UI.
    console.error("App crashed:", error, info);
    if (sentryDsn) {
      Sentry.captureException(error, { extra: { componentStack: info?.componentStack } });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0b0b0b",
          color: "#fff",
          padding: 20,
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
        }}
      >
        <h2 style={{ marginTop: 0 }}>App Runtime Error</h2>
        <p style={{ opacity: 0.85 }}>
          The app hit a client-side error. Copy this message and send it so it can be fixed quickly.
        </p>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "#141414",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            padding: 12,
          }}
        >
          {String(this.state.error?.message || this.state.error)}
        </pre>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      {isGuestTour ? <GuestTour /> : <App />}
    </AppErrorBoundary>
  </React.StrictMode>
);

if (!isGuestTour && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(
          registrations.map((registration) => registration.unregister().catch(() => false))
        )
      )
      .catch(() => []);

    if ("caches" in window) {
      window.caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith("pt-"))
              .map((key) => window.caches.delete(key).catch(() => false))
          )
        )
        .catch(() => []);
    }
  });
}
