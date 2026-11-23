import { expect, test } from "@playwright/test";

test("reloads once when a stale Vercel module cannot be imported", async ({ page }) => {
  await page.addInitScript(() => {
    const count = Number(sessionStorage.getItem("module-recovery-navigation-count") || 0);
    sessionStorage.setItem("module-recovery-navigation-count", String(count + 1));
  });
  await page.goto("/");
  await page.evaluate(() => sessionStorage.removeItem("property-takeoff-module-recovery"));
  const before = Number(await page.evaluate(
    () => sessionStorage.getItem("module-recovery-navigation-count")
  ));

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.evaluate(() => {
      window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    }),
  ]);

  await expect.poll(() => page.evaluate(
    () => Number(sessionStorage.getItem("module-recovery-navigation-count"))
  )).toBe(before + 1);
  await expect(page.getByText("Measure confidently.")).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => Number(sessionStorage.getItem("property-takeoff-module-recovery")) > 0
  )).toBe(true);
});
