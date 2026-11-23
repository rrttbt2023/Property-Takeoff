import { useEffect, useMemo, useState } from "react";

import {
  getTakeoffPricing,
  listTakeoffPricingVersions,
  saveTakeoffPricing,
} from "../api";

const PROPERTY_TYPES = [
  ["commercial_retail", "Commercial / retail"],
  ["industrial_warehouse", "Industrial / warehouse"],
  ["hoa_multifamily", "HOA / multifamily"],
  ["office_medical", "Office / medical"],
  ["school_campus", "School / campus"],
  ["municipal", "Municipal / public"],
  ["other", "Other"],
];

function dollars(cents) {
  return (Math.max(0, Number(cents) || 0) / 100).toFixed(2);
}

function toEditable(config) {
  return {
    property_rates_cents: Object.fromEntries(
      PROPERTY_TYPES.map(([key]) => [key, Number(config?.property_rates_cents?.[key]) || 0])
    ),
    base_review_cents: Number(config?.base_review_cents) || 0,
    additional_service_percent: Number(config?.additional_service_percent) || 0,
    partial_area_percent: Number(config?.partial_area_percent) || 0,
  };
}

export default function PricingAdminPanel() {
  const [config, setConfig] = useState(null);
  const [versions, setVersions] = useState([]);
  const [status, setStatus] = useState("loading");
  const [message, setMessage] = useState("");

  const load = async () => {
    setStatus("loading");
    setMessage("");
    try {
      const [current, history] = await Promise.all([
        getTakeoffPricing(),
        listTakeoffPricingVersions(12),
      ]);
      setConfig({ ...toEditable(current), ...current });
      setVersions(Array.isArray(history) ? history : []);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setMessage(error?.message || "Pricing settings could not be loaded.");
    }
  };

  useEffect(() => {
    let active = true;
    Promise.all([getTakeoffPricing(), listTakeoffPricingVersions(12)])
      .then(([current, history]) => {
        if (!active) return;
        setConfig({ ...toEditable(current), ...current });
        setVersions(Array.isArray(history) ? history : []);
        setStatus("ready");
      })
      .catch((error) => {
        if (!active) return;
        setStatus("error");
        setMessage(error?.message || "Pricing settings could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, []);

  const previewRows = useMemo(() => {
    if (!config) return [];
    const acres = 50;
    const services = 2;
    return PROPERTY_TYPES.map(([key, label]) => {
      const variable = Number(config.property_rates_cents?.[key] || 0) * acres;
      const multiplier = 1 + (Number(config.additional_service_percent || 0) / 100) * (services - 1);
      const full = Number(config.base_review_cents || 0) + variable * multiplier;
      const partial = Number(config.base_review_cents || 0) + variable * multiplier * (Number(config.partial_area_percent || 0) / 100);
      return { key, label, full, partial };
    });
  }, [config]);

  const setRate = (key, dollarsValue) => {
    setConfig((previous) => ({
      ...previous,
      property_rates_cents: {
        ...previous.property_rates_cents,
        [key]: Math.max(0, Math.round((Number(dollarsValue) || 0) * 100)),
      },
    }));
  };

  const save = async (event) => {
    event.preventDefault();
    setStatus("saving");
    setMessage("");
    try {
      const saved = await saveTakeoffPricing(toEditable(config));
      setConfig({ ...toEditable(saved), ...saved });
      setVersions(await listTakeoffPricingVersions(12));
      setStatus("ready");
      setMessage(`Pricing version ${saved.version} is active.`);
    } catch (error) {
      setStatus("error");
      setMessage(error?.message || "Pricing settings could not be saved.");
    }
  };

  if (status === "loading" && !config) {
    return <div className="hd-card hd-module-loading">Loading private pricing settings...</div>;
  }
  if (!config) {
    return <div className="hd-card hd-module-error"><strong>Pricing unavailable</strong><p>{message}</p><button className="hd-button hd-button-outline" type="button" onClick={() => void load()}>Try again</button></div>;
  }

  return (
    <section className="hd-pricing-admin">
      <form className="hd-card hd-pricing-form" onSubmit={save}>
        <div className="hd-module-heading">
          <div><small>Staff only</small><h3>Managed takeoff pricing</h3><p>Adjust quote inputs without changing or redeploying code. Customers only receive the resulting range.</p></div>
          <span>Version {config.version || 1}</span>
        </div>
        <div className="hd-pricing-rates">
          {PROPERTY_TYPES.map(([key, label]) => (
            <label key={key}><span>{label}</span><div><b>$</b><input aria-label={`${label} dollars per acre`} type="number" min="0" max="1000" step="0.05" value={dollars(config.property_rates_cents?.[key])} onChange={(event) => setRate(key, event.target.value)} /><small>/ acre</small></div></label>
          ))}
        </div>
        <div className="hd-pricing-controls">
          <label>Base review charge<div><b>$</b><input type="number" min="0" max="10000" step="5" value={dollars(config.base_review_cents)} onChange={(event) => setConfig((previous) => ({ ...previous, base_review_cents: Math.max(0, Math.round((Number(event.target.value) || 0) * 100)) }))} /></div></label>
          <label>Each additional area<input type="number" min="0" max="500" step="1" value={config.additional_service_percent} onChange={(event) => setConfig((previous) => ({ ...previous, additional_service_percent: Math.max(0, Number(event.target.value) || 0) }))} /><small>% of per-acre work</small></label>
          <label>Partial-property factor<input type="number" min="0" max="100" step="1" value={config.partial_area_percent} onChange={(event) => setConfig((previous) => ({ ...previous, partial_area_percent: Math.max(0, Number(event.target.value) || 0) }))} /><small>% of full-property work</small></label>
        </div>
        <div className="hd-pricing-actions"><span>{message || "Changes are recorded in pricing history."}</span><button type="submit" className="hd-button hd-button-primary" disabled={status === "saving"}>{status === "saving" ? "Saving..." : "Save Pricing Version"}</button></div>
      </form>

      <div className="hd-card hd-pricing-preview">
        <div className="hd-module-heading"><div><small>Instant check</small><h3>50-acre preview</h3><p>Two measurement areas selected. This preview does not create a customer quote.</p></div></div>
        <div className="hd-pricing-preview-grid">{previewRows.map((row) => <div key={row.key}><strong>{row.label}</strong><span>Full <b>${Math.round(row.full / 100).toLocaleString()}</b></span><span>Partial <b>${Math.round(row.partial / 100).toLocaleString()}</b></span></div>)}</div>
      </div>

      <details className="hd-card hd-pricing-history">
        <summary>Pricing version history ({versions.length})</summary>
        <div>{versions.length ? versions.map((version) => <article key={`${version.version}-${version.updated_at}`}><strong>Version {version.version}</strong><span>{version.updated_at ? new Date(version.updated_at).toLocaleString() : "Initial defaults"}</span><small>Saved by {version.updated_by || "staff"}</small></article>) : <p>No prior pricing versions yet.</p>}</div>
      </details>
    </section>
  );
}
