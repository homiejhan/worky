/* dev-server.mjs — Focus and the bank relay on one local address, to try a bank
 * connection on your own machine:
 *
 *   npm run bank          (or: node backend/bank/dev-server.mjs)
 *
 * The app is served from the repository at http://localhost:8787/ and the relay
 * at http://localhost:8787/api/bank/. Settings come from backend/bank/.env (see
 * .env.example) or the environment. Without a RELAY_KEY one is made up for this
 * run, so connections made now stop working after a restart. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handle } from './relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RELAY_PATH = '/api/bank/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};

/* KEY=value lines; # comments; optional quotes. The environment wins over the file. */
export function readEnvFile(file = path.join(HERE, '.env')) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
export function relayEnv(extra = {}) {
  const env = { ...readEnvFile(), ...pick(process.env), ...extra };
  if (!env.RELAY_KEY) { env.RELAY_KEY = crypto.randomBytes(32).toString('base64'); env._madeUpKey = '1'; }
  return env;
}
function pick(src) {
  const keys = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV', 'RELAY_KEY', 'ALLOWED_ORIGINS', 'PLAID_REDIRECT_URI', 'PLAID_CLIENT_NAME', 'PLAID_API_BASE', 'PORT'];
  return Object.fromEntries(keys.filter(k => src[k]).map(k => [k, src[k]]));
}

/* The HTTP server: /api/bank/* → the relay, anything else → a file from the repo. */
export function createServer(env) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith(RELAY_PATH) || url.pathname === RELAY_PATH.slice(0, -1)) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const request = new Request(url, {
          method: req.method,
          headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        });
        const response = await handle(request, env);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      serveFile(url.pathname, res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });
}

function serveFile(pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { rel = '/'; }
  let file = path.resolve(ROOT, '.' + rel);
  const inside = file === ROOT || file.startsWith(ROOT + path.sep);
  const hidden = path.relative(ROOT, file).split(path.sep).some(p => p.startsWith('.') || p === 'node_modules');
  if (!inside || hidden) { res.writeHead(404); res.end('Not found'); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/* Run directly: start the server and say what to do next. */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const env = relayEnv();
  const port = Number(env.PORT) || 8787;
  createServer(env).listen(port, () => {
    const base = `http://localhost:${port}`;
    const problems = [];
    if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) problems.push('Plaid keys are missing: copy backend/bank/.env.example to backend/bank/.env and fill them in.');
    if (env._madeUpKey) problems.push('No RELAY_KEY in backend/bank/.env, so this run uses a temporary one: connections stop working after a restart.');
    console.log(`\nFocus is running at ${base}/  (Plaid: ${env.PLAID_ENV === 'production' ? 'production' : 'sandbox'})`);
    console.log(`Bank relay: ${base}${RELAY_PATH}\n`);
    console.log('To connect a bank:');
    console.log(`  1. Open ${base}/ and go to Settings → Bank accounts.`);
    console.log(`  2. Relay address: ${base}${RELAY_PATH.slice(0, -1)}  → Save.`);
    console.log('  3. Connect a bank. In the sandbox, pick First Platypus Bank and log in with user_good / pass_good.\n');
    problems.forEach(p => console.log('  ! ' + p));
  });
}
