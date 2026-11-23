import { expect, test } from "@playwright/test";
import { jsPDF } from "jspdf";
import { Buffer } from "node:buffer";

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

for (const [choice, destination] of [
  ["Measure it myself", "Plan & Billing"],
  ["Request a measured takeoff", "Managed Takeoffs"],
]) {
  test(choice + " keeps its destination after authentication", async ({ page }) => {
    await page.goto("/");
    const slider = page.getByRole("slider");
    await slider.focus();
    await slider.press("Home");
    await expect(slider).toHaveAttribute("aria-valuetext", "100% measured overlay visible");
    await slider.press("End");
    await expect(slider).toHaveAttribute("aria-valuetext", "0% measured overlay visible");
    await page.getByRole("button", { name: choice }).click();
    if (choice === "Request a measured takeoff") {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByLabel("Email or username").fill("e2e-staff");
      await page.getByLabel("Password", { exact: true }).fill("e2e-staff-password-123");
      await page.getByRole("button", { name: "Sign in to Property Takeoff" }).click();
    } else {
      await page.getByLabel("Your name").fill("Example Estimator");
      await page.getByLabel("Company name").fill("Example Services");
      await page.getByLabel("Work email").fill(`desk-${Date.now()}@example.com`);
      await page.getByLabel("Password", { exact: true }).fill("Example-password-123");
      await page.locator(".account-access-consent input").check();
      await page.getByRole("button", { name: "Create free account" }).click();
    }
    await expect(page.getByRole("heading", { name: destination, exact: true }).first()).toBeVisible();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(new URL(page.url()).searchParams.has("start")).toBe(false);
  });
}

test("portrait field desk switches scenes and opens its two-column folders", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email or username").fill("e2e-staff");
  await page.getByLabel("Password", { exact: true }).fill("e2e-staff-password-123");
  await page.getByRole("button", { name: "Sign in to Property Takeoff" }).click();
  const folders = page.locator(".hd-dashboard-folder-grid");
  await expect(folders).toBeVisible();
  expect(await folders.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(2);
  const scene = page.locator(".desk-scene");
  const first = await scene.evaluate((el) => getComputedStyle(el).backgroundImage);
  await page.locator(".hd-theme-toggle").click();
  await expect.poll(() => scene.evaluate((el) => getComputedStyle(el).backgroundImage)).not.toBe(first);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await folders.getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: "Location Projects", exact: true }).first()).toBeVisible();
});

test("the resume card previews the marked sheet of an imported PDF", async ({ page }) => {
  const pdf = new jsPDF();
  pdf.text("Cover", 20, 20);
  pdf.addPage();
  pdf.text("Work area", 20, 20);
  const bytes = Buffer.from(pdf.output("arraybuffer"));
  const payload = {
    version: 2, projectName: "Fictional sheet test", workflowMode: "pdf",
    pdfPageNumber: 1, pdfPageCount: 2, pdfSourceName: "study.pdf",
    pdfSourceAsset: { name: "study.pdf", type: "application/pdf", kind: "pdf", size: bytes.length, lastModified: 1, base64: bytes.toString("base64") },
    pdfAnnotations: [{ type: "Feature", properties: { pdfPageNumber: 2, kind: "pen", color: "#ec144e", width: 5 },
      geometry: { type: "LineString", coordinates: [[100,100],[500,600]] } }],
    layerFeatures: { plowable: [], sidewalks: [], turf: [], mulch: [] },
  };
  await page.goto("/");
  await page.getByLabel("Email or username").fill("e2e-staff");
  await page.getByLabel("Password", { exact: true }).fill("e2e-staff-password-123");
  await page.getByRole("button", { name: "Sign in to Property Takeoff" }).click();
  await page.getByRole("button", { name: "Import Project", exact: true }).click();
  await page.locator('input[type=file][accept*="json"]').setInputFiles({
    name: "fictional.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)),
  });
  await page.getByRole("button", { name: "Back to Home" }).click();
  const sheet = page.getByRole("img", { name: "Saved plan with markups, page 2" });
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate(async (img) => {
    await img.decode();
    return (await (await fetch(img.src)).text()).includes("#ec144e");
  })).toBe(true);
});
