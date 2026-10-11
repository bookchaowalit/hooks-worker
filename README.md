# hooks-worker (`solo-empire-hooks`)

Cloudflare Worker for the reserved `hooks.bookchaowalit.com` host
(`infra/platform/domains.yaml`, access `public-signed`). It accepts signed
inbound webhooks and writes the raw event to R2 before anything else.

Current slice: **Stripe only**. LINE, GitHub, and iPaaS sources are future slices.

## Behavior

| Route | Behavior |
|---|---|
| `POST /stripe` | Verifies `Stripe-Signature` (`t=...,v1=...`, HMAC-SHA256 over `${t}.${rawBody}`, constant-time compare, 300 s tolerance). Invalid → `400`, without echoing the body. Valid → raw JSON written to `HOOKS_BUCKET` at `bronze/stripe/YYYY/MM/DD/<event.id>.json` (UTC date of `event.created`; the same id overwrites, so Stripe retries are idempotent), then `200 {"received":true}`. |
| `GET /healthz` | `200 {"ok":true}` |
| anything else | `404` (`405` for non-POST `/stripe`) |

- Body limit: 256 KB (`413` above it).
- Missing `STRIPE_WEBHOOK_SECRET` → `503` (no event accepted unverified).
- Optional forward: when both `FORWARD_URL` and `FORWARD_TOKEN` are set, a
  minimal summary `{id,type,amount,currency,created,livemode,payment_link}` is
  POSTed with a bearer credential through `ctx.waitUntil`. It is best effort and never
  delays or changes the `200`; the raw event in R2 remains the source of truth.

## Local checks

```bash
cd infra/hooks-worker
npm install
npm test
npm run typecheck
```

## Owner deploy steps

These steps need the owner's Cloudflare and Stripe access. Run them yourself;
agents do not run `wrangler login`, create DNS, or set secrets.

```bash
cd infra/hooks-worker
npx wrangler login
npx wrangler r2 bucket create solo-empire-hooks
```

1. In the Stripe Dashboard → Developers → Webhooks, add an endpoint
   `https://hooks.bookchaowalit.com/stripe` subscribed to:
   `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`.
   Copy that endpoint's signing secret.
2. Store it as a Worker secret (paste at the prompt; never commit it):

   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   # optional forward
   npx wrangler secret put FORWARD_URL
   npx wrangler secret put FORWARD_TOKEN
   ```

3. Uncomment the `routes` custom-domain block in `wrangler.toml` once the DNS
   binding for `hooks.bookchaowalit.com` is approved, then deploy:

   ```bash
   npx wrangler deploy
   ```

4. Smoke test:

   ```bash
   curl https://hooks.bookchaowalit.com/healthz
   ```

   Then use Stripe's "Send test webhook" and confirm an object appears under
   `bronze/stripe/` in the `solo-empire-hooks` bucket.

After a verified deploy, update the `hooks.bookchaowalit.com` entry status in
`infra/platform/domains.yaml`.
