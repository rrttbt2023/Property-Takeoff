import "maplibre-gl/dist/maplibre-gl.css";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

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
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
