import { chromium } from 'playwright';

const url = process.env.URL || 'http://localhost:3010/';
const out = process.env.OUT || 'visual-s1-dashboard.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('WROTE', out);
