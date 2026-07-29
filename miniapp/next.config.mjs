/**
 * All response headers are set here rather than in vercel.json.
 *
 * Two notes worth keeping, since both are the kind of thing that gets
 * "helpfully" added back later:
 *
 * 1. Framing is controlled by the `frame-ancestors` CSP directive below, not
 *    by X-Frame-Options. XFO has no syntax for an allowlist — it takes DENY or
 *    SAMEORIGIN and nothing else — and browsers may treat an invented value
 *    such as "ALLOWALL" as DENY, which would stop Telegram Web from embedding
 *    the app at all. `frame-ancestors` supersedes XFO wherever both appear.
 *
 * 2. When the Godot game host arrives in the next slice, do NOT set
 *    Cross-Origin-Opener-Policy or Cross-Origin-Embedder-Policy. Export Godot
 *    single-threaded instead. Cross-origin isolation breaks the wallet
 *    provider's iframes and third-party RPC calls.
 *
 * @type {import('next').NextConfig}
 */
const isDev = process.env.NODE_ENV === "development";

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval' " : ""}https://telegram.org`,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",

              // data: is required — AppKit inlines its own font faces rather
              // than fetching them, and a blocked font can stall first paint of
              // the modal.
              "font-src 'self' data: https://fonts.gstatic.com",

              "img-src 'self' data: blob: https:",

              // Without an explicit worker-src this falls back to default-src
              // ('self'), which blocks the blob: worker WalletConnect uses for
              // its relay socket. The failure is quiet and total: no pairing URI
              // is ever produced, so the QR never renders and the copy-link
              // button has nothing to copy. Both symptoms, one missing
              // directive.
              "worker-src 'self' blob:",

              // Apex domains are listed alongside the wildcards on purpose:
              // `*.walletconnect.org` does not match `walletconnect.org`.
              [
                "connect-src 'self'",
                isDev ? "ws: wss:" : "",
                process.env.NEXT_PUBLIC_API_URL ?? "",
                "https://api.web3modal.org",
                "https://walletconnect.com https://*.walletconnect.com",
                "wss://*.walletconnect.com",
                "https://walletconnect.org https://*.walletconnect.org",
                "wss://*.walletconnect.org",
                "https://reown.com https://*.reown.com",
                "wss://*.reown.com",
              ]
                .filter(Boolean)
                .join(" "),

              "frame-src 'self' https://*.walletconnect.com https://*.reown.com",
              "frame-ancestors https://web.telegram.org https://telegram.org",
            ].join("; "),
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};
export default nextConfig;
