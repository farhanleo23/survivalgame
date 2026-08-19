import { expect, test, type Locator, type Page } from "@playwright/test";

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

async function dispatchTouch(
  target: Locator,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  identifier: number,
  point: { x: number; y: number } = { x: 0.5, y: 0.5 },
) {
  const rect = await target.boundingBox();
  if (!rect) throw new Error("Touch target has no layout box");
  const touch = {
    identifier,
    clientX: rect.x + rect.width * point.x,
    clientY: rect.y + rect.height * point.y,
    pageX: rect.x + rect.width * point.x,
    pageY: rect.y + rect.height * point.y,
    screenX: rect.x + rect.width * point.x,
    screenY: rect.y + rect.height * point.y,
  };
  const active = type === "touchstart" || type === "touchmove" ? [touch] : [];
  await target.dispatchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: active,
    targetTouches: active,
    changedTouches: [touch],
  });
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
  await expect(page.locator(".game-canvas")).toHaveAttribute("data-auto-aim-target", /.+/, { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Pause operation" })).toBeVisible();
  await expect(page.locator(".game-controls")).toHaveCount(0);

  const joystick = page.getByTestId("mobile-joystick");
  const startPosition = await page.locator(".game-canvas").evaluate((canvas) => ({
    x: Number((canvas as HTMLElement).dataset.playerX),
    z: Number((canvas as HTMLElement).dataset.playerZ),
  }));
  await dispatchTouch(joystick, "touchstart", 7, { x: 0.8, y: 0.25 });
  // A synthesized pointer cancellation must not terminate the native touch
  // contact that owns movement on a phone.
  await joystick.dispatchEvent("pointercancel", { pointerId: 7, pointerType: "touch", buttons: 0 });
  await expect(joystick.locator(".joystick-knob")).not.toHaveCSS("transform", "none");
  await page.waitForTimeout(750);
  const movedPosition = await page.locator(".game-canvas").evaluate((canvas) => ({
    x: Number((canvas as HTMLElement).dataset.playerX),
    z: Number((canvas as HTMLElement).dataset.playerZ),
  }));
  expect(Math.hypot(movedPosition.x - startPosition.x, movedPosition.z - startPosition.z)).toBeGreaterThan(1);

  // Movement and Fire must remain independent contacts.
  await dispatchTouch(joystick, "touchmove", 7, { x: 0.9, y: 0.2 });

  const fire = page.getByRole("button", { name: "Fire weapon with automatic aim" });
  const ammo = page.locator(".ammo-numbers strong");
  const reserve = page.locator(".ammo-numbers small");
  const ammoBeforeHold = Number(await ammo.innerText());
  await dispatchTouch(fire, "touchstart", 8);
  // Pointer cancellation is ignored for an active native touch hold.
  await fire.dispatchEvent("lostpointercapture", { pointerId: 8, pointerType: "touch", buttons: 1 });
  await fire.dispatchEvent("pointercancel", { pointerId: 8, pointerType: "touch", buttons: 0 });
  await expect(fire).toHaveClass(/is-held/);
  await expect(joystick.locator(".joystick-knob")).not.toHaveCSS("transform", "none");
  await page.waitForTimeout(750);
  const ammoAfterHold = Number(await ammo.innerText());
  expect(ammoAfterHold).toBeLessThanOrEqual(ammoBeforeHold - 2);
  await dispatchTouch(fire, "touchend", 8);
  await expect(fire).not.toHaveClass(/is-held/);
  await page.waitForTimeout(150);
  const ammoAtRelease = Number(await ammo.innerText());
  await page.waitForTimeout(400);
  expect(Number(await ammo.innerText())).toBe(ammoAtRelease);

  // A held contact should survive the intentional automatic-reload pause and
  // resume firing without requiring another tap.
  await dispatchTouch(fire, "touchstart", 9);
  await page.waitForTimeout(4_800);
  await expect(fire).toHaveClass(/is-held/);
  expect(Number((await reserve.innerText()).replace("/", ""))).toBeLessThan(72);
  expect(Number(await ammo.innerText())).toBeLessThan(12);
  await dispatchTouch(fire, "touchend", 9);
  await expect(fire).not.toHaveClass(/is-held/);
  await dispatchTouch(joystick, "touchend", 7, { x: 0.9, y: 0.2 });
  await expect(joystick.locator(".joystick-knob")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await page.waitForTimeout(300);
  const stoppedPosition = await page.locator(".game-canvas").evaluate((canvas) => ({
    x: Number((canvas as HTMLElement).dataset.playerX),
    z: Number((canvas as HTMLElement).dataset.playerZ),
  }));
  await page.waitForTimeout(400);
  const positionAfterRelease = await page.locator(".game-canvas").evaluate((canvas) => ({
    x: Number((canvas as HTMLElement).dataset.playerX),
    z: Number((canvas as HTMLElement).dataset.playerZ),
  }));
  expect(Math.hypot(positionAfterRelease.x - stoppedPosition.x, positionAfterRelease.z - stoppedPosition.z)).toBeLessThan(0.15);

  await page.getByRole("button", { name: "Pause operation" }).click();
  await expect(page.getByRole("heading", { name: "Operation paused" })).toBeVisible();
});

test("keeps the play field free of the trigger and releases a cancelled fire contact", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  await deploy(page);
  await expect(page.getByTestId("mobile-controls")).toBeVisible({ timeout: 15_000 });

  const ammo = page.locator(".ammo-numbers strong");
  const before = Number(await ammo.innerText());

  // A finger on the arena — the start of a drag, a stray thumb — is not the
  // trigger on touch. The FIRE button owns it.
  await page.locator(".game-canvas").dispatchEvent("pointerdown", {
    pointerId: 55, pointerType: "touch", button: 0, buttons: 1, isPrimary: true, clientX: 400, clientY: 120,
  });
  await page.waitForTimeout(900);
  expect(Number(await ammo.innerText())).toBe(before);

  // A FIRE contact the browser cancels instead of releasing must stop
  // shooting, not empty the magazine into the floor.
  const fire = page.getByRole("button", { name: "Fire weapon with automatic aim" });
  await dispatchTouch(fire, "touchstart", 21);
  await expect(fire).toHaveClass(/is-held/);
  await page.waitForTimeout(600);
  const spent = Number(await ammo.innerText());
  expect(spent).toBeLessThan(before);
  await dispatchTouch(fire, "touchcancel", 21);
  await expect(fire).not.toHaveClass(/is-held/);
  await page.waitForTimeout(200);
  const atRelease = Number(await ammo.innerText());
  await page.waitForTimeout(700);
  expect(Number(await ammo.innerText())).toBe(atRelease);
});

test("reaches the lobby when the browser blocks local storage", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("start-mission")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".boot-screen")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
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
    await page.keyboard.press(wave === 1 ? "l" : "k");
    if (wave < 10) {
      if (wave === 1) {
        const extractionCard = page.locator(".extraction-hud-card");
        await expect(extractionCard).toBeVisible();
        await expect(page.locator(".wave-announcement.extraction-announcement")).toBeHidden();
        await expect(extractionCard.locator(".extraction-mobile-status")).toHaveText("REACH CENTER");
        const extractionBox = await extractionCard.boundingBox();
        expect(extractionBox).not.toBeNull();
        expect(extractionBox?.height ?? 999).toBeLessThanOrEqual(44);
        expect(extractionBox?.width ?? 999).toBeLessThanOrEqual(300);
        expect(extractionBox?.y ?? 999).toBeLessThanOrEqual(24);
        await page.keyboard.press("m");
        await expect(extractionCard.locator(".extraction-mobile-status")).toContainText("HOLD");
      }
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
