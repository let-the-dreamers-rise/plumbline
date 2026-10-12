// Tiny static server for the app (ES modules do not load from file://). `node test/serve.mjs [port]`
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function serve(port = 0, host = '127.0.0.1') {
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(ROOT, p.endsWith('/') ? p + 'index.html' : p));
    if (!file.startsWith(ROOT) || file.includes(`${ROOT}/node_modules`) || file.includes(`${ROOT}/test`) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, host, () => r(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await serve(Number(process.argv[2] || 8080));
  console.log(`Plumbline app on http://127.0.0.1:${s.address().port}/`);
}
