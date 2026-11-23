import { expect, test } from "@playwright/test";
import { jsPDF } from "jspdf";
import { Buffer } from "node:buffer";

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

test("a visitor can try the actual application without sharing data or changing a saved project", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Take a tour" }).click();
  await expect(page).toHaveURL(/tour=1/);
  const api = [];
  const errors = [];
  page.on("request", req => { if (/\/api\//.test(new URL(req.url()).pathname)) api.push(req.method()); });
  page.on("pageerror", err => errors.push(err.message));
  const initialStorage = await page.evaluate(() => [JSON.stringify(localStorage),JSON.stringify(sessionStorage)]);
  await expect(page.locator(".hd-main h1")).toHaveText("Project Dashboard");
  await page.getByRole("button",{name:"Location Projects",exact:true}).click();
  await page.getByRole("button",{name:/Evergreen Office.*Location takeoff/}).click();
  await expect(page.locator(".sidebar")).toContainText("Active Editing Layer");
  await page.locator(".sidebar").getByRole("button",{name:"Mulch",exact:true}).click();
  const next = page.getByRole("button",{name:"Next step",exact:true});
  await next.click();
  await expect(page.getByRole("img",{name:"Evergreen service plan.pdf",exact:true})).toBeVisible();
  await page.locator('[data-tour-target="pen"][data-coached]').click();
  await expect(page.locator('[data-tour-target="sheet"][data-coached]')).toBeVisible();
  const sheet = await page.getByRole("img",{name:"Evergreen service plan.pdf"}).boundingBox();
  await page.mouse.move(sheet.x+sheet.width*.45,sheet.y+sheet.height*.55);
  await page.mouse.down();
  await page.mouse.move(sheet.x+sheet.width*.65,sheet.y+sheet.height*.65,{steps:6});
  await page.mouse.up();
  await expect(page.getByRole("button",{name:"Undo Last Markup"})).toBeEnabled();
  await next.click();
  await page.locator('[data-tour-target="project"][data-coached]').selectOption("tour-site");
  await expect(page.locator('[data-tour-target="unit-price"][data-coached]')).toBeVisible();
  await expect(page.getByText("Measured quantities loaded from the selected project.")).toBeVisible();
  await next.click();
  await expect(page.getByRole("heading",{name:"Managed Takeoffs",exact:true})).toBeVisible();
  await page.locator(".hd-takeoff-services input").first().check();
  await expect(page.getByRole("region",{name:"Property boundary map"})).toBeVisible();
  await page.locator('[data-tour-target="boundary-start"][data-coached]').click();
  const map = page.locator(".takeoff-boundary-map canvas");
  for (const [x,y] of [[80,70],[180,70],[160,150]]) await map.click({position:{x,y}});
  await page.locator('[data-tour-target="boundary-finish"][data-coached]').click();
  await expect(page.locator('[data-tour-target="boundary-done"][data-coached]')).toContainText("sq ft");
  await next.click();
  const finish = page.getByRole("dialog",{name:"Finish workspace tour"});
  await expect(finish).toBeVisible();
  expect(await page.evaluate(() => [JSON.stringify(localStorage),JSON.stringify(sessionStorage)])).toEqual(initialStorage);
  expect(api).toEqual([]);
  expect(errors).toEqual([]);
  await finish.getByRole("button",{name:/Sign up for the monthly plan/}).click();
  await expect(page.getByRole("dialog",{name:"Measuring membership signup"})).toBeVisible();
});

test("even on a shared device the guest tour never opens account data or recovery storage", async ({ page }) => {
  await page.addInitScript(() => {
    if (!new URLSearchParams(location.search).has("tour")) return;
    localStorage.setItem("takeoff-project-library-v1", JSON.stringify([{id:"private",projectName:"Private fixture",storageScope:"shared"}]));
    localStorage.setItem("takeoff-shared-auth-v1", JSON.stringify({authenticated:true,username:"Private fixture"}));
    const open = IDBFactory.prototype.open;
    window.recoveryOpens = 0;
    IDBFactory.prototype.open = function(name,...args) {
      if (name === "property-takeoff-recovery") window.recoveryOpens++;
      return open.call(this,name,...args);
    };
  });
  const api = [];
  await page.route("**/api/**", route => { api.push(route.request().method()); return route.abort(); });
  await page.goto("/?tour=1");
  await expect(page.locator(".hd-main")).toContainText("Evergreen Office");
  await expect(page.locator("body")).not.toContainText("Private fixture");
  await page.getByRole("button",{name:"Managed Takeoffs",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Managed Takeoffs",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Next step"}).click();
  expect(await page.evaluate(() => window.recoveryOpens)).toBe(0);
  expect(api).toEqual([]);
  await page.unroute("**/api/**");
  await page.getByRole("dialog").getByRole("button",{name:/Request a measured takeoff/}).click();
  await expect(page.getByRole("dialog",{name:"Takeoff quote signup"})).toBeVisible();
});

test("public comparison keeps the aerial fixed and independently toggles all four measured surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const demo = page.getByRole("region", { name: "Interactive example takeoff" });
  const aerial = demo.getByRole("img");
  await expect.poll(() => aerial.evaluate(img => img.complete && img.naturalWidth >= 900)).toBe(true);
  const overlay = demo.locator(".field-study-overlay");
  const sameFrame = () => demo.evaluate(node => {
    const photo = node.querySelector("img").getBoundingClientRect();
    const drawing = node.querySelector("svg").getBoundingClientRect();
    return ["x","y","width","height"].every(key => Math.abs(photo[key] - drawing[key]) < 1);
  });
  expect(await sameFrame()).toBe(true);
  const key = demo.getByRole("group", { name: "Measurement key" });
  for (const [label, layer] of [["Plowable pavement","pavement"], ["Sidewalks","sidewalks"], ["Turf","turf"], ["Mulch beds","mulch"]]) {
    const toggle = key.getByRole("button", {name: label});
    const surface = overlay.locator(`path[data-surface="${layer}"]`);
    await expect(surface).toHaveCount(1);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(surface).toHaveCount(0);
    await expect(overlay.locator("path[data-surface]")).toHaveCount(3);
    await toggle.click();
    await expect(surface).toHaveCount(1);
  }
  await demo.getByRole("slider").press("End");
  await expect(overlay.locator("clipPath rect")).toHaveAttribute("width", "0");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const access = page.getByRole("dialog", { name: "Account access" });
  await expect(access.getByLabel("Work email")).toBeVisible();
  await access.getByRole("button", { name: "Close Account access" }).click();
  await expect(key.getByRole("button", { name: "Mulch beds" })).toBeVisible();
  expect(await sameFrame()).toBe(true);
});

for (const [choice, destination] of [
  ["Measure it myself", "Plan & Billing"],
  ["Request a measured takeoff", "Managed Takeoffs"],
]) {
  test(choice + " keeps its destination after authentication", async ({ page }) => {
    let checkouts = 0;
    const fakeCheckout = "https://checkout.stripe.com/c/pay/example-only";
    await page.route("**/api/billing/checkout", route => {
      checkouts++;
      return route.fulfill({json: {url: fakeCheckout}});
    });
    await page.route(fakeCheckout, route => route.fulfill({contentType:"text/html", body:"Sandbox checkout"}));
    await page.goto("/");
    const slider = page.getByRole("slider");
    await slider.focus();
    await slider.press("Home");
    await expect(slider).toHaveAttribute("aria-valuetext", "100% measured overlay visible");
    await slider.press("End");
    await expect(slider).toHaveAttribute("aria-valuetext", "0% measured overlay visible");
    await page.getByRole("button", { name: choice }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
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
      await page.getByRole("button", { name: "Create account & continue to checkout" }).click();
      await expect(page).toHaveURL(fakeCheckout);
      expect(checkouts).toBe(1);
      await page.goto("/?billing=canceled");
      await expect(page.getByText(/Checkout was canceled/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Location Projects", exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole("heading", { name: destination, exact: true }).first()).toBeVisible();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(new URL(page.url()).searchParams.has("start")).toBe(false);
    expect(checkouts).toBe(choice === "Measure it myself" ? 1 : 0);
    if (choice === "Measure it myself") {
      await page.route("**/api/billing/checkout", route => route.fulfill({status: 503, json: { detail: "Checkout temporarily unavailable" }}));
      await page.getByRole("button", {name:"Start Basic for $9.99/month"}).click();
      await expect(page.getByRole("alert")).toContainText("Checkout temporarily unavailable");
      await page.goto("/?billing=success");
      await expect(page.getByText(/Waiting for subscription confirmation/)).toBeVisible();
      await expect(page.getByRole("button", {name:"Start measuring", exact:true})).toHaveCount(0);
      await page.route("**/api/billing/status", route => route.fulfill({json:{workspace_access:true, subscription_status:"active"}}));
      await page.getByRole("button", {name:"Refresh Status"}).click();
      await expect(page.getByRole("button", {name:"Start measuring", exact:true})).toBeVisible();
    }
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
