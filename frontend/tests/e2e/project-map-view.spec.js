import { expect, test } from "@playwright/test";
import { getProjectMapBounds } from "../../src/projects/projectMapView.js";
import { buildPropertyFrame, PREVIEW_WIDTH, PREVIEW_HEIGHT, tilesForFrame } from "../../src/projects/propertyPreview.js";

test("preview tiles and polygons use the same coordinates and fit the measured site, not a distant boundary", () => {
  const frame = buildPropertyFrame({ turf: [turf], mulch: [mulch] }, boundary);
  expect(frame.paths.length).toBe(3);
  const tiles = tilesForFrame(frame, { maxzoom: 19, template: "{z}/{x}/{y}" });
  expect(tiles.length).toBeLessThanOrEqual(24);
  const lat = 35.01 * Math.PI / 180;
  const x = (-83.01 + 180) / 360, y = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2;
  const n = 2 ** Math.min(19, frame.zoom);
  const tile = tiles.find(t => t.url.endsWith(`/${Math.floor(x * n)}/${Math.floor(y * n)}`));
  const [px, py] = frame.paths[0].d.match(/^M([\d.]+),([\d.]+)/).slice(1).map(Number);
  expect(px).toBeCloseTo(tile.left + (x * n % 1) * tile.size, 1);
  expect(py).toBeCloseTo(tile.top + (y * n % 1) * tile.size, 1);
  expect(px).toBeLessThan(PREVIEW_WIDTH);
  expect(py).toBeLessThan(PREVIEW_HEIGHT);
  expect(buildPropertyFrame({}, boundary).zoom).toBeLessThan(frame.zoom);
  expect(buildPropertyFrame({}, null)).toBeNull();
});

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
  await page.route("https://example.invalid/**", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#385332"/></svg>',
  }));
  await page.getByRole("button", { name: "Back to Home" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const preview = page.getByRole("img", { name: "Property satellite image with measured polygon outlines" });
  await expect(preview).toBeVisible();
  await expect(preview.locator("path")).toHaveCount(3);
  await expect(page.locator(".desk-aerial-caption a")).toContainText("MapTiler");
  await page.getByRole("button", { name: "Continue measuring" }).click();
  await expect.poll(checkCamera).toBe(true);
  await page.route("https://api.maptiler.com/tiles/satellite-v2/tiles.json*", route => route.abort());
  await page.getByRole("button", { name: "Back to Home" }).click();
  await expect(page.getByText("Imagery unavailable / Measured outline")).toBeVisible();
  await expect(page.getByRole("img", { name: "Measured project outline" }).locator("path")).toHaveCount(3);
});
