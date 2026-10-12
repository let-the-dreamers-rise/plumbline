// Shared page chrome: header with cluster + theme controls, small formatting helpers.
import { CLUSTERS, currentCluster, rememberCluster } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (s, n = 4) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
export const sol = (lamports) => {
  const l = BigInt(lamports);
  const whole = l / 1_000_000_000n, frac = (l % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} SOL`;
};
export const pct = (c, t) => (t ? `${((100 * c) / t).toFixed(1)}%` : '–');

const THEME_KEY = 'plumbline.theme';
function applyTheme(t) { if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* ignore */ }

const LOGO = `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><line x1="11" y1="1" x2="11" y2="14" stroke="currentColor" stroke-width="1.6"/><path d="M11 13.5 L15.5 17.5 L11 21 L6.5 17.5 Z" fill="var(--accent)"/></svg>`;

export function chrome(active) {
  const cluster = currentCluster();
  const nav = [['index.html', 'Bounties', 'bounties'], ['verify.html', 'Verify a bundle', 'verify'], ['howto.html', 'How it works', 'howto']];
  const header = document.createElement('header');
  header.className = 'site';
  header.innerHTML = `<div class="wrap">
    <a class="brand" href="index.html">${LOGO}<span>Plumbline</span></a>
    <nav class="main" aria-label="Main">${nav.map(([h, l, k]) => `<a href="${h}"${k === active ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    <div class="controls">
      <label class="muted" for="cluster-select" style="font-size:.85rem">Cluster</label>
      <select id="cluster-select">${Object.keys(CLUSTERS).map((k) => `<option value="${k}"${k === cluster.name ? ' selected' : ''}>${k}</option>`).join('')}</select>
      <button id="theme-toggle" type="button" aria-label="Toggle light or dark theme" title="Theme"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="display:block"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/></svg></button>
    </div></div>`;
  document.body.prepend(header);
  $('#cluster-select').addEventListener('change', (e) => {
    rememberCluster(e.target.value);
    const u = new URL(location.href); u.searchParams.delete('rpc'); u.searchParams.set('cluster', e.target.value); location.href = u.toString();
  });
  $('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  });
  const footer = document.createElement('footer');
  footer.className = 'site';
  footer.innerHTML = `<div class="wrap">Plumbline v0 · ${esc(cluster.name)}${cluster.url ? ` · <span class="mono">${esc(cluster.url)}</span>` : ''} · no wallet needed: this page only reads the chain. Actions are CLI commands.</div>`;
  document.body.append(footer);
  return cluster;
}

/** A copyable command block. */
export function cmd(text) {
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => { navigator.clipboard?.writeText(text).then(() => { b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200); }, () => {}); });
  });
  return `<pre class="cmd"><button class="copy" id="${id}" type="button">copy</button><code>${esc(text)}</code></pre>`;
}

export function rpcProblem(cluster, e) {
  const local = cluster.name === 'localnet';
  return `<div class="banner bad"><strong>Could not read ${esc(cluster.name)}.</strong> ${esc(e?.message ?? e)}
    ${local ? `<p>Start a local validator with the Plumbline programs (see <span class="mono">plumbline/programs</span>), or switch to devnet in the header.</p>` : ''}</div>`;
}
