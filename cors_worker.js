/**
 * Cloudflare Worker — CORS proxy for Cloudflare R2 public bucket.
 *
 * Deploy in the Cloudflare dashboard (Workers & Pages → Create Worker),
 * paste this code, click Deploy.
 *
 * All requests to https://YOUR-WORKER.workers.dev/Foo.pdf are proxied to
 * the R2 public URL and returned with Access-Control-Allow-Origin: *
 * so browsers can fetch the binary for PDF merging.
 */

const R2_BASE = 'https://pub-559e9d410348415c956e2de7e0b1ba46.r2.dev';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age':       '86400',
};

export default {
  async fetch(req) {
    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = new URL(req.url).pathname;           // e.g. /Atlas%20AS7-D.pdf
    const upstream = await fetch(R2_BASE + path);

    // Stream the R2 response back with CORS headers added
    const headers = new Headers(upstream.headers);
    Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));

    return new Response(upstream.body, {
      status:  upstream.status,
      headers,
    });
  },
};
