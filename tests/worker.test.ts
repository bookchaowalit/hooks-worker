import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSignature, handleRequest, MAX_BODY_BYTES, stripeObjectKey, type Env } from '../src/worker.js';

// Test-only fixtures; not real credentials.
const signingKey = ['fixture', 'signing', 'key', 'for', 'unit', 'tests'].join('-');
const forwardCredential = ['fixture', 'forward', 'value'].join('-');
const now = 1_790_000_000; // 2026-09-21T13:33:20Z

function makeEnv(extra: Partial<Env> = {}) {
  const puts: { key: string; value: string }[] = [];
  const env: Env = {
    HOOKS_BUCKET: { async put(key, value) { puts.push({ key, value }); return null; } },
    STRIPE_WEBHOOK_SECRET: signingKey,
    ...extra,
  };
  return { env, puts };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } }, pending };
}

const event = {
  id: 'evt_1TestABC',
  type: 'checkout.session.completed',
  created: now,
  livemode: false,
  data: { object: { amount_total: 49000, currency: 'thb', payment_link: 'plink_123', customer_email: 'private@example.com' } },
};

async function signed(body: string, timestamp = now, key = signingKey) {
  return `t=${timestamp},v1=${await computeSignature(key, timestamp, body)}`;
}

function post(body: string, signature?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature) headers['stripe-signature'] = signature;
  return new Request('https://hooks.example.com/stripe', { method: 'POST', headers, body });
}

test('valid signature stores raw event in R2 and returns 200', async () => {
  const body = JSON.stringify(event);
  const { env, puts } = makeEnv();
  const { ctx, pending } = makeCtx();
  const res = await handleRequest(post(body, await signed(body)), env, ctx, now + 10);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, 'bronze/stripe/2026/09/21/evt_1TestABC.json');
  assert.equal(puts[0].value, body);
  assert.equal(pending.length, 0, 'no forward without FORWARD_URL/FORWARD_TOKEN');
});

test('bad signature returns 400 without echoing body or writing R2', async () => {
  const body = JSON.stringify(event);
  const { env, puts } = makeEnv();
  const res = await handleRequest(post(body, await signed(body, now, 'wrong-fixture-key')), env, makeCtx().ctx, now);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(!text.includes('evt_1TestABC'));
  assert.equal(puts.length, 0);
});

test('missing signature header returns 400', async () => {
  const { env, puts } = makeEnv();
  const res = await handleRequest(post(JSON.stringify(event)), env, makeCtx().ctx, now);
  assert.equal(res.status, 400);
  assert.equal(puts.length, 0);
});

test('stale timestamp (> 300s) is rejected', async () => {
  const body = JSON.stringify(event);
  const { env, puts } = makeEnv();
  const res = await handleRequest(post(body, await signed(body, now - 301)), env, makeCtx().ctx, now);
  assert.equal(res.status, 400);
  assert.equal(puts.length, 0);
});

test('tampered body with a previously valid header is rejected', async () => {
  const body = JSON.stringify(event);
  const sig = await signed(body);
  const { env } = makeEnv();
  const res = await handleRequest(post(body.replace('49000', '1'), sig), env, makeCtx().ctx, now);
  assert.equal(res.status, 400);
});

test('R2 key format uses UTC date of event.created and is stable per id', () => {
  assert.equal(stripeObjectKey('evt_abc', Date.UTC(2026, 0, 2, 23, 59, 59) / 1000), 'bronze/stripe/2026/01/02/evt_abc.json');
  assert.equal(stripeObjectKey('evt_abc', now), stripeObjectKey('evt_abc', now));
});

test('oversized body returns 413', async () => {
  const body = 'x'.repeat(MAX_BODY_BYTES + 1);
  const { env, puts } = makeEnv();
  const res = await handleRequest(post(body, await signed(body)), env, makeCtx().ctx, now);
  assert.equal(res.status, 413);
  assert.equal(puts.length, 0);
});

test('missing signing secret returns 503', async () => {
  const body = JSON.stringify(event);
  const { env } = makeEnv({ STRIPE_WEBHOOK_SECRET: undefined });
  const res = await handleRequest(post(body, await signed(body)), env, makeCtx().ctx, now);
  assert.equal(res.status, 503);
});

test('forward posts minimal summary via waitUntil when configured', async () => {
  const body = JSON.stringify(event);
  const { env } = makeEnv({ FORWARD_URL: 'https://forward.example.com/in', FORWARD_TOKEN: forwardCredential });
  const { ctx, pending } = makeCtx();
  const calls: Request[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(new Request(input, init)); return new Response('ok'); }) as typeof fetch;
  try {
    const res = await handleRequest(post(body, await signed(body)), env, ctx, now);
    assert.equal(res.status, 200);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${forwardCredential}`);
  assert.deepEqual(await calls[0].json(), {
    id: 'evt_1TestABC', type: 'checkout.session.completed', amount: 49000, currency: 'thb',
    created: now, livemode: false, payment_link: 'plink_123',
  });
});

test('forward failure does not affect the 200 response', async () => {
  const body = JSON.stringify(event);
  const { env, puts } = makeEnv({ FORWARD_URL: 'https://forward.example.com/in', FORWARD_TOKEN: forwardCredential });
  const { ctx, pending } = makeCtx();
  const original = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = (async () => { throw new Error('down'); }) as typeof fetch;
  console.warn = () => {};
  try {
    const res = await handleRequest(post(body, await signed(body)), env, ctx, now);
    assert.equal(res.status, 200);
    await Promise.all(pending);
  } finally {
    globalThis.fetch = original;
    console.warn = originalWarn;
  }
  assert.equal(puts.length, 1);
});

test('GET /healthz returns ok', async () => {
  const { env } = makeEnv();
  const res = await handleRequest(new Request('https://hooks.example.com/healthz'), env, makeCtx().ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('unknown path returns 404 and GET /stripe returns 405', async () => {
  const { env } = makeEnv();
  assert.equal((await handleRequest(new Request('https://hooks.example.com/nope'), env, makeCtx().ctx)).status, 404);
  assert.equal((await handleRequest(new Request('https://hooks.example.com/stripe'), env, makeCtx().ctx)).status, 405);
});
