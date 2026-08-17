import { expect, test } from "@playwright/test";

test("enters the depot and starts a playable run", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Deadwave" })).toBeVisible();
  await page.getByTestId("start-mission").click();
  await expect(page.getByRole("heading", { name: "Choose your loadout" })).toBeVisible();
  await page.getByTestId("deploy").click();
  await expect(page.getByTestId("game-stage")).toBeVisible();
  await expect(page.getByTestId("hud-wave")).toContainText("01");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
});

test("restores banked progress from the local profile", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("deadwave.profile.v1", JSON.stringify({
      version: 1,
      coins: 777,
      ownedWeapons: ["pistol", "smg"],
      weaponRanks: { pistol: 2, smg: 1, shotgun: 1, rifle: 1 },
      perkRanks: { vitality: 1, mobility: 0, magnet: 0 },
      equippedLoadout: ["pistol", "smg"],
      settings: { music: false, sfx: false, reducedMotion: true },
      completedLevels: [],
      highestWave: 4,
    }));
  });
  await page.goto("/");
  await expect(page.getByText("◆ 777")).toBeVisible();
  await expect(page.getByText("Best wave").locator("..")).toContainText("4");
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
