// Tour entry/exit always navigates to a new document. Its disposable storage
// and API policy cannot be switched on a running customer workspace.
export const isGuestTour = typeof window !== "undefined" &&
  new URLSearchParams(window.location?.search).get("tour") === "1";

const buckets = new Map();
export function workspaceStorage(kind) {
  if (!isGuestTour) return window[kind];
  if (!buckets.has(kind)) {
    const values = new Map();
    buckets.set(kind, {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    });
  }
  return buckets.get(kind);
}
