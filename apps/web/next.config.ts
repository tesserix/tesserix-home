import type { NextConfig } from "next";
import path from "node:path";

/**
 * Security Headers Configuration for Tesserix Homepage & Admin Portal
 */

const nextConfig: NextConfig = {
  output: 'standalone',

  // Trace files from the monorepo root so the standalone bundle includes the
  // hoisted workspace node_modules (server.js emits at apps/web/server.js).
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),

  // @tesserix/otto-widget ships raw TypeScript source (no dist/) — Next.js
  // must transpile it from node_modules or the build fails with
  // "Unknown module type" on its src/index.ts.
  transpilePackages: ['@tesserix/otto-widget'],

  async redirects() {
    return [
      {
        source: "/products/homechef",
        destination: "/products/fe3dr",
        permanent: true,
      },
      {
        source: "/products/fanzone",
        destination: "/products",
        permanent: true,
      },
      {
        source: "/launch",
        destination: "/products",
        permanent: true,
      },
      {
        source: "/launch/:slug",
        destination: "/products",
        permanent: true,
      },

      // The six admin pages #199 and #207 retired into the console had
      // redirects here. Both the pages and the redirects are back to the
      // pre-#199 arrangement: nothing under /admin/ is retired until the
      // console app is complete, so /admin/platform-tickets,
      // /admin/platform-tickets/:id, /admin/analytics/support and the three
      // product audit pages SERVE rather than redirect. The console's own
      // surfaces are untouched and reachable at their own origin — the two
      // systems run side by side and read the same API.
      //
      // next.config.test.ts asserts, against Next's own matcher, that none of
      // the six matches a redirect. That is the guard: a future redirect added
      // for any of them is the retirement this rule forbids.

      // Deliberately NOT /admin/support/live-chat: #197 owns that surface, it
      // has no console equivalent yet, and it must keep working here.
    ];
  },

  async headers() {
    const cspDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com https://analytics.tesserix.app",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://storage.googleapis.com https://*.tesserix.app https://images.unsplash.com",
      "font-src 'self' data:",
      "connect-src 'self' https://*.tesserix.app wss://*.tesserix.app https://storage.googleapis.com https://api.posthog.com",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "media-src 'self'",
      "manifest-src 'self'",
      ...(process.env.NODE_ENV === 'production' ? ["upgrade-insecure-requests"] : []),
    ].join('; ');

    const permissionsPolicy = [
      'accelerometer=()',
      'autoplay=(self)',
      'camera=()',
      'encrypted-media=(self)',
      'fullscreen=(self)',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'picture-in-picture=(self)',
      'publickey-credentials-get=()',
      'screen-wake-lock=()',
      'sync-xhr=()',
      'usb=()',
      'web-share=(self)',
      'xr-spatial-tracking=()',
    ].join(', ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: permissionsPolicy },
          { key: 'Content-Security-Policy', value: cspDirectives },
          { key: 'Cross-Origin-Embedder-Policy', value: 'unsafe-none' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: process.env.NEXT_PUBLIC_ALLOWED_ORIGIN || (process.env.NODE_ENV === 'development' ? 'http://localhost:3002' : '') },
          { key: 'Access-Control-Allow-Methods', value: 'GET,OPTIONS,PATCH,DELETE,POST,PUT' },
          { key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization' },
          { key: 'Access-Control-Max-Age', value: '86400' },
        ],
      },
    ];
  },

  env: {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3002',
  },

  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
    optimizePackageImports: ['@tesserix/web'],
  },

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.tesserix.app',
      },
      {
        protocol: 'https',
        hostname: 'storage.googleapis.com',
      },
      {
        protocol: 'http',
        hostname: 'localhost',
      },
    ],
  },

  typescript: {
    ignoreBuildErrors: false,
  },

  // Ship browser source maps so a production stack trace names the real
  // component and file. Without them a client-side failure reduces to a
  // minified React error code, which cannot be diagnosed from the console.
  productionBrowserSourceMaps: true,
};

export default nextConfig;
