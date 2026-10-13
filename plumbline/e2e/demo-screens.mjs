// TEST ONLY. Demo screenshots of the web app (served by app/test/serve.mjs) against the seeded local validator,
// in headless Chromium from /opt/pw-browsers, at desktop (1440x900) and phone (390x844) sizes.
//   node demo-screens.mjs <app-url> <rpc-url> <seed.json> <bundle.json> <out-dir>
// seed.json is demo-seed.ts's output line. Fails unless each page shows what the shot is for.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [appUrl, rpc, seedFile, bundleFile, outDir] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(join(here, '../app/node_modules/playwright-core/index.mjs'));
const CHROME = ['/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-proxy-server'] });
const q = `rpc=${encodeURIComponent(rpc)}`;
const errors = [];
let failed = false;
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

async function waitText(page, needles, name) {
  await page.waitForFunction((n) => n.every((x) => document.body.innerText.includes(x)), needles, { timeout: 30000 })
    .catch(() => { failed = true; console.log(`FAIL ${name}: page does not show ${JSON.stringify(needles)}`); });
}

for (const [label, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'light', deviceScaleFactor: label === 'phone' ? 3 : 1, isMobile: label === 'phone', hasTouch: label === 'phone' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
  const shot = async (name) => {
    for (const full of [false, true]) {
      const file = `${name}-${label}${full ? '-full' : ''}.png`;
      await page.screenshot({ path: join(outDir, file), fullPage: full });
      console.log(`wrote ${file}`);
    }
  };

  // 1. bounty list with paid bounties shown
  await page.goto(`${appUrl}/index.html?${q}`, { waitUntil: 'networkidle' });
  await page.check('#show-paid');
  await page.waitForSelector(`[data-bounty="${seed.paid}"] .pill.paid`, { timeout: 30000 })
    .catch(() => { failed = true; console.log('FAIL list: paid bounty not shown as paid'); });
  await waitText(page, ['2 SOL', '0.75 SOL'], 'list');
  await shot('01-bounties');

  // 2. bounty detail: paid winner + leaderboard
  await page.goto(`${appUrl}/bounty.html?address=${seed.paid}&${q}`, { waitUntil: 'networkidle' });
  await waitText(page, ['Paid to', seed.payout, 'Leaderboard', 'winner'], 'bounty');
  await shot('02-bounty-paid');

  // 2b. the open 5/6 bounty: same scores, nobody qualifies yet
  await page.goto(`${appUrl}/bounty.html?address=${seed.open}&${q}`, { waitUntil: 'networkidle' });
  await waitText(page, ['Leaderboard', 'below target'], 'bounty-open');
  await shot('02b-bounty-open');

  // 3. verify page: the bundle behind the winning statement, checked in the browser, with the expected payout typed in
  await page.goto(`${appUrl}/verify.html?statement=${seed.statement}&${q}`, { waitUntil: 'networkidle' });
  await page.fill('#expect', seed.payout);
  await page.setInputFiles('#file', bundleFile);
  await waitText(page, ['Payout and onchain record', 'onchain payout matches the statement'], 'verify');
  await page.waitForTimeout(500);
  await shot('03-verify');
  const text = await page.locator('#result').innerText();
  console.log(`== verify (${label})\n` + text.split('\n').filter((l) => l.trim()).map((l) => '  | ' + l).join('\n'));
  await ctx.close();
}
await browser.close();
if (errors.length) { console.log('page errors:', errors); failed = true; }
console.log(failed ? 'DEMO SCREENS FAIL' : 'DEMO SCREENS OK');
process.exit(failed ? 1 : 0);
