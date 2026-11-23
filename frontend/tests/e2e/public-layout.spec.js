import { expect, test } from "@playwright/test";

const viewports = [[1366,768], [1280,720], [1024,768], [820,1180], [390,844], [375,667], [844,390]];

async function expectFit(surface) {
  await expect.poll(() => surface.evaluate(el =>
    Math.max(el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth)
  )).toBeLessThanOrEqual(1);
}

for (const [width,height] of viewports) {
  test(`public workflow fits ${width} x ${height} without scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const example = page.getByRole("region", {name:"Interactive example takeoff"});
    await example.getByRole("img").evaluate(img => img.decode());
    const screen = page.locator("html");
    await expectFit(screen);
    for (const choice of ["Measure it myself", "Request a measured takeoff"]) {
      const action = example.getByRole("button", {name:choice});
      await expect(action).toBeInViewport({ratio:1});
      await action.click();
      const signup = page.getByRole("dialog");
      await expectFit(signup);
      await expect(signup.locator("button[type=submit]")).toBeInViewport({ratio:1});
      await signup.getByRole("button", {name:/^Close /}).click();
    }
    await page.getByRole("button", {name:"Take a tour"}).click();
    const guide = page.getByRole("banner",{name:"Workspace tour"});
    await expect(guide).toBeInViewport({ratio:1});
    await expect(page.locator(".hd-main h1")).toHaveText("Project Dashboard");
    await guide.getByRole("button",{name:"Next step"}).click();
    await expect(page.locator(".map")).toBeVisible();
    await expect(guide.getByRole("button",{name:"Exit tour"})).toBeInViewport({ratio:1});
    await guide.getByRole("button",{name:"Exit tour"}).click();
    await expect(example).toBeVisible();
  });
}
