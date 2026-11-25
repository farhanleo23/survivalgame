import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
for (const mobile of [false, true]) {
 const page = await browser.newPage({ viewport:mobile?{width:844,height:390}:{width:1440,height:900}, isMobile:mobile, hasTouch:mobile });
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:3000');
 await page.getByTestId('start-mission').waitFor(); await page.waitForTimeout(2200);
 await page.screenshot({path:`artifacts/presentation/lobby-${mobile?'mobile':'desktop'}.png`});
 await page.getByTestId('start-mission').click();await page.screenshot({path:`artifacts/presentation/loadout-${mobile?'mobile':'desktop'}.png`});
 await page.getByTestId('deploy').click(); await page.locator('.game-canvas').waitFor();await page.waitForTimeout(4000);
 await page.screenshot({path:`artifacts/presentation/depot-${mobile?'mobile':'desktop'}.png`});
 console.log({mobile,errors});await page.close();
}
await browser.close();
