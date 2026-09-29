# Bank connections: the Plaid relay

Focus reads bank accounts (names, balances, recent transactions) through
[Plaid](https://plaid.com). Plaid's keys must stay secret, so the browser can't
call Plaid itself. This folder is a small relay server that makes those calls for
the app. It keeps nothing: there's no database.

A bank connection belongs to a signed-in Focus account, not to a device. Every
call but `/health` carries the account's cloud-sync sign-in, a Firebase ID token,
and the relay checks it itself. The key to each connection (Plaid's access token)
is sealed with AES-GCM under `RELAY_KEY`, together with the account's id (the
Firebase uid), and handed back to the app. The app saves it to that account in
Firebase (`users/<uid>/bank`), with the balances and transactions it reads. So a
bank connected on one device shows on every device signed in to the account, and
a copied token is useless to anyone not signed in as that account.

```
Focus (browser, signed in to Cloud sync)   relay (this folder)                   Plaid
  every call but /health sends  Authorization: Bearer <Firebase ID token>
  the relay checks it against Google's keys and takes the uid from it
Settings → Bank accounts → Connect ──────► POST /link-token ───────────────────► /link/token/create (client_user_id = uid)
Plaid's window: pick a bank, log in ◄───── link token
login done (one-time public token) ──────► POST /exchange ─────────────────────► /item/public_token/exchange
saves it to users/<uid>/bank/items/<id> ◄─ token sealed with the uid
Refresh, on any device of the account ───► POST /accounts, /transactions ──────► /accounts/get, /transactions/sync
  (or on its own, every half hour)
Disconnect ──────────────────────────────► POST /remove ───────────────────────► /item/remove
```

The app refreshes a bank on its own once what it has is half an hour old, and,
with **Log new transactions in Budget** on (the default), logs each new
transaction from a checking account in Budget (`js/bankbudget.js` has the rules).
A posted transaction carries `pending_id`, the pending one it replaces, so a
charge that posts stays one purchase. That needs this relay as it is now: an
older one leaves `pending_id` out, and a posted charge then shows up as the
pending one given back plus a new purchase, which adds up the same.

**How the relay checks a sign-in.** An ID token is a JWT that Google signs with
RS256. The relay fetches Google's public keys
(`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`),
keeps them for as long as the response's `Cache-Control: max-age` says, and
fetches again once when a token names a key it doesn't know (Google rotates them).
It checks the signature with Web Crypto, then that the token is for
`FIREBASE_PROJECT_ID` (`aud`, and `iss` = `https://securetoken.google.com/<project>`),
hasn't expired (`exp`, with a minute's leeway for clocks), was issued and signed in
in the past (`iat`, `auth_time`), and names an account (`sub`, the uid). Anything
else is a `401` with `AUTH_REQUIRED` (no sign-in) or `AUTH_INVALID`, and the app
tries once more with a fresh token before it shows the message. A sealed token
opens only for the uid inside it; for anyone else it's `TOKEN_INVALID`, as if it
came from another relay.

| File | What it is |
|---|---|
| `relay.mjs` | The relay: six endpoints, Web standard `fetch` + Web Crypto. Runs on Cloudflare Workers or Node 20+. |
| `dev-server.mjs` | Runs the app and the relay together at `http://localhost:8787` (`npm run bank`). |
| `check.mjs` | Proves your keys and the relay work end to end, with no browser (`npm run bank:check`). |
| `wrangler.toml` | Cloudflare Workers settings, to put the relay online. |
| `.env.example` | The settings, for running it on your computer. Copy to `.env` (never committed). |

## 1. Try it on your computer (sandbox, about 10 minutes)

The sandbox is Plaid's test environment: fake banks, fake money, free.

1. **Get Plaid keys.** Sign up at [dashboard.plaid.com](https://dashboard.plaid.com/signup)
   (free). Under **Developers → Keys**, copy your `client_id` and the **Sandbox** secret.
2. **Fill in the settings.**
   ```sh
   cp backend/bank/.env.example backend/bank/.env
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → RELAY_KEY
   ```
   Put `PLAID_CLIENT_ID`, `PLAID_SECRET` and that `RELAY_KEY` in `backend/bank/.env`.
   `FIREBASE_PROJECT_ID` is already there (`worky-b3e3a`, the project in
   `js/config.js`): the relay accepts sign-ins from that project only.
3. **Prove the connection without a browser.**
   ```sh
   FIREBASE_JWKS_URL=http://127.0.0.1:0/jwks npm run bank:check
   ```
   It makes a sandbox login at First Platypus Bank, exchanges it through the relay,
   reads the accounts and transactions, and removes the connection again. It
   should end with `End to end: OK`. The relay only answers a signed-in account,
   and only Google can sign a real ID token, so the check signs its own: with
   `FIREBASE_JWKS_URL` set, it serves test sign-in keys at that address (port `0`
   picks a free one) and points the relay at them. Without it, it explains and
   stops. Never set `FIREBASE_JWKS_URL` on a relay people use.
4. **Connect from the app.** Bank accounts needs a Cloud sync sign-in, and signing
   in always returns to the deployed app (`GCAL_REDIRECT` in `js/config.js`), not to
   `localhost`. So use the deployed app on this computer, pointed at your relay:
   add `https://homiejhan.github.io` to `ALLOWED_ORIGINS` in `.env`, then
   ```sh
   npm run bank
   ```
   Open <https://homiejhan.github.io/worky/>, sign in under **Settings → Cloud
   sync**, go to **Settings → Bank accounts**, press **Change** on the relay line,
   enter `http://localhost:8787/api/bank` and press **Save** (it's saved on this
   device only; if the browser asks to let the page reach devices on your network,
   allow it). Then **Connect a bank**. In Plaid's window, pick **First Platypus
   Bank** and log in with **`user_good`** / **`pass_good`** (if it asks for a code,
   use `1234`). The accounts, balances and recent transactions show up in Settings.
   The connection is saved to your account like a real one, and only this relay
   can open it (its `RELAY_KEY`, the sandbox): **Disconnect** it before you press
   **Use the default relay**. The app at <http://localhost:8787> shows the signed-out
   screens only.

## 2. Real bank accounts

- **Plaid access.** New Plaid teams get a free **Trial plan**: up to 10 real bank
  logins, including Chase, Bank of America and Wells Fargo. A login (a Plaid "Item")
  counts when it's made, and Disconnect (`/item/remove`) doesn't give the slot
  back: connect each bank once, on one device. Every other device signed in to the
  same account shows it without connecting. For more, request Production access in
  the dashboard (company details and a security questionnaire). Use the
  **Production** secret and set `PLAID_ENV=production`. Tokens sealed in the
  sandbox don't work in production, so connect again after switching.
- **OAuth banks** (Chase, Bank of America, Wells Fargo…) send the user to the bank's
  own site and back. Add the app's address (for example `https://homiejhan.github.io/worky/`)
  under **Developers → API → Allowed redirect URIs** in the Plaid dashboard, and set
  `PLAID_REDIRECT_URI` to the same address. Focus picks the connection up again when
  the bank sends the user back. That address must be https, so test OAuth banks once
  the relay is online.
- **Cost.** On Pay as you go, Plaid bills Transactions every month for each connected
  bank, until it's disconnected. Disconnect in the app ends it.

## 3. Put the relay online (Cloudflare Workers)

Cloudflare's free plan is enough for a pilot. From `backend/bank/`:

```sh
npx wrangler login
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put RELAY_KEY        # a new one for this relay; keep it safe
npx wrangler deploy                      # prints https://focus-bank-relay.<you>.workers.dev
curl https://focus-bank-relay.<you>.workers.dev/health    # → {"ok":true,"env":"sandbox",…,"auth":true,…}
```

In `wrangler.toml`, set `ALLOWED_ORIGINS` to where the app runs
(`https://homiejhan.github.io`), `FIREBASE_PROJECT_ID` to the Firebase project in
`js/config.js` (it's `worky-b3e3a`; not a secret, so it's a plain var), and
`PLAID_ENV` / `PLAID_REDIRECT_URI` as needed. `/health` says `"auth":true` once
`FIREBASE_PROJECT_ID` is set. Then set `BANK_RELAY_URL` in `js/config.js` to the
relay's address and deploy the app. From then on, **Settings → Bank accounts**
shows **Connect a bank** on every device signed in to Cloud sync.

Deploy the relay before the app when both change: an app that sends the sign-in
can't talk to an older relay (its CORS doesn't allow the `Authorization` header),
and Settings calls such a relay out of date.

Changing `RELAY_KEY` breaks every existing connection (users connect again), so
treat it like a password. `relay.mjs` exports a standard `fetch` handler, so other
hosts that run one (Deno Deploy, Bun, Vercel Edge) work too. On a plain Node server,
`dev-server.mjs` serves the relay and the app together.

## What is stored where

- **In the user's account** (Firebase Realtime Database, `users/<uid>/bank`):
  `items/<item id>` for each bank, holding the sealed token, the bank's name, account
  names, last four digits, balances, the newest 50 transactions, a sync cursor and
  the last error from Plaid about the connection; and `updatedAt`. The app writes
  one item at a time (`set()`, and `remove()` on Disconnect) and never the whole
  node, so two devices changing different banks don't overwrite each other; for
  the same bank the last write wins. State pushes use `update()`, which leaves the
  node alone. It sits next to the synced state (`users/<uid>/state`), not in it, so
  Export doesn't include it. The database rules that already limit `users/<uid>` to
  its owner cover it: no rules change.
- **In the user's synced data** (`users/<uid>/state`, and Export), only with **Log
  new transactions in Budget** on: the purchases and balance changes Budget logged
  (description, amount, date), and for each bank the day logging started and the
  transactions it has counted (their ids, amounts and dates, no descriptions).
- **On the device** (`localStorage`, key `focus-bank`): a copy of the signed-in
  account's banks, to show while offline (`{ uid, relay, items }`), dropped on
  sign-out; and a relay address set on that device for testing. Nothing else about
  banks is kept only on a device. An older build kept each connection on its device
  with a token sealed to no one; the app drops those, once, and asks the user to
  connect again.
- **On the relay:** nothing. Its settings hold the Plaid keys, `RELAY_KEY` and
  `FIREBASE_PROJECT_ID`, and it caches Google's public sign-in keys.
- **At Plaid:** the connection (a Plaid "Item") until Disconnect. Plaid knows the
  user by the Firebase uid (`client_user_id`), not by name or email. Users can also
  see and remove connections at [my.plaid.com](https://my.plaid.com).

## Before real students use it

This is a working connection, not yet a production service. Before other people's
bank data flows through it:

- [x] **Tie each connection to a person.** Done: bank accounts need the cloud-sync
  sign-in, the relay verifies the Firebase ID token on every call, and the user's
  uid is sealed into each token, so a copied token is useless to anyone else. The
  connection lives in that account, not on a device.
- [ ] **Limit and watch the relay:** rate limits (Cloudflare rules), and error logs
  that never contain tokens or account data.
- [ ] **Keep secrets only in the host's secret store,** and plan how to rotate them.
- [ ] **Handle `ITEM_LOGIN_REQUIRED`** with Plaid's update mode. Today the app asks the
  user to disconnect and connect again.
- [ ] **Paperwork:** Plaid's production approval, the privacy policy (the help page's
  privacy section describes bank connections), the FTC Safeguards Rule (GLBA), which
  likely applies once you hold people's bank connections, and the university's
  vendor security review (HECVAT) for a pilot.

## Tests

`npm test -- bank` runs `tests/test_bank.js`. It covers the relay against a fake
Plaid (`tests/fake-plaid.js`), its sign-in checks against a fake of Google's keys
(`tests/fake-firebase-keys.js`: an RSA key pair made with Web Crypto, served as a
JWK set, and ID tokens signed with it), the relay over HTTP through
`dev-server.mjs`, `check.mjs` from start to finish, and **Settings → Bank
accounts** in the app, with devices sharing one fake Firebase
(`tests/fake-firebase.js`, the one the sync tests use). The tests never call Plaid
or Google.
