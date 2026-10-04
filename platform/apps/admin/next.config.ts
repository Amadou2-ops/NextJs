import type { NextConfig } from "next";

/**
 * Back-office. Les en-têtes dépendant de la requête (CSP à nonce) sont posés
 * par src/proxy.ts ; ceux-ci s'appliquent à toutes les réponses. Le site
 * n'est jamais indexé, jamais encadré, et n'envoie aucun référent.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  productionBrowserSourceMaps: false,
  output: "standalone",
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), publickey-credentials-get=(self), publickey-credentials-create=(self), interest-cohort=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ]);
  },
};

export default nextConfig;
