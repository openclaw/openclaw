// Agentic Visual QA — Playwright keyframe capture for Thinker Cafe
// Captures 5 keyframes at critical moments, validates state via __CAFE_STATE__
const { test, expect } = require('@playwright/test');
const path = require('path');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

const KEYFRAMES = [
  { name: 'intro-hold',   waitMs: 1500,  desc: 'Intro camera holding on Cruz/bar' },
  { name: 'intro-midpan', waitMs: 3500,  desc: 'Camera mid-pan between bar and door' },
  { name: 'player-door',  waitMs: 6000,  desc: 'Camera settled on player at door' },
  { name: 'player-bar',   action: 'walkToBar', desc: 'Player walked to bar area' },
  { name: 'corner-npc',   action: 'walkToCorner', desc: 'Player near corner table NPC' },
];

test('cafe smoke: tiles loaded, state exposed', async ({ page }) => {
  await page.goto('/cafe');

  // Wait for tile cache to populate (game fully initialized)
  await page.waitForFunction(
    () => window.__CAFE_STATE__?.tiles?.cacheKeys?.length > 0,
    { timeout: 15000 }
  );

  const state = await page.evaluate(() => window.__CAFE_STATE__);
  expect(state.tiles.cacheKeys.length).toBeGreaterThan(20);
  expect(state.camera).toBeDefined();
  expect(state.fps).toBeGreaterThan(0);
  expect(state.player).toBeDefined();
  expect(state.npcs.length).toBeGreaterThan(0);
});

test('cafe visual keyframes', async ({ page }) => {
  await page.goto('/cafe');

  // Wait for full initialization
  await page.waitForFunction(
    () => window.__CAFE_STATE__?.tiles?.cacheKeys?.length > 0,
    { timeout: 15000 }
  );

  for (const kf of KEYFRAMES) {
    if (kf.waitMs) {
      await page.waitForTimeout(kf.waitMs);
    }

    if (kf.action === 'walkToBar') {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(3000);
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(500);
    }

    if (kf.action === 'walkToCorner') {
      await page.keyboard.down('ArrowLeft');
      await page.waitForTimeout(1500);
      await page.keyboard.up('ArrowLeft');
      await page.waitForTimeout(500);
    }

    // Capture screenshot
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${kf.name}.png`),
      fullPage: false,
    });

    // Log state at this keyframe for the evaluation agent
    const state = await page.evaluate(() => window.__CAFE_STATE__);
    console.log(`[${kf.name}] fps=${state.fps} camera.scale=${state.camera.scale} intro=${state.camera.introActive} player=(${state.player.tileX},${state.player.tileY}) npcs=${state.npcs.length}`);
  }
});
