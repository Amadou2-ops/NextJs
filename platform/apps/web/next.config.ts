import type { NextConfig } from "next";

/**
 * Site client. Les en-têtes de sécurité dynamiques (CSP à nonce) sont posés
 * par src/proxy.ts ; ceux qui ne dépendent pas de la requête le sont ici.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  productionBrowserSourceMaps: false,
  // Image autonome pour le conteneur (phase 14).
  output: "standalone",
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(self \"https://js.stripe.com\"), usb=(), interest-cohort=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ]);
  },
};

export default nextConfig;
