// Headless check that every page loads, renders chain data served by a stubbed RPC, works at phone width
// and in dark mode, and refuses mainnet. Chromium comes from /opt/pw-browsers (no download).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { b58encode, DISC } from '../js/layout.js';
import { PROGRAMS } from '../js/config.js';
import { serve } from './serve.mjs';

const CHROME = ['/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

// ---------- borsh encoders for the stubbed accounts ----------
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const h = (s) => Buffer.from(s, 'hex');
const key = () => randomBytes(32);
const sha = (b) => createHash('sha256').update(b).digest();

function bountyData(o) {
  return Buffer.concat([Buffer.from(DISC.Bounty), o.sponsor, u64(o.nonce), h(o.suite), u32(o.minCorrect), u32(o.minTotal), u64(o.amount),
    Buffer.from([0]), u64(o.deadline), u64(o.grace), Buffer.from([0]), Buffer.alloc(32), Buffer.alloc(32), u64(o.created),
    Buffer.from([o.paid ? 1 : 0]), o.paid ? h(o.winnerStatement) : Buffer.alloc(32), Buffer.alloc(32), o.paid ? o.winnerPayout : Buffer.alloc(32),
    u64(o.paid ? 900 : 0), Buffer.from([254])]);
}
function scoreData(o) {
  return Buffer.concat([Buffer.from(DISC.VerifiedScore), h(o.statement), Buffer.alloc(32), h(o.suite), Buffer.alloc(32), Buffer.alloc(48),
    Buffer.alloc(32), Buffer.alloc(16), Buffer.alloc(32), u32(o.correct), u32(o.total), Buffer.from([1]), Buffer.alloc(32), Buffer.from([1]),
    key(), u64(o.slot), u64(1760000000), o.payout, Buffer.from([255])]);
}

// ---------- a bundle whose report_data binds its statement (stub quote: fails only the Intel check) ----------
const SUITE = '7c'.repeat(32);
const payoutKey = key();
const statement = { challenge: 'e6'.repeat(32), correct: 5, enclave_pubkey: '0a'.repeat(32), marks_sha256: '00'.repeat(32), model_id: 'org/tiny',
  model_revision: 'ab'.repeat(20), n: 6, payout: payoutKey.toString('hex'), suite_commitment: SUITE, suite_id: 's1', v: 'tessera-score-1', weights_sha256: 'cd'.repeat(32) };
const canon = Buffer.from(JSON.stringify(statement)); // keys already sorted, ASCII only: equals Python's canonical()
const statementHash = sha(canon).toString('hex');
const quote = (rd) => { const q = Buffer.alloc(48 + 584 + 4 + 64); q.writeUInt16LE(4, 0); q.writeUInt16LE(2, 2); q.writeUInt32LE(0x81, 4); rd.copy(q, 48 + 520); return q.toString('hex'); };
const bind = sha(Buffer.concat([Buffer.from('tessera:score:v1'), canon]));
const bundle = { statement, statement_sha256: statementHash, key_release: { quote: quote(Buffer.alloc(32)), event_log: '[]', report_data: '00' },
  score: { quote: quote(bind), event_log: '[]', report_data: bind.toString('hex') } };

const openAddr = b58encode(key()), paidAddr = b58encode(key());
const otherStatement = 'aa'.repeat(32), otherPayout = key();
const accounts = {
  bounties: [
    { pubkey: openAddr, data: bountyData({ sponsor: key(), nonce: 1, suite: SUITE, minCorrect: 2, minTotal: 3, amount: 1_500_000_000, deadline: 5000, grace: 100, created: 100 }) },
    { pubkey: paidAddr, data: bountyData({ sponsor: key(), nonce: 2, suite: SUITE, minCorrect: 1, minTotal: 2, amount: 250_000_000, deadline: 5000, grace: 0, created: 50,
      paid: true, winnerStatement: otherStatement, winnerPayout: otherPayout }) },
  ],
  scores: [
    { pubkey: b58encode(key()), data: scoreData({ statement: otherStatement, suite: SUITE, correct: 4, total: 6, slot: 300, payout: otherPayout }) },
    { pubkey: b58encode(key()), data: scoreData({ statement: statementHash, suite: SUITE, correct: 5, total: 6, slot: 400, payout: payoutKey }) },
    { pubkey: b58encode(key()), data: scoreData({ statement: 'bb'.repeat(32), suite: SUITE, correct: 1, total: 6, slot: 200, payout: key() }) },
  ],
};

let server, base, browser, tmp, rpcCalls = 0;
const enc = (a) => ({ pubkey: a.pubkey, account: { data: [a.data.toString('base64'), 'base64'], lamports: 1_501_000_000, owner: '', executable: false, rentEpoch: 0 } });

async function stubRpc(page) {
  await page.route((u) => u.port === '8899' || /devnet/.test(u.hostname), async (route) => {
    rpcCalls++;
    const req = JSON.parse(route.request().postData());
    let result;
    if (req.method === 'getSlot') result = 1234;
    else if (req.method === 'getProgramAccounts') {
      const [program, cfg] = req.params;
      const pool = program === PROGRAMS.bounty ? accounts.bounties : accounts.scores;
      result = pool.filter((a) => cfg.filters.every((f) => {
        const want = Buffer.from(bs58decode(f.memcmp.bytes));
        return a.data.subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want);
      })).map(enc);
    } else if (req.method === 'getAccountInfo') {
      const a = accounts.bounties.find((b) => b.pubkey === req.params[0]);
      result = { context: { slot: 1234 }, value: a ? { ...enc(a).account, owner: PROGRAMS.bounty } : null };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
}
function bs58decode(s) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return out;
}

async function open(path, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1100, height: 900 }, colorScheme: opts.colorScheme ?? 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await stubRpc(page);
  await page.goto(base + path);
  return { page, errors, close: () => ctx.close() };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

before(async () => {
  assert.ok(CHROME, 'Chromium not found under /opt/pw-browsers');
  server = await serve(0);
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: CHROME });
  tmp = mkdtempSync(join(tmpdir(), 'plumbline-app-'));
});
after(async () => { await browser?.close(); server?.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('app pages', () => {
  it('bounties page lists open bounties from getProgramAccounts', async () => {
    const { page, errors, close } = await open('index.html');
    await page.waitForSelector('[data-bounty]');
    assert.equal(await page.locator('[data-bounty]').count(), 1);
    assert.match(await page.locator(`[data-bounty="${openAddr}"]`).innerText(), /1\.5 SOL[\s\S]*2\/3/);
    await page.check('#show-paid');
    assert.equal(await page.locator('[data-bounty]').count(), 2);
    assert.equal(await page.title(), 'Plumbline Bounties');
    assert.deepEqual(errors, []);
    await close();
  });

  it('bounty detail shows terms and a sorted leaderboard with payouts, slots and proof links', async () => {
    const { page, errors, close } = await open(`bounty.html?address=${paidAddr}`);
    await page.waitForSelector('table.board');
    const rows = await page.locator('table.board tbody tr').evaluateAll((trs) => trs.map((tr) => [tr.dataset.statement, tr.className, tr.innerText]));
    assert.deepEqual(rows.map((r) => r[0]), [statementHash, otherStatement, 'bb'.repeat(32)]); // 5/6, 4/6, 1/6
    assert.equal(rows[1][1], 'winner');
    assert.match(rows[0][2], /5\/6/);
    assert.match(await page.locator('#terms').innerText(), new RegExp(`Paid to[\\s\\S]*${b58encode(otherPayout)}`));
    assert.ok(await page.locator('table.board a[href*="explorer.solana.com/address/"]').count() >= 6);
    assert.match(await page.locator('#cmds').innerText(), /plumbline claim/);
    assert.deepEqual(errors, []);
    await close();
    // the open bounty: 5/6 and 4/6 meet 2/3 and were recorded after its creation; 1/6 is below target
    const o = await open(`bounty.html?address=${openAddr}`);
    await o.page.waitForSelector('table.board');
    const claim = await o.page.locator('td[data-label="Claim"]').allInnerTexts();
    assert.deepEqual(claim, ['yes', 'yes', 'below target']);
    await o.close();
  });

  it('verify page checks a dropped bundle in the browser and compares the payout', async () => {
    const f = join(tmp, 'bundle-test.json');
    writeFileSync(f, JSON.stringify(bundle));
    const { page, errors, close } = await open('verify.html');
    await page.fill('#expect', b58encode(payoutKey));
    await page.setInputFiles('#file', f);
    await page.waitForSelector('#result h3');
    const text = await page.locator('#result').innerText();
    assert.match(text, /PASS\s+statement_sha256/);
    assert.match(text, new RegExp(`PASS\\s+statement carries a payout address\\s+${b58encode(payoutKey)}`));
    assert.match(text, /PASS\s+score quote report_data/);
    assert.match(text, /FAIL\s+TDX quotes verify to Intel's root/); // stub quote
    assert.match(text, /PASS\s+statement payout matches the address you entered/);
    assert.match(text, /PASS\s+onchain payout matches the statement/);
    assert.match(text, /claimable now/); // the open bounty
    assert.deepEqual(errors, []);
    // a different expected address is flagged
    await page.fill('#expect', b58encode(key()));
    await page.setInputFiles('#file', f);
    await page.waitForFunction(() => /FAIL\s+statement payout/.test(document.querySelector('#result').innerText));
    await close();
  });

  it('every page works at phone width and in dark mode without horizontal scroll', async () => {
    for (const p of ['index.html', `bounty.html?address=${openAddr}`, 'verify.html', 'howto.html']) {
      const light = await open(p, { viewport: { width: 375, height: 800 } });
      await light.page.waitForLoadState('networkidle');
      assert.ok(await noHScroll(light.page), `${p} scrolls horizontally at 375px`);
      const bgLight = await light.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.deepEqual(light.errors, [], p);
      await light.close();
      const dark = await open(p, { viewport: { width: 375, height: 800 }, colorScheme: 'dark' });
      await dark.page.waitForLoadState('networkidle');
      const bgDark = await dark.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.notEqual(bgDark, bgLight, `${p} has no dark mode`);
      await dark.close();
    }
  });

  it('refuses mainnet and never calls its RPC', async () => {
    const before = rpcCalls;
    for (const q of ['?cluster=mainnet-beta', '?rpc=https://api.mainnet-beta.solana.com', '?rpc=https://rpc.example.com']) {
      const { page, close } = await open('index.html' + q);
      await page.waitForSelector('.banner.bad');
      assert.match(await page.locator('.banner.bad').innerText(), /mainnet|neither a local validator nor a devnet/i);
      await close();
    }
    assert.equal(rpcCalls, before);
  });
});
