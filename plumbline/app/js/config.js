// Cluster + program ids. Localnet by default, devnet on request; mainnet is refused, as in the CLI.
// Program ids: keep in sync with plumbline/programs (cli/test/layout.test.ts fails if they drift from the IDL).
export const PROGRAMS = {
  registry: 'Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW',
  bounty: '9mDieYQNR2L9xgaqS6LK26kxR26rA4R9UcFntG369RPf',
};
export const CLUSTERS = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
};
const KEY = 'plumbline.cluster';

const store = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch { /* private mode: fine */ } },
};

export function isMainnet(s) { return /mainnet/i.test(String(s || '')); }

/** Resolve from ?cluster= / ?rpc= first, then the remembered choice, then localnet. */
export function currentCluster(search = location.search) {
  const q = new URLSearchParams(search);
  const rpc = q.get('rpc');
  const name = q.get('cluster') || store.get() || 'localnet';
  if (isMainnet(rpc) || isMainnet(name)) return { name: 'refused', url: null, error: 'Mainnet is not supported: Plumbline v0 runs on localnet and devnet only.' };
  if (rpc) {
    let host = '';
    try { host = new URL(rpc).hostname; } catch { return { name: 'refused', url: null, error: `Not a URL: ${rpc}` }; }
    if (!/^(127\.0\.0\.1|localhost)$/.test(host) && !/devnet/i.test(host)) {
      return { name: 'refused', url: null, error: `RPC ${host} is neither a local validator nor a devnet endpoint.` };
    }
    return { name: /devnet/i.test(host) ? 'devnet' : 'localnet', url: rpc };
  }
  if (!CLUSTERS[name]) return { name: 'localnet', url: CLUSTERS.localnet };
  return { name, url: CLUSTERS[name] };
}

export function rememberCluster(name) { if (CLUSTERS[name]) store.set(name); }

export function programIds(search = location.search) {
  const q = new URLSearchParams(search);
  return { registry: q.get('registry') || PROGRAMS.registry, bounty: q.get('bounty') || PROGRAMS.bounty };
}

export function explorer(kind, id, cluster) {
  const q = cluster.name === 'devnet' ? '?cluster=devnet' : `?cluster=custom&customUrl=${encodeURIComponent(cluster.url || CLUSTERS.localnet)}`;
  return `https://explorer.solana.com/${kind}/${id}${q}`;
}

/** The CLI flag that selects the same cluster as the page. */
export const cliCluster = (c) => (c.name === 'devnet' ? ' --cluster devnet' : '');

/** Query string that keeps the same cluster (or custom RPC) on the next page. */
export const clusterQuery = (c) => (c.url && c.url !== CLUSTERS[c.name] ? `rpc=${encodeURIComponent(c.url)}` : `cluster=${c.name}`);
