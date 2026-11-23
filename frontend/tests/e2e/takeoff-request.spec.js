import { expect, test } from "@playwright/test";

test("a customer sees the guided boundary-based quote workflow", async ({ page }) => {
  const email = `takeoff-test-${Date.now()}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Your name").fill("Takeoff Test User");
  await page.getByLabel("Company name").fill("Takeoff Test Company");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Takeoff-test-password-123");
  await page.locator(".account-access-consent input").check();
  await page.getByRole("button", { name: "Create free account" }).click();
  await page.getByRole("button", { name: "Request a Measurement Quote Instead" }).click();

  await page.getByLabel("Site or project name").fill("Fictional Commerce Center");
  await page.getByLabel("Property address").fill("1200 N Dupont Hwy, Dover, DE 19901");
  await page.getByRole("checkbox", { name: /Parking lots & plowable pavement/ }).check();
  await page.getByRole("checkbox", { name: /Sidewalks & walkways/ }).check();

  await expect(page.locator(".takeoff-boundary-status")).toContainText(/Property found|lookup is unavailable/);
  const mapCanvas = page.locator(".takeoff-boundary-map canvas").first();
  await expect(mapCanvas).toBeVisible();
  await mapCanvas.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Draw boundary" }).click();
  await expect(page.locator(".takeoff-boundary-status")).toContainText("Tap or click around the property");
  await expect(page.locator(".takeoff-boundary-area")).toContainText("Boundary not drawn");
  await expect(page.locator(".hd-takeoff-estimate")).toContainText("draw a boundary");
  await expect(page.getByRole("button", { name: "Complete Steps Above" })).toBeDisabled();
});
