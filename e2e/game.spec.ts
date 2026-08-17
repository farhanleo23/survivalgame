import { expect, test, type Page } from "@playwright/test";

const profileWith = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  coins: 0,
  ownedWeapons: ["pistol"],
  weaponRanks: { pistol: 1, smg: 1, shotgun: 1, rifle: 1 },
  perkRanks: { vitality: 0, mobility: 0, magnet: 0 },
  equippedLoadout: ["pistol"],
  settings: { music: false, sfx: false, reducedMotion: true },
  completedLevels: [],
  highestWave: 1,
  ...overrides,
});

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

test("renders the visual systems gallery without runtime errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/?visualqa=1");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  const canvas = page.locator('canvas[data-visual-mode="gallery"]');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Visual systems gallery")).toBeVisible();
  expect(errors).toEqual([]);
});

test("renders a stable 36-hostile graphics stress scene", async ({ page }) => {
  await page.goto("/?stress=1");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator('canvas[data-visual-mode="stress"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("36 hostiles")).toBeVisible();
  await expect(page.getByText("Juggernaut")).toBeVisible();
  await expect(page.getByRole("heading", { name: "The depot claimed another survivor" })).toHaveCount(0);
});

test("does not charge for a refill when equipped ammunition is full", async ({ page }) => {
  await seedProfile(page, profileWith({ coins: 100 }));
  await page.goto("/?qa=1");
  await page.getByTestId("start-mission").click();
  await page.getByTestId("deploy").click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("k");
  await expect(page.getByRole("heading", { name: "Field armory" })).toBeVisible();

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
  await page.keyboard.press("k");
  await expect(page.getByRole("heading", { name: "Field armory" })).toBeVisible();

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
    await page.keyboard.press("k");
    if (wave < 10) {
      await expect(page.getByRole("heading", { name: "Field armory" })).toBeVisible();
      await page.getByRole("button", { name: `Begin wave ${wave + 1} →` }).click();
    }
  }

  await expect(page.getByRole("heading", { name: "Level 01 survived" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Downtown Hospital" })).toBeVisible();
});
