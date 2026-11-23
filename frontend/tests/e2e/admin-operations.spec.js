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
  await page.getByLabel("Search queue").fill("no-match-for-empty-queue-check");
  await expect(page.getByText("No requests match these filters.")).toBeVisible();

  await page.getByRole("button", { name: "Proposal Builder" }).click();
  await expect(page.getByRole("heading", { name: "Proposal Builder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print / Save PDF" })).toBeVisible();

  await page.getByRole("button", { name: "Recovery Center" }).click();
  await expect(page.getByRole("heading", { name: "Autosave Recovery Center" })).toBeVisible();
  await expect(page.getByText(/^Checkpoint history \(\d+\)$/)).toBeVisible();
});

test("staff can time a takeoff across reloads without delivering it", async ({ page, playwright }) => {
  const baseURL = "http://127.0.0.1:8010/api/";
  const staff = await playwright.request.newContext({ baseURL });
  const customer = await playwright.request.newContext({ baseURL });
  const title = `Timer test ${Date.now()}`;
  try {
    const login = await staff.post("auth/login", { data: { username: "e2e-staff", password: "e2e-staff-password-123" } });
    await expect(login).toBeOK();
    const register = await customer.post("auth/register", { data: {
      email: `timer-${Date.now()}@example.com`, display_name: "Customer", organization_name: "Test team",
      password: "e2e-timer-password-123", accepted_terms: true,
    } });
    await expect(register).toBeOK();
    const staffAuth = { Authorization: `Bearer ${(await login.json()).token}` };
    const customerAuth = { Authorization: `Bearer ${(await register.json()).token}` };
    const created = await customer.post("takeoff-requests", { headers: customerAuth, data: {
      title, address: "Test campus", property_type: "school_campus", service_types: ["Sidewalks"],
      boundary: { type: "Polygon", coordinates: [[[-75, 39], [-75.001, 39], [-75.001, 39.001], [-75, 39]]] },
    } });
    await expect(created).toBeOK();
    const path = `takeoff-requests/${(await created.json()).id}`;
    await expect(await staff.patch(path, { headers: staffAuth, data: { status: "quoted", quote_cents: 0 } })).toBeOK();
    await expect(await customer.post(`${path}/accept`, { headers: customerAuth })).toBeOK();

    await page.goto("/");
    await page.getByLabel("Email or username").fill("e2e-staff");
    await page.getByLabel("Password", { exact: true }).fill("e2e-staff-password-123");
    await page.getByRole("button", { name: "Sign in to Property Takeoff" }).click();
    const board = page.getByRole("button", { name: "Managed Takeoffs" });
    await board.click();
    const job = page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await job.getByRole("button", { name: "Start measuring" }).click();
    await expect(job.getByRole("timer")).not.toHaveText("00:00:00");
    await job.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(job.getByText("Paused", { exact: true })).toBeVisible();
    const paused = await job.getByRole("timer").innerText();
    await page.reload();
    await board.click();
    await expect(job.getByRole("timer")).toHaveText(paused);
    await job.getByRole("button", { name: "Resume" }).click();
    await job.getByRole("button", { name: "Complete measuring" }).click();
    await expect(job.getByRole("button", { name: "Deliver Project" })).toBeVisible();
    await page.getByText(/^Completed measuring times \(/).click();
    await expect(page.getByRole("row", { name: new RegExp(title) })).toContainText("Sidewalks");
  } finally {
    await staff.dispose();
    await customer.dispose();
  }
});
