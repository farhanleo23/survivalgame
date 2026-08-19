import { expect, test, type Page } from "@playwright/test";

const mobileProfile = {
  version: 1,
  coins: 0,
  ownedWeapons: ["pistol"],
  weaponRanks: { pistol: 1, smg: 1, shotgun: 1, rifle: 1 },
  perkRanks: { vitality: 0, mobility: 0, magnet: 0 },
  equippedLoadout: ["pistol"],
  settings: { music: false, sfx: false, reducedMotion: true, controlMode: "auto", graphicsMode: "auto" },
  completedLevels: [],
  highestWave: 1,
  checkpointWave: 1,
  bestEndlessWave: 0,
};

async function seedMobileProfile(page: Page) {
  await page.addInitScript((profile) => {
    if (!localStorage.getItem("deadwave.profile.v1")) {
      localStorage.setItem("deadwave.profile.v1", JSON.stringify(profile));
    }
  }, mobileProfile);
}

async function deploy(page: Page) {
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
}

async function expectWithinViewport(page: Page, selector: string) {
  const fits = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= -1 && rect.left >= -1 && rect.bottom <= window.innerHeight + 1 && rect.right <= window.innerWidth + 1;
  });
  expect(fits).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await seedMobileProfile(page);
});

test("automatically presents touch instructions and omits the live lobby renderer", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("touch-control-summary")).toBeVisible();
  await expect(page.locator(".cover-panel")).toHaveCount(0);
  await expect(page.locator("main")).toHaveAttribute("data-input-mode", "touch");
});

test("blocks portrait combat, resumes in landscape, and exposes analog controls", async ({ page }) => {
  await page.goto("/");
  await deploy(page);
  await expect(page.getByRole("heading", { name: "Rotate to landscape" })).toBeVisible();

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole("heading", { name: "Rotate to landscape" })).toHaveCount(0);
  await expect(page.getByTestId("mobile-controls")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause operation" })).toBeVisible();
  await expect(page.locator(".game-controls")).toHaveCount(0);

  const joystick = page.getByTestId("mobile-joystick");
  const box = await joystick.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const pointer = { pointerId: 7, pointerType: "touch", isPrimary: true, buttons: 1 };
  await joystick.dispatchEvent("pointerdown", { ...pointer, clientX: box.x + box.width * 0.8, clientY: box.y + box.height * 0.25 });
  await expect(joystick.locator(".joystick-knob")).not.toHaveCSS("transform", "none");

  const fire = page.getByRole("button", { name: "Fire weapon with automatic aim" });
  await fire.dispatchEvent("pointerdown", { pointerId: 8, pointerType: "touch", buttons: 1 });
  await expect(joystick.locator(".joystick-knob")).not.toHaveCSS("transform", "none");
  await fire.dispatchEvent("pointerup", { pointerId: 8, pointerType: "touch" });
  await joystick.dispatchEvent("pointerup", { ...pointer, buttons: 0 });
  await expect(joystick.locator(".joystick-knob")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");

  await page.getByRole("button", { name: "Pause operation" }).click();
  await expect(page.getByRole("heading", { name: "Operation paused" })).toBeVisible();
});

test("persists a keyboard override on a touch device", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("group", { name: "Control mode" }).getByRole("button", { name: "Keyboard & Mouse" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-input-mode", "keyboard");
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("data-input-mode", "keyboard");

  const savedMode = await page.evaluate(() => JSON.parse(localStorage.getItem("deadwave.profile.v1") ?? "{}").settings?.controlMode);
  expect(savedMode).toBe("keyboard");
});

test("persists graphics quality and renders above one device pixel", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  await page.getByRole("group", { name: "Graphics quality" }).getByRole("button", { name: "Quality" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-graphics-mode", "quality");
  await deploy(page);

  const renderScale = await page.locator(".game-canvas").evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    return element.width / element.clientWidth;
  });
  expect(renderScale).toBeGreaterThanOrEqual(1.45);

  await page.getByRole("button", { name: "Pause operation" }).click();
  await page.getByRole("group", { name: "Graphics quality" }).getByRole("button", { name: "Performance" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-graphics-mode", "performance");
  const performanceScale = await page.locator(".game-canvas").evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    return element.width / element.clientWidth;
  });
  expect(performanceScale).toBeLessThanOrEqual(1.05);
});

test("keeps every run screen usable in a compact landscape viewport", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/?qa=1");
  await page.getByTestId("start-mission").click();
  await expect(page.getByRole("heading", { name: "Choose your loadout" })).toBeVisible();
  await page.getByTestId("deploy").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("deploy")).toBeVisible();
  await page.getByTestId("deploy").click();
  await expect(page.getByTestId("mobile-controls")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Pause operation" }).click();
  await expectWithinViewport(page, ".modal-panel");
  await page.getByRole("button", { name: "Resume operation →" }).click();

  await page.keyboard.press("j");
  await expect(page.getByRole("heading", { name: "M.I.A. in sector 01" })).toBeVisible();
  await expectWithinViewport(page, ".modal-panel");
  await page.getByTestId("redeploy").click();
  await expect(page.getByTestId("mobile-controls")).toBeVisible({ timeout: 15_000 });

  for (let wave = 1; wave <= 10; wave += 1) {
    await page.keyboard.press("k");
    if (wave < 10) {
      await expect(page.locator(".draft-modal-panel")).toBeVisible();
      await expectWithinViewport(page, ".draft-modal-panel");
      await page.locator(".draft-perk-card").first().click();
      await expect(page.getByRole("heading", { name: "Field armory & requisitions" })).toBeVisible();
      await expectWithinViewport(page, ".modal-panel");
      await page.getByRole("button", { name: `Begin wave ${wave + 1} →` }).scrollIntoViewIfNeeded();
      await page.getByRole("button", { name: `Begin wave ${wave + 1} →` }).click();
    }
  }

  await expect(page.getByRole("heading", { name: "Level 01 survived" })).toBeVisible();
  await expectWithinViewport(page, ".modal-panel");
});
