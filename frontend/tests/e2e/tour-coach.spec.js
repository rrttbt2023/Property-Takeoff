import { expect, test } from "@playwright/test";

const highlighted = (page,id) => page.locator(`[data-tour-target="${id}"][data-coached]`);

test("Draw waits for the map input handlers even if the sample aerial is slow", async ({page}) => {
  let holdImage = false, release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  await page.route("**/*field-study-aerial*.jpg*", async route => {
    if (holdImage) { started(); await gate; }
    await route.continue();
  });
  await page.setViewportSize({width:1366,height:840});
  await page.goto("/?tour=1");
  holdImage = true;
  try {
    await highlighted(page,"open-site").click();
    await requested;
    await expect(page.getByRole("button",{name:"Draw Mode (P)",exact:true})).toBeDisabled();
    await expect(highlighted(page,"draw")).toHaveCount(0);
  } finally { release(); }
  await highlighted(page,"draw").click();
  await page.locator(".map canvas").click({position:{x:140,y:220}});
  await expect(page.getByRole("note")).toContainText("Place corner 2");
});

test("desktop coach follows committed corners, not pointer moves or sample polygons", async ({page}) => {
  await page.setViewportSize({width:1366,height:840});
  await page.goto("/?tour=1");
  await highlighted(page,"open-site").click();
  await highlighted(page,"draw").click();
  const canvas = page.locator(".map canvas");
  const result = page.getByRole("status",{name:"Your polygon measurement"});
  await expect(highlighted(page,"trace")).toHaveAttribute("data-tour-count","0");
  await canvas.hover({position:{x:160,y:170}});
  await expect(page.getByRole("note")).toContainText("Place corner 1");
  await expect(result).toHaveCount(0);
  for (const [index,xy] of [[140,220],[290,210],[275,320]].entries()) {
    await canvas.click({position:{x:xy[0],y:xy[1]}});
    if (index<2) await expect(page.getByRole("note")).toContainText("Place corner "+(index+2));
  }
  await highlighted(page,"finish").click();
  await expect(highlighted(page,"result")).toContainText(/sq ft.*ac/);
  const squareFeet = async () => Number((await result.innerText()).match(/([\d,]+) sq ft/)[1].replaceAll(",",""));
  const first = await squareFeet();
  expect(first).toBeGreaterThan(0);
  await page.getByRole("button",{name:"Draw Mode (P)",exact:true}).click();
  await expect(result).toHaveCount(0);
  // Same map scale, half-length sides: a freshly computed area should be one quarter.
  for (const [x,y] of [[160,240],[235,235],[227.5,290]]) await canvas.click({position:{x,y}});
  await highlighted(page,"finish").click();
  await expect(highlighted(page,"result")).toBeVisible();
  expect((await squareFeet())/first).toBeCloseTo(.25,1);
  await page.getByRole("button",{name:"Draw Mode (P)",exact:true}).click();
  await expect(result).toHaveCount(0);
  await canvas.click({position:{x:180,y:235}});
  await page.keyboard.press("Escape");
  await expect(highlighted(page,"draw")).toBeVisible();
  await expect(result).toHaveCount(0);
  await page.getByRole("button",{name:"Hide tips"}).click();
  await expect(page.locator("[data-coached]")).toHaveCount(0);
  await page.getByRole("button",{name:"Show tips"}).click();
  await expect(highlighted(page,"draw")).toBeVisible();
});

test.describe("touch devices", () => {
test.use({hasTouch:true});
test("small-screen coach measures using the actual map and crosshair buttons", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto("/?tour=1");
  await highlighted(page,"open-site").click();
  await highlighted(page,"draw").tap();
  const add = highlighted(page,"add-point");
  const canvas = page.locator(".map canvas");
  await add.tap();
  await add.tap();
  await expect(page.getByRole("note")).toContainText("Place corner 2");
  async function pan(dx,dy) {
    await canvas.evaluate(async (el,[dx,dy]) => {
      const box = el.getBoundingClientRect();
      const start = [box.left+box.width*.35,box.top+box.height*.4];
      const dispatch = (type,t) => {
        const touch = {identifier:1,target:el,clientX:start[0]+t*dx,clientY:start[1]+t*dy};
        const touches = type==="touchend" ? [] : [touch];
        // WebKit does not expose a constructible Touch. Deliver the same
        // touch lists to the real map handlers one animation frame at a time.
        el.dispatchEvent(Object.assign(new Event(type,{bubbles:true,cancelable:true}),
          {touches,targetTouches:touches,changedTouches:[touch]}));
      };
      dispatch("touchstart",0);
      for (let n=1;n<=6;n++) {
        await new Promise(requestAnimationFrame);
        dispatch("touchmove",n/6);
      }
      dispatch("touchend",1);
    },[dx,dy]);
  }
  await pan(48,0);
  await add.tap();
  await pan(0,48);
  await add.tap();
  await highlighted(page,"finish").tap();
  await expect(highlighted(page,"result")).toContainText(/sq ft.*ac/);
  await expect(page.getByRole("note")).toContainText("Your polygon is measured");
  const box = await page.getByRole("note").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(390);
  await page.getByRole("button",{name:"Next step"}).click();
  await expect(page.getByRole("img",{name:"Evergreen service plan.pdf"})).toBeVisible();
});
});
