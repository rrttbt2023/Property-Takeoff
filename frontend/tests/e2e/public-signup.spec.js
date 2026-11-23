import { expect, test } from "@playwright/test";

test("a public customer can register and receives the membership offer", async ({ page }) => {
  const email = `launch-test-${Date.now()}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Your name").fill("Launch Test User");
  await page.getByLabel("Company name").fill("Launch Test Company");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Launch-test-password-123");
  await page.locator(".account-access-consent input").check();
  await page.getByRole("button", { name: "Create free account" }).click();

  await expect(page.getByRole("heading", { name: "Your workspace is ready." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Basic for $9.99/month" })).toBeVisible();
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem("takeoff-shared-auth-v1");
    return raw ? JSON.parse(raw) : {};
  });
  expect(stored.token || "").toBe("");
  expect(stored.csrfToken || "").toBe("");
  expect(stored.organizationId).toBeTruthy();
  const session = await page.evaluate(() => {
    const raw = sessionStorage.getItem("takeoff-shared-auth-session-v1");
    return raw ? JSON.parse(raw) : {};
  });
  expect(session.token).toBeTruthy();

  await page.reload();
  await expect(page.getByTitle("Log out")).toBeVisible();
});
