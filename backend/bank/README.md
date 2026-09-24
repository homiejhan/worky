# Bank connections: the Plaid relay

Focus reads bank accounts (names, balances, recent transactions) through
[Plaid](https://plaid.com). Plaid's keys must stay secret, so the browser can't
call Plaid itself. This folder is a small relay server that makes those calls for
the app. It keeps nothing: there's no database. The key to each bank connection
(Plaid's access token) is sealed with AES-GCM under `RELAY_KEY` and handed back to
the user's device, which sends it with each request. Balances and transactions
pass through to the device and are stored only there.

```
Focus (browser)                           relay (this folder)                Plaid
Settings → Bank accounts → Connect ─────► POST /link-token ────────────────► /link/token/create
Plaid's window: pick a bank, log in ◄──── link token
login done (one-time public token) ─────► POST /exchange ──────────────────► /item/public_token/exchange
keeps the sealed token, on this device ◄─ sealed token
Refresh ────────────────────────────────► POST /accounts, /transactions ───► /accounts/get, /transactions/sync
Disconnect ─────────────────────────────► POST /remove ────────────────────► /item/remove
```

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
3. **Prove the connection without a browser.**
   ```sh
   npm run bank:check
   ```
   It makes a sandbox login at First Platypus Bank, exchanges it through the relay,
   reads the accounts and transactions, and removes the connection again. It
   should end with `End to end: OK`.
4. **Connect from the app.**
   ```sh
   npm run bank
   ```
   Open <http://localhost:8787>, go to **Settings → Bank accounts**, enter the relay
   address `http://localhost:8787/api/bank` and press **Save**, then **Connect a bank**.
   In Plaid's window, pick **First Platypus Bank** and log in with **`user_good`** /
   **`pass_good`** (if it asks for a code, use `1234`). The accounts, balances and
   recent transactions show up in Settings.

## 2. Real bank accounts

- **Plaid access.** New Plaid teams get a free **Trial plan**: up to 10 real bank
  logins, including Chase, Bank of America and Wells Fargo. For more, request
  Production access in the dashboard (company details and a security questionnaire).
  Use the **Production** secret and set `PLAID_ENV=production`. Tokens sealed in the
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
curl https://focus-bank-relay.<you>.workers.dev/health    # → {"ok":true,"env":"sandbox",…}
```

In `wrangler.toml`, set `ALLOWED_ORIGINS` to where the app runs
(`https://homiejhan.github.io`), and `PLAID_ENV` / `PLAID_REDIRECT_URI` as needed.
Then set `BANK_RELAY_URL` in `js/config.js` to the relay's address and deploy the
app. From then on, **Settings → Bank accounts** shows **Connect a bank** on every
device.

Changing `RELAY_KEY` breaks every existing connection (users connect again), so
treat it like a password. `relay.mjs` exports a standard `fetch` handler, so other
hosts that run one (Deno Deploy, Bun, Vercel Edge) work too. On a plain Node server,
`dev-server.mjs` serves the relay and the app together.

## What is stored where

- **On the device** (`localStorage`, key `focus-bank`): the sealed token for each bank,
  account names, last four digits, balances, the newest 50 transactions and a sync
  cursor. There's also a random device id (`focus-bank-user`), which is the only way
  Plaid knows the user. None of it is synced to the cloud or included in Export.
- **On the relay:** nothing. Its settings hold the Plaid keys and `RELAY_KEY`.
- **At Plaid:** the connection (a Plaid "Item") until Disconnect. Users can also see
  and remove connections at [my.plaid.com](https://my.plaid.com).

## Before real students use it

This is a working connection, not yet a production service. Before other people's
bank data flows through it:

- **Tie each connection to a person.** Today, anyone who has both a device's sealed
  token and the relay address can read that connection's balances. Require
  cloud-sync sign-in, have the relay verify the Firebase ID token, and seal the
  user's uid into the token, so a copied token is useless to anyone else.
- **Limit and watch the relay:** rate limits (Cloudflare rules), and error logs
  that never contain tokens or account data.
- **Keep secrets only in the host's secret store,** and plan how to rotate them.
- **Handle `ITEM_LOGIN_REQUIRED`** with Plaid's update mode. Today the app asks the
  user to disconnect and connect again.
- **Paperwork:** Plaid's production approval, the privacy policy (the help page's
  privacy section describes bank connections), the FTC Safeguards Rule (GLBA), which
  likely applies once you hold people's bank connections, and the university's
  vendor security review (HECVAT) for a pilot.

## Tests

`npm test -- bank` runs `tests/test_bank.js`. It covers the relay against a fake
Plaid (`tests/fake-plaid.js`), the relay over HTTP through `dev-server.mjs`,
`check.mjs` from start to finish, and **Settings → Bank accounts** in the app. The
tests never call Plaid.
