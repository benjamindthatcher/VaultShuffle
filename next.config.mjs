/** @type {import('next').NextConfig} */
const isProduction = process.env.NODE_ENV === "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://steamcommunity.com",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"} https://va.vercel-scripts.com https://*.posthog.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://cdn.cloudflare.steamstatic.com https://cdn.akamai.steamstatic.com https://shared.akamai.steamstatic.com https://avatars.steamstatic.com",
  "font-src 'self' data:",
  "connect-src 'self' https://vitals.vercel-insights.com https://*.vercel-insights.com https://*.posthog.com",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  ...(isProduction ? ["upgrade-insecure-requests"] : [])
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }
];

const nextConfig = {
  /**
   * Without this the browser withholds the message and stack of any error
   * thrown by a script it considers cross-origin, and reports the literal string
   * "Script error." instead. Our bundles are served from the same site but
   * through a CDN, so genuine failures arrive indistinguishable from the noise
   * that browser extensions throw - and 60% of this traffic is mobile, where
   * that noise is constant. Anonymous CORS on the script tags means real errors
   * come through with something to read.
   */
  crossOrigin: "anonymous",
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      { source: "/app", destination: "/vault", permanent: true },
      { source: "/app/vault", destination: "/vault", permanent: true },
      { source: "/app/library", destination: "/library", permanent: true },
      { source: "/app/purge", destination: "/purge", permanent: true },
      { source: "/app/collections", destination: "/collections", permanent: true },
      { source: "/app/wishlist", destination: "/vault", permanent: true },
      { source: "/wishlist", destination: "/vault", permanent: true }
    ];
  },
  /**
   * PostHog is loaded and posted to directly rather than reverse-proxied through
   * this origin. The proxy existed to keep ad blockers from dropping analytics,
   * but every event batch, flags call and replay chunk it carried ran Routing
   * Middleware, which Vercel bills on the same Active CPU meter as functions.
   * Talking to PostHog directly costs coverage on blocked clients and nothing
   * else - their bundles come from their own CDN, cached on their schedule.
   */
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.cloudflare.steamstatic.com" },
      { protocol: "https", hostname: "cdn.akamai.steamstatic.com" },
      { protocol: "https", hostname: "shared.akamai.steamstatic.com" },
      { protocol: "https", hostname: "avatars.steamstatic.com" }
    ],
    formats: ["image/webp"],
    // 31 days: a longer cache means a given transformation is billed once and
    // then reused, rather than being recomputed after a day.
    minimumCacheTTL: 2678400,
    qualities: [75]
  }
};

export default nextConfig;
