/* A stand-in for Google's sign-in keys, for tests: the relay checks Firebase ID
 * tokens against the RSA keys Google publishes as a JWK set. This makes an RSA key
 * pair with Web Crypto, serves its public half as a JWK set at `url`, and mints
 * Firebase-style ID tokens with signIdToken(). Point the relay at it with
 * FIREBASE_JWKS_URL. Use fetchImpl in-process, or listen() to serve it over HTTP.
 *
 *   const keys = await createFakeFirebaseKeys({ projectId: 'worky-test' });
 *   const token = await keys.signIdToken({ sub: 'user-a' });
 */
const http = require('http');
const { subtle } = globalThis.crypto || require('crypto').webcrypto;

const RSA = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const b64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jsonB64 = obj => b64url(Buffer.from(JSON.stringify(obj)));

async function createFakeFirebaseKeys({ projectId = 'worky-test', url = 'https://keys.fake/jwks', maxAge = 3600 } = {}) {
  const state = { fetches: 0, maxAge };
  const served = new Map();                      // kid → key pair (what the JWK set lists)
  const makePair = () => subtle.generateKey(RSA, true, ['sign', 'verify']);
  served.set('fake-key-1', await makePair());

  async function jwks() {
    const keys = [];
    for (const [kid, pair] of served) {
      const { kty, n, e } = await subtle.exportKey('jwk', pair.publicKey);
      keys.push({ kty, n, e, kid, alg: 'RS256', use: 'sig' });
    }
    return { keys };
  }

  /* A signed ID token. `claims` override the defaults (a valid token for user-a).
   * opts: kid (default the first served key), pair (sign with another key pair,
   * e.g. one the server doesn't publish), alg (what the header claims). */
  async function signIdToken(claims = {}, { kid = 'fake-key-1', pair, alg = 'RS256' } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: `https://securetoken.google.com/${projectId}`, aud: projectId, auth_time: now - 300,
      sub: 'user-a', iat: now - 5, exp: now + 3600, firebase: { sign_in_provider: 'google.com' }, ...claims,
    };
    if (payload.sub && !('user_id' in claims)) payload.user_id = payload.sub;
    const input = `${jsonB64({ alg, kid, typ: 'JWT' })}.${jsonB64(payload)}`;
    const key = (pair || served.get(kid) || served.values().next().value).privateKey;
    const sig = await subtle.sign(RSA.name, key, Buffer.from(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  }

  /* Start publishing another key (Google rotating), or make one it never publishes. */
  async function addKey(kid) { served.set(kid, await makePair()); return served.get(kid); }
  const strangerKey = makePair;

  async function respond() {
    state.fetches++;
    return new Response(JSON.stringify(await jwks()), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${state.maxAge}, must-revalidate` },
    });
  }
  const handles = u => String(u) === self.url;
  const fetchImpl = async u => (handles(u) ? respond() : new Response('{}', { status: 404 }));

  /* Serve the JWK set over HTTP at `path` (any port; 0 picks a free one). Sets url. */
  function listen(port = 0, host = '127.0.0.1', path = '/jwks') {
    const server = http.createServer(async (req, res) => {
      if (req.url !== path) { res.writeHead(404); res.end('{}'); return; }
      const r = await respond();
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
    });
    return new Promise(resolve => server.listen(port, host, () => {
      self.url = `http://${host}:${server.address().port}${path}`;
      resolve(server);
    }));
  }

  const self = { url, projectId, state, jwks, signIdToken, addKey, strangerKey, handles, fetchImpl, listen };
  return self;
}

module.exports = { createFakeFirebaseKeys };
