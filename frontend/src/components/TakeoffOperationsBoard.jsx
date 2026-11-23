import { useEffect, useMemo, useState } from "react";

const ACTIVE_STATUSES = ["submitted", "reviewing", "quoted", "accepted", "in_progress"];
const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

function statusLabel(value) {
  return String(value || "submitted").replaceAll("_", " ");
}

function dueLabel(request, now) {
  if (!request?.due_at) return { text: "Starts after approval", overdue: false };
  const remaining = new Date(request.due_at).getTime() - now;
  if (!Number.isFinite(remaining)) return { text: "Due time unavailable", overdue: false };
  const hours = Math.abs(remaining) / 3_600_000;
  if (remaining < 0) return { text: `${hours.toFixed(hours < 10 ? 1 : 0)}h overdue`, overdue: true };
  if (hours < 1) return { text: `${Math.max(1, Math.ceil(hours * 60))}m remaining`, overdue: false };
  return { text: `${hours.toFixed(hours < 10 ? 1 : 0)}h remaining`, overdue: false };
}

export default function TakeoffOperationsBoard({
  requests = [],
  loading = false,
  onUpdate,
  onQuote,
  onDeliver,
}) {
  const [statusFilter, setStatusFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(Date.now());
  const [workingId, setWorkingId] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const sorted = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (Array.isArray(requests) ? requests : [])
      .filter((request) => statusFilter === "all" || (statusFilter === "active" ? ACTIVE_STATUSES.includes(request.status) : request.status === statusFilter))
      .filter((request) => !query || [request.title, request.address, request.organization_name, request.assigned_to].some((value) => String(value || "").toLowerCase().includes(query)))
      .sort((left, right) => {
        const priority = (PRIORITY_ORDER[left.priority] ?? 2) - (PRIORITY_ORDER[right.priority] ?? 2);
        if (priority) return priority;
        const leftDue = left.due_at ? new Date(left.due_at).getTime() : Number.MAX_SAFE_INTEGER;
        const rightDue = right.due_at ? new Date(right.due_at).getTime() : Number.MAX_SAFE_INTEGER;
        return leftDue - rightDue;
      });
  }, [requests, search, statusFilter]);

  const summary = useMemo(() => ({
    waiting: requests.filter((item) => ["submitted", "reviewing"].includes(item.status)).length,
    accepted: requests.filter((item) => ["accepted", "in_progress"].includes(item.status)).length,
    overdue: requests.filter((item) => item.due_at && new Date(item.due_at).getTime() < now && item.status !== "delivered").length,
    unassigned: requests.filter((item) => ACTIVE_STATUSES.includes(item.status) && !String(item.assigned_to || "").trim()).length,
  }), [now, requests]);

  const update = async (id, changes) => {
    setWorkingId(id);
    try {
      await onUpdate(id, changes);
    } finally {
      setWorkingId("");
    }
  };

  return (
    <section className="hd-ops-board">
      <div className="hd-ops-summary">
        <article><small>Waiting review</small><strong>{summary.waiting}</strong></article>
        <article><small>Accepted / measuring</small><strong>{summary.accepted}</strong></article>
        <article className={summary.overdue ? "danger" : ""}><small>Overdue</small><strong>{summary.overdue}</strong></article>
        <article className={summary.unassigned ? "warn" : ""}><small>Unassigned</small><strong>{summary.unassigned}</strong></article>
      </div>
      <div className="hd-card hd-ops-toolbar">
        <label><span>Search queue</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Property, customer, or assignee" /></label>
        <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="active">Active work</option><option value="all">All requests</option><option value="submitted">Submitted</option><option value="reviewing">Reviewing</option><option value="quoted">Quoted</option><option value="accepted">Accepted</option><option value="in_progress">In progress</option><option value="delivered">Delivered</option><option value="canceled">Canceled</option></select></label>
      </div>
      <div className="hd-ops-list">
        {sorted.length ? sorted.map((request) => {
          const due = dueLabel(request, now);
          const busy = workingId === request.id;
          return <article className={`hd-card hd-ops-card priority-${request.priority || "normal"}`} key={request.id}>
            <header><div><span className={`hd-takeoff-status status-${request.status}`}>{statusLabel(request.status)}</span><span className={`hd-ops-priority priority-${request.priority || "normal"}`}>{request.priority || "normal"}</span><h3>{request.title}</h3><p>{request.organization_name || "Customer workspace"} · {request.address}</p></div><div className={due.overdue ? "hd-ops-due overdue" : "hd-ops-due"}><small>24-hour SLA</small><strong>{due.text}</strong></div></header>
            <div className="hd-ops-meta"><span><small>Planning range</small><strong>${Math.round(Number(request.estimate_low_cents || 0) / 100).toLocaleString()}–${Math.round(Number(request.estimate_high_cents || 0) / 100).toLocaleString()}</strong></span><span><small>Final quote</small><strong>{request.quote_cents == null ? "Pending" : `$${(Number(request.quote_cents) / 100).toFixed(2)}`}</strong></span><span><small>Measured area</small><strong>{Number(request.estimated_square_feet || 0).toLocaleString()} sq ft</strong></span><span><small>Requested areas</small><strong>{request.service_types?.length || 0}</strong></span></div>
            <div className="hd-ops-controls">
              <label>Assignee<input defaultValue={request.assigned_to || ""} placeholder="Team member" onBlur={(event) => { const next = event.target.value.trim(); if (next !== String(request.assigned_to || "")) void update(request.id, { assigned_to: next }); }} /></label>
              <label>Priority<select value={request.priority || "normal"} onChange={(event) => void update(request.id, { priority: event.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
            </div>
            {request.notes ? <p className="hd-ops-notes"><strong>Customer notes:</strong> {request.notes}</p> : null}
            <footer>
              {request.status === "submitted" ? <button type="button" className="hd-button hd-button-outline" disabled={busy} onClick={() => void update(request.id, { status: "reviewing" })}>Start Review</button> : null}
              {["submitted", "reviewing", "quoted"].includes(request.status) ? <button type="button" className="hd-button hd-button-primary" disabled={busy} onClick={() => onQuote(request)}>Send Quote</button> : null}
              {request.status === "accepted" ? <button type="button" className="hd-button hd-button-primary" disabled={busy} onClick={() => void update(request.id, { status: "in_progress" })}>Start Measuring</button> : null}
              {request.status === "in_progress" ? <button type="button" className="hd-button hd-button-primary" disabled={busy} onClick={() => onDeliver(request)}>Deliver Project</button> : null}
              {!['delivered', 'canceled'].includes(request.status) ? <button type="button" className="hd-button hd-button-quiet" disabled={busy} onClick={() => void update(request.id, { status: "canceled" })}>Cancel</button> : null}
            </footer>
          </article>;
        }) : <div className="hd-card hd-empty-state"><span>{loading ? "Loading operations queue..." : "No requests match these filters."}</span></div>}
      </div>
    </section>
  );
}
