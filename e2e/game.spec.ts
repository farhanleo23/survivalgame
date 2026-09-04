import { expect, test, type Page } from "@playwright/test";

const profileWith = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  coins: 0,
  ownedWeapons: ["pistol"],
  weaponRanks: { pistol: 1, smg: 1, shotgun: 1, rifle: 1 },
  perkRanks: { vitality: 0, mobility: 0, magnet: 0 },
  equippedLoadout: ["pistol"],
  settings: { music: false, sfx: false, reducedMotion: true, controlMode: "auto", graphicsMode: "auto" },
  completedLevels: [],
  highestWave: 1,
  ...overrides,
});

/**
 * Clear the current wave in QA mode and land on the armory.
 *
 * A cleared wave opens the synergy draft first and only reaches the armory once
 * a card is taken. These tests predate the draft and asserted the armory
 * directly, which is why they had been failing.
 */
const clearWaveToArmory = async (page: Page) => {
  await page.keyboard.press("k");
  const card = page.locator(".draft-perk-card").first();
  if (await card.count()) await card.click();
  await expect(page.getByRole("heading", { name: "Field armory" })).toBeVisible();
};

const seedProfile = async (page: Page, profile: ReturnType<typeof profileWith>) => {
  await page.addInitScript((value) => {
    localStorage.setItem("deadwave.profile.v1", JSON.stringify(value));
  }, profile);
};

test("enters the depot and starts a playable run", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Deadwave" })).toBeVisible();
  await page.getByTestId("start-mission").click();
  await expect(page.getByRole("heading", { name: "Choose your loadout" })).toBeVisible();
  await page.getByTestId("deploy").click();
  await expect(page.getByTestId("game-stage")).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("hud-wave")).toContainText("01", { timeout: 15_000 });
});

test("a narrow desktop viewport keeps keyboard and mouse controls", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto("/");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("mobile-controls")).toHaveCount(0);
  await expect(page.getByText("WASD", { exact: true })).toBeVisible();
});

test("dashes from a standstill toward the mouse without a movement key", async ({ page }) => {
  await page.goto("/?qa=1");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  const canvas = page.locator(".game-canvas");
  await expect(canvas).toHaveAttribute("data-player-x", /.+/);
  const rect = await canvas.boundingBox();
  if (!rect) throw new Error("Missing arena");
  await page.mouse.move(rect.x + rect.width * 0.65, rect.y + rect.height * 0.5);
  await page.keyboard.press("Space");
  await expect.poll(async () => canvas.evaluate((element) => Math.hypot(
    Number((element as HTMLElement).dataset.playerX), Number((element as HTMLElement).dataset.playerZ),
  ))).toBeGreaterThan(1.5);
});

test("releases the mouse trigger when the pointer is cancelled instead of released", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });

  const ammo = page.locator(".ammo-numbers strong");
  const before = Number(await ammo.innerText());
  await page.locator(".game-canvas").dispatchEvent("pointerdown", {
    pointerId: 3, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true, clientX: 640, clientY: 300,
  });
  await page.waitForTimeout(600);
  expect(Number(await ammo.innerText())).toBeLessThan(before);

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 3, pointerType: "mouse", bubbles: true }));
  });
  await page.waitForTimeout(200);
  const atCancel = Number(await ammo.innerText());
  await page.waitForTimeout(800);
  expect(Number(await ammo.innerText())).toBe(atCancel);
});

test("restores banked progress from the local profile", async ({ page }) => {
  await seedProfile(page, profileWith({
    coins: 777,
    ownedWeapons: ["pistol", "smg"],
    weaponRanks: { pistol: 2, smg: 1, shotgun: 1, rifle: 1 },
    perkRanks: { vitality: 1, mobility: 0, magnet: 0 },
    equippedLoadout: ["pistol", "smg"],
    highestWave: 4,
  }));
  await page.goto("/");
  await expect(page.getByText("◆ 777")).toBeVisible();
  await expect(page.getByText("Best wave").locator("..")).toContainText("4");
});

test("pauses on focus loss and resumes the same run", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByRole("heading", { name: "Paused" })).toBeVisible();
  await page.getByRole("button", { name: "Resume operation →" }).click();
  await expect(page.getByTestId("hud-wave")).toContainText("01");
});

test("does not charge for a refill when equipped ammunition is full", async ({ page }) => {
  await seedProfile(page, profileWith({ coins: 100 }));
  await page.goto("/?qa=1");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await clearWaveToArmory(page);

  await page.getByRole("button", { name: "Refill all ammo 20" }).click();
  await expect(page.getByText("Equipped weapon ammunition is already full.")).toBeVisible();
  await expect(page.getByText("◆ 100")).toBeVisible();
});

test("persists a purchased third weapon in loadout slot two", async ({ page }) => {
  await seedProfile(page, profileWith({
    coins: 1_000,
    ownedWeapons: ["pistol", "smg"],
    equippedLoadout: ["pistol", "smg"],
  }));
  await page.goto("/?qa=1");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await clearWaveToArmory(page);

  await page.getByRole("button", { name: "Acquire 280" }).click();
  await expect(page.getByText("Breach Shotgun added to your loadout.")).toBeVisible();
  await page.getByRole("button", { name: "Begin wave 2 →" }).click();
  await page.keyboard.press("2");
  await expect(page.locator(".weapon-hud")).toContainText("Breach Shotgun");

  const savedProfile = await page.evaluate(() => JSON.parse(localStorage.getItem("deadwave.profile.v1") ?? "{}"));
  expect(savedProfile).toMatchObject({
    coins: 720,
    ownedWeapons: ["pistol", "smg", "shotgun"],
    equippedLoadout: ["pistol", "shotgun"],
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Abandon run" }).click();
  await page.getByTestId("start-mission").click();
  await expect(page.getByRole("button", { name: /Equipped Breach Shotgun/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Owned Viper SMG/ })).toBeVisible();
});

test("advances from wave one through the victory and Level 2 teaser", async ({ page }) => {
  await page.goto("/?qa=1");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });

  for (let wave = 1; wave <= 10; wave += 1) {
    if (wave < 10) {
      await clearWaveToArmory(page);
      await page.getByRole("button", { name: `Begin wave ${wave + 1} →` }).click();
    } else {
      // The final wave goes straight to victory, with no draft or armory.
      await page.keyboard.press("k");
    }
  }

  await expect(page.getByRole("heading", { name: "Level 01 survived" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Downtown Hospital" })).toBeVisible();
});

test("spends banked salvage from the lobby armory without starting a run", async ({ page }) => {
  await seedProfile(page, profileWith({ coins: 900 }));
  await page.goto("/");
  await page.getByTestId("open-armory").click();
  await expect(page.getByRole("heading", { name: "Field armory" })).toBeVisible();
  // No run behind it, so there is nothing to refill.
  await expect(page.getByRole("button", { name: "Refill all ammo 20" })).toHaveCount(0);

  await page.getByRole("button", { name: "Acquire 180" }).click();
  await expect(page.getByText("Viper SMG added to your loadout.")).toBeVisible();
  await page.getByTestId("armory-continue").click();
  await expect(page.getByText("◆ 720")).toBeVisible();

  const savedProfile = await page.evaluate(() => JSON.parse(localStorage.getItem("deadwave.profile.v1") ?? "{}"));
  expect(savedProfile).toMatchObject({ coins: 720, ownedWeapons: ["pistol", "smg"], equippedLoadout: ["pistol", "smg"] });

  // The purchase is live on the next deployment.
  await page.getByTestId("start-mission").click();
  await expect(page.getByRole("button", { name: /Equipped Viper SMG/ })).toBeVisible();
});

test("shows a run summary on death and carries the tallies across a redeploy", async ({ page }) => {
  await page.goto("/?qa=1");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });

  // Spend some ammunition so the summary has something to count.
  await page.locator(".game-canvas").dispatchEvent("pointerdown", {
    pointerId: 3, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true, clientX: 640, clientY: 300,
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, pointerType: "mouse", button: 0, bubbles: true }));
  });

  await page.keyboard.press("j");
  const summary = page.getByTestId("run-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("Accuracy");
  await expect(summary).toContainText("Damage taken");
  await expect(summary).toContainText("Mission time");

  await page.getByTestId("redeploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await page.keyboard.press("j");
  await expect(page.getByTestId("run-summary")).toBeVisible();
  // Redeploying resumed the same run, so the clock did not restart from zero.
  await expect(page.getByTestId("run-summary")).not.toContainText("00:00");
});
