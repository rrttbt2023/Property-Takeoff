import { expect, test } from "@playwright/test";
import { getProjectMapBounds } from "../../src/projects/projectMapView.js";

function polygon(w, s, e, n) {
  return { type: "Feature", properties: {}, geometry: { type: "Polygon",
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  } };
}

const turf = polygon(-83.01, 35.01, -83.009, 35.011);
const second = polygon(-83.004, 35.008, -83.003, 35.009);
const mulch = { ...second, geometry: { type: "MultiPolygon", coordinates: [second.geometry.coordinates] } };
const boundary = polygon(-84, 34, -82, 36);

test("uses all measured polygon layers before the boundary, and leaves empty sites alone", () => {
  const measured = { turf: [{ ...turf, bbox: [0, 0, 1, 1] }], mulch: [mulch] };
  expect(getProjectMapBounds(measured, boundary)).toEqual([-83.01, 35.008, -83.003, 35.011]);
  expect(getProjectMapBounds(measured, null)).toEqual(getProjectMapBounds(measured, boundary));
  expect(getProjectMapBounds({ turf: [null, { geometry: { type: "Polygon", coordinates: [] } }] }, boundary))
    .toEqual([-84, 34, -82, 36]);
  expect(getProjectMapBounds({}, null)).toBeNull();
});

test("opening and resuming a saved project frame the measurements on the real map", async ({ page, request }) => {
  const api = "http://127.0.0.1:8010/api";
  const login = await request.post(api + "/auth/login", { data: {
    username: "e2e-staff", password: "e2e-staff-password-123",
  } });
  await expect(login).toBeOK();
  const id = "camera-test-" + Date.now();
  const name = "Measured campus " + id;
  const saved = await request.put(api + "/projects/" + id, {
    headers: { Authorization: "Bearer " + (await login.json()).token },
    data: { id, project_name: name, payload: {
      version: 2, projectName: name, workflowMode: "location", boundary,
      layerFeatures: { plowable: [], sidewalks: [], turf: [turf], mulch: [mulch] },
    } },
  });
  await expect(saved).toBeOK();
  // Hold tile metadata until after the camera is checked, then use an off-site
  // tile extent so rendering the saved GeoJSON never uses a real imagery account.
  let releaseTiles;
  const tileGate = new Promise((resolve) => { releaseTiles = resolve; });
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.route("https://api.maptiler.com/tiles/**/tiles.json*", async (route) => {
    await tileGate;
    await route.fulfill({ json: {
      tilejson: "2.2.0", tiles: ["https://example.invalid/{z}/{x}/{y}"], bounds: [0, 0, 0.01, 0.01],
    } });
  });
  await page.addInitScript(() => {
    let lib;
    Object.defineProperty(window, "mapboxgl", {
      configurable: true, get: () => lib, set: (next) => {
        if (next !== lib) {
          const add = next.Map.prototype.addControl;
          next.Map.prototype.addControl = function (...args) {
            window.testLocationMap = this;
            return add.apply(this, args);
          };
        }
        lib = next;
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("Email or username").fill("e2e-staff");
  await page.getByLabel("Password", { exact: true }).fill("e2e-staff-password-123");
  await page.getByRole("button", { name: "Sign in to Property Takeoff" }).click();
  await page.getByRole("button", { name: "All Projects", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  const checkCamera = () => page.evaluate(() => {
    const map = window.testLocationMap;
    if (!map || !map.getContainer().isConnected) return false;
    const bounds = map.getBounds();
    return bounds.contains([-83.01, 35.011]) && bounds.contains([-83.003, 35.008]) &&
      !bounds.contains([-84, 34]) && map.getZoom() > 12;
  });
  await expect.poll(checkCamera).toBe(true);
  releaseTiles();
  await expect.poll(() => page.evaluate(async () => {
    const map = window.testLocationMap;
    const source = map.getSource("polys-src");
    const features = (await source?.getData())?.features || [];
    const layers = !map.getLayer("polys-outline-line") ? [] : map.queryRenderedFeatures({ layers: ["polys-outline-line"] })
      .map((feature) => feature.properties.layer);
    return { saved: features.map((feature) => feature.properties.layer).sort(), rendered: [...new Set(layers)].sort() };
  })).toEqual({ saved: ["mulch", "turf"], rendered: ["mulch", "turf"] });
  await expect(page.getByText("Choose Measurement Mode", { exact: true })).not.toBeVisible();
  await page.evaluate(() => window.testLocationMap.jumpTo({ center: [-90, 38] }));
  await page.getByRole("checkbox", { name: "Dim outside boundary" }).click();
  await expect.poll(() => page.evaluate(() => window.testLocationMap.getCenter().lng)).toBeCloseTo(-90);
  await page.getByRole("button", { name: "Back to Home" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Measured project outline" })).toBeVisible();
  await page.getByRole("button", { name: "Continue measuring" }).click();
  await expect.poll(checkCamera).toBe(true);
});
