// Signed inbound webhook receiver for hooks.bookchaowalit.com.
// Slice: Stripe only. Raw events land in R2 (bronze) before anything else.

export interface R2BucketLike {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export interface Env {
  HOOKS_BUCKET: R2BucketLike;
  STRIPE_WEBHOOK_SECRET?: string;
  FORWARD_URL?: string;
  FORWARD_TOKEN?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export const MAX_BODY_BYTES = 256 * 1024;
export const TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const reject = (status: number, error: string) => json({ error }, status);

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export async function computeSignature(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
}

export async function verifyStripeSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > TOLERANCE_SECONDS) return false;
  const expected = await computeSignature(secret, parsed.timestamp, rawBody);
  let match = false;
  for (const sig of parsed.signatures) if (timingSafeEqual(sig, expected)) match = true;
  return match;
}

export function stripeObjectKey(eventId: string, createdSeconds: number): string {
  const d = new Date(createdSeconds * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `bronze/stripe/${yyyy}/${mm}/${dd}/${eventId}.json`;
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  data?: { object?: Record<string, unknown> };
}

export function summarize(event: StripeEvent) {
  const obj = event.data?.object ?? {};
  const amount = obj.amount_total ?? obj.amount_received ?? obj.amount_refunded ?? obj.amount ?? null;
  return {
    id: event.id,
    type: event.type,
    amount: typeof amount === 'number' ? amount : null,
    currency: typeof obj.currency === 'string' ? obj.currency : null,
    created: event.created,
    livemode: event.livemode === true,
    payment_link: typeof obj.payment_link === 'string' ? obj.payment_link : null,
  };
}

async function readLimitedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(buffer);
}

async function forward(env: Env, summary: ReturnType<typeof summarize>): Promise<void> {
  try {
    await fetch(env.FORWARD_URL as string, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.FORWARD_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(summary),
    });
  } catch {
    // Best effort: the raw event is already durable in R2.
    console.warn('hooks: forward failed', summary.id);
  }
}

async function handleStripe(request: Request, env: Env, ctx: ExecutionContextLike, nowSeconds?: number): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return reject(503, 'not_configured');
  const rawBody = await readLimitedBody(request);
  if (rawBody === null) return reject(413, 'payload_too_large');
  const ok = await verifyStripeSignature(request.headers.get('stripe-signature'), rawBody, env.STRIPE_WEBHOOK_SECRET, nowSeconds);
  if (!ok) return reject(400, 'invalid_signature');

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return reject(400, 'invalid_payload');
  }
  if (typeof event?.id !== 'string' || !/^evt_[A-Za-z0-9_]+$/.test(event.id) || typeof event.type !== 'string' || typeof event.created !== 'number') {
    return reject(400, 'invalid_payload');
  }

  await env.HOOKS_BUCKET.put(stripeObjectKey(event.id, event.created), rawBody, {
    httpMetadata: { contentType: 'application/json' },
  });

  if (env.FORWARD_URL && env.FORWARD_TOKEN) ctx.waitUntil(forward(env, summarize(event)));
  return json({ received: true });
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContextLike, nowSeconds?: number): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/healthz' && request.method === 'GET') return json({ ok: true });
  if (pathname === '/stripe') {
    if (request.method !== 'POST') return reject(405, 'method_not_allowed');
    return handleStripe(request, env, ctx, nowSeconds);
  }
  return reject(404, 'not_found');
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
