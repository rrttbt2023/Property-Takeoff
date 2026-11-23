import { expect, test } from "@playwright/test";

test("staff can open pricing, operations, proposals, and recovery tools", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email or username").fill("e2e-staff");
  await page.getByLabel("Password", { exact: true }).fill("e2e-staff-password-123");
  await page.getByRole("button", { name: "Sign in to Property Takeoff" }).click();
  await expect(page.getByTitle("Log out")).toBeVisible();

  await page.getByRole("button", { name: "Admin Tools" }).click();
  await expect(page.getByRole("heading", { name: "Managed takeoff pricing" })).toBeVisible();
  const schoolRate = page.getByLabel("School / campus dollars per acre");
  await expect(schoolRate).toBeVisible();
  expect(Number(await schoolRate.inputValue())).toBeGreaterThan(0);
  await schoolRate.fill("1.10");
  await page.getByRole("button", { name: "Save Pricing Version" }).click();
  await expect(page.getByText(/Pricing version \d+ is active/)).toBeVisible();

  await page.getByRole("button", { name: "Managed Takeoffs" }).click();
  await expect(page.getByText("Waiting review")).toBeVisible();
  await expect(page.getByText("No requests match these filters.")).toBeVisible();

  await page.getByRole("button", { name: "Proposal Builder" }).click();
  await expect(page.getByRole("heading", { name: "Proposal Builder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print / Save PDF" })).toBeVisible();

  await page.getByRole("button", { name: "Recovery Center" }).click();
  await expect(page.getByRole("heading", { name: "Autosave Recovery Center" })).toBeVisible();
  await expect(page.getByText(/^Checkpoint history \(\d+\)$/)).toBeVisible();
});
