import { devices, expect, test } from "@playwright/test";

async function createQuoteAccount(page, prefix) {
  const email = `${prefix}-${Date.now()}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Request a measured takeoff" }).click();
  await expect(page.getByRole("dialog", { name: "Takeoff quote signup" })).toBeVisible();
  await page.getByLabel("Your name").fill("Takeoff Test User");
  await page.getByLabel("Company name").fill("Takeoff Test Company");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Takeoff-test-password-123");
  await page.locator(".account-access-consent input").check();
  await page.getByRole("button", { name: "Create account & request quote" }).click();
  await expect(page.getByRole("heading", {name:"Request a measurement quote"})).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("a customer sees the guided boundary-based quote workflow", async ({ page }) => {
  await createQuoteAccount(page, "takeoff-test");

  await page.getByLabel("Site or project name").fill("Fictional Commerce Center");
  await page.getByLabel("Property address").fill("1200 N Dupont Hwy, Dover, DE 19901");
  await page.getByRole("checkbox", { name: /Parking lots & plowable pavement/ }).check();
  await page.getByRole("checkbox", { name: /Sidewalks & walkways/ }).check();
  await page.getByRole("radio", { name: /Only part of the property/ }).check();

  await expect(page.locator(".takeoff-boundary-status")).toContainText(/Property found|lookup is unavailable/);
  const mapCanvas = page.locator(".takeoff-boundary-map canvas").first();
  await expect(mapCanvas).toBeVisible();
  await expect(page.locator(".takeoff-boundary-toolbar").getByText("Google satellite", { exact: true })).toBeVisible({ timeout: 15_000 });
  await mapCanvas.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Draw boundary" }).click();
  await expect(page.locator(".takeoff-boundary-status")).toContainText("Tap or click around the property");
  const mapBounds = await mapCanvas.boundingBox();
  expect(mapBounds).toBeTruthy();
  const points = [
    [0.25, 0.25],
    [0.72, 0.25],
    [0.72, 0.7],
    [0.25, 0.7],
  ];
  for (const [x, y] of points) {
    await page.mouse.click(mapBounds.x + mapBounds.width * x, mapBounds.y + mapBounds.height * y);
  }
  await page.getByRole("button", { name: "Finish boundary" }).click();

  await expect(page.locator(".takeoff-boundary-area")).not.toContainText("Boundary not drawn");
  await expect(page.locator(".takeoff-boundary-map-shell")).toHaveAttribute("data-boundary-visible", "true");
  await expect(page.locator(".hd-takeoff-estimate")).not.toContainText("draw a boundary");
  await expect(page.locator(".hd-takeoff-estimate")).not.toContainText("/hr");
  await expect(page.locator(".hd-takeoff-estimate")).not.toContainText("virtual measuring hour");
  await expect(page.locator(".hd-takeoff-estimate")).toContainText("Partial area");
  await expect(page.getByRole("button", { name: "Submit Quote Request" })).toBeEnabled();
});

test("a touch customer can place and finish a quote boundary", async ({ browser }) => {
  const context = await browser.newContext({
    ...devices["iPad Pro 11"],
    baseURL: "http://127.0.0.1:5173",
  });
  const page = await context.newPage();
  try {
    await createQuoteAccount(page, "takeoff-touch-test");
    await page.getByLabel("Site or project name").fill("Touch Commerce Center");
    await page.getByLabel("Property address").fill("1200 N Dupont Hwy, Dover, DE 19901");
    await page.getByRole("checkbox", { name: /Parking lots & plowable pavement/ }).check();
    const mapCanvas = page.locator(".takeoff-boundary-map canvas").first();
    await mapCanvas.scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Draw boundary" }).click();
    const mapBounds = await mapCanvas.boundingBox();
    expect(mapBounds).toBeTruthy();
    for (const [x, y] of [[0.22, 0.25], [0.76, 0.25], [0.7, 0.72], [0.25, 0.68]]) {
      await page.touchscreen.tap(
        mapBounds.x + mapBounds.width * x,
        mapBounds.y + mapBounds.height * y
      );
    }
    await page.getByRole("button", { name: "Finish boundary" }).click();
    await expect(page.locator(".takeoff-boundary-area")).not.toContainText("Boundary not drawn");
    await expect(page.locator(".takeoff-boundary-map-shell")).toHaveAttribute("data-boundary-visible", "true");
    await expect(page.getByRole("button", { name: "Submit Quote Request" })).toBeEnabled();
  } finally {
    await context.close();
  }
});
