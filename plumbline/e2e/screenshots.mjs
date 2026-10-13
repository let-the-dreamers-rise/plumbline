// TEST ONLY. Opens the web app (served by app/test/serve.mjs) against the local validator in headless
// Chromium from /opt/pw-browsers and saves two screenshots; fails unless the pages show the paid winner.
//   node screenshots.mjs <app-url> <rpc-url> <bounty> <payout> <out-dir>
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [appUrl, rpc, bounty, payout, outDir] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(join(here, '../app/node_modules/playwright-core/index.mjs'));
const CHROME = ['/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, colorScheme: 'light' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const q = `rpc=${encodeURIComponent(rpc)}`;
let failed = false;

async function shot(url, file, mustContain) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction((needles) => needles.every((n) => document.body.innerText.includes(n)), mustContain, { timeout: 30000 })
    .catch(() => { failed = true; console.log(`FAIL ${file}: page does not show ${JSON.stringify(mustContain)}`); });
  await page.screenshot({ path: join(outDir, file), fullPage: true });
  const text = await page.evaluate(() => document.body.innerText);
  console.log(`== ${file} (${url.replace(/\?.*/, '')})`);
  console.log(text.split('\n').filter((l) => l.trim()).slice(0, 40).map((l) => '  | ' + l).join('\n'));
}

// list: paid bounties are hidden by default; tick "show paid bounties" and wait for our card marked paid
await page.goto(`${appUrl}/index.html?${q}`, { waitUntil: 'networkidle' });
await page.check('#show-paid');
const card = `[data-bounty="${bounty}"]`;
await page.waitForSelector(`${card} .pill.paid`, { timeout: 30000 })
  .catch(() => { failed = true; console.log('FAIL e2e-bounties.png: the bounty is not listed as paid'); });
await page.screenshot({ path: join(outDir, 'e2e-bounties.png'), fullPage: true });
console.log('== e2e-bounties.png (index.html, show paid bounties)');
console.log(((await page.locator(card).innerText().catch(() => '(card missing)'))).split('\n').filter((l) => l.trim()).map((l) => '  | ' + l).join('\n'));
await shot(`${appUrl}/bounty.html?address=${bounty}&${q}`, 'e2e-bounty.png', [payout.slice(0, 6)]);
await browser.close();
if (errors.length) { console.log('page errors:', errors); failed = true; }
console.log(failed ? 'SCREENSHOTS FAIL' : 'SCREENSHOTS OK');
process.exit(failed ? 1 : 0);
