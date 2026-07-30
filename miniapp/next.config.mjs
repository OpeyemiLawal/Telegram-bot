/**
 * Security headers are NOT set here. They live in middleware.ts.
 *
 * They moved because `frame-src` has to name every origin allowed to be framed,
 * and this file is evaluated once at build time. Adding a game therefore meant
 * editing an environment variable and rebuilding the frontend — fine for four
 * games, two hundred rebuilds for two hundred. Middleware computes the policy per
 * request from the catalogue, so adding a game is a row in a table.
 *
 * Two notes worth keeping, since both are the kind of thing that gets
 * "helpfully" added back later:
 *
 * 1. Framing is controlled by the `frame-ancestors` CSP directive, not by
 *    X-Frame-Options. XFO has no syntax for an allowlist — it takes DENY or
 *    SAMEORIGIN and nothing else — and browsers may treat an invented value such
 *    as "ALLOWALL" as DENY, which would stop Telegram Web embedding the app at
 *    all. `frame-ancestors` supersedes XFO wherever both appear.
 *
 * 2. When the Godot game host arrives, do NOT set Cross-Origin-Opener-Policy or
 *    Cross-Origin-Embedder-Policy. Export Godot single-threaded instead.
 *    Cross-origin isolation breaks the wallet provider's iframes and third-party
 *    RPC calls.
 *
 * If you add a `headers()` block here it will not replace the middleware's
 * header — both are sent, and the browser enforces the intersection of two
 * policies. The result is a page that fails against a policy neither file
 * contains. Change middleware.ts instead.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
