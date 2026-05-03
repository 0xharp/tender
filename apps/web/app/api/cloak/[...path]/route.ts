/**
 * Same-origin proxy for Cloak's devnet relay (api.devnet.cloak.ag).
 *
 * Why this exists: Cloak's relay doesn't include `Access-Control-Allow-Origin`
 * for our deployed origin (https://www.tendr.bid), so direct browser → relay
 * calls are blocked by CORS. We forward through this Next.js route so the
 * browser only ever hits our own origin.
 *
 * The Cloak SDK accepts a `relayUrl` override on `transact()`, `fullWithdraw()`,
 * and the merkle-tree helpers — we pass `/api/cloak` so the SDK constructs
 * paths like `/api/cloak/viewing-key/challenge`, this catch-all forwards them
 * upstream, and the response comes back same-origin.
 *
 * Catch-all route (`[...path]`) so we don't have to enumerate Cloak's
 * endpoints individually. Forwards GET / POST / PUT / DELETE / PATCH plus
 * query strings + headers + body bidirectionally.
 *
 * No auth on this proxy — Cloak's devnet relay doesn't require API keys, and
 * the SDK's signed-challenge flow rides through the request body untouched.
 */
import { type NextRequest, NextResponse } from 'next/server';

const CLOAK_UPSTREAM = process.env.CLOAK_RELAY_UPSTREAM ?? 'https://api.devnet.cloak.ag';

// Force Node runtime - the Web Streams polyfill in some Edge runtimes can
// trip on the Cloak relay's response body shape. Node runtime is bulletproof.
export const runtime = 'nodejs';

// Don't cache anything - every Cloak call is state-sensitive (challenges,
// merkle roots, commitments) and Next's default caching would corrupt it.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Headers we strip on the way out. Hop-by-hop or Next-internal noise. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  // Next/Vercel internals
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'x-vercel-id',
  'x-vercel-deployment-url',
  'x-real-ip',
  // The browser-set Origin / Referer would just confuse Cloak's logs;
  // strip so upstream sees us as a regular client.
  'origin',
  'referer',
  'cookie',
]);

/** Headers we strip from upstream's response. CORS headers added below. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  // CRITICAL: Node's fetch auto-decompresses gzip/br/deflate when reading
  // the body, but if we forward upstream's `content-encoding: gzip` header,
  // the browser will try to decompress an already-decompressed body and
  // fail with ERR_CONTENT_DECODING_FAILED. Strip both encoding + length
  // so the browser treats the bytes as raw.
  'content-encoding',
  'content-length',
  // Strip any upstream CORS headers - we set our own below
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
]);

function buildUpstreamHeaders(req: NextRequest): Headers {
  const out = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  return out;
}

function buildResponseHeaders(upstream: Response): Headers {
  const out = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  // Same-origin from the browser's perspective, but set permissive CORS
  // anyway so the proxy stays useful from any future origin.
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  out.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, X-Cloak-*',
  );
  return out;
}

async function forward(req: NextRequest, path: string[]): Promise<Response> {
  const url = new URL(req.url);
  const upstreamUrl = `${CLOAK_UPSTREAM}/${path.join('/')}${url.search}`;

  // Body: only forward when present. GET/HEAD/OPTIONS shouldn't carry one.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req),
      body,
      // Don't follow redirects automatically - let the browser see them.
      redirect: 'manual',
      // Bypass any Next caching on the server fetch path.
      cache: 'no-store',
    });
  } catch (e) {
    console.error('[cloak-proxy] upstream fetch failed', upstreamUrl, e);
    return NextResponse.json(
      { error: 'cloak relay unreachable', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildResponseHeaders(upstream),
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function OPTIONS() {
  // Browser preflight - just respond OK with the CORS headers.
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Cloak-*',
      'Access-Control-Max-Age': '86400',
    },
  });
}
