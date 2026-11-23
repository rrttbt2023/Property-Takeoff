export function readStartIntent() {
  const value = new URL(window.location.href).searchParams.get("start");
  return ["quote", "measure"].includes(value) ? value : "";
}

export function setStartIntent(value) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set("start", value);
  else url.searchParams.delete("start");
  window.history.replaceState(window.history.state, "", url);
}
