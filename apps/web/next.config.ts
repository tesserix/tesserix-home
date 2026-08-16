import type { NextConfig } from "next";
import path from "node:path";

/**
 * Security Headers Configuration for Tesserix Homepage & Admin Portal
 */

/**
 * Where the retired admin surfaces now live.
 *
 * Kept in lockstep with `CONSOLE_ORIGIN` in `apps/console/lib/platform-api.ts`:
 * that one names this app to satisfy its CSRF gate, this one names the console
 * to send a browser there. Same host, opposite direction.
 */
export const CONSOLE_ORIGIN =
  process.env.CONSOLE_PUBLIC_ORIGIN ?? "https://console.tesserix.app";

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

      // Retired to apps/console (#133). The pages here are deleted, so without
      // these a bookmark — or one of this app's own remaining nav links — 404s.
      //
      // Next re-appends any query param the destination path did not consume,
      // which is load-bearing rather than incidental: the console's queue reads
      // ?status, ?priority and ?product. Asserted in next.config.test.ts against
      // Next's own matcher, not assumed from the docs.
      {
        source: "/admin/platform-tickets",
        destination: `${CONSOLE_ORIGIN}/platform/tickets`,
        permanent: true,
      },
      {
        source: "/admin/platform-tickets/:id",
        destination: `${CONSOLE_ORIGIN}/platform/tickets/:id`,
        permanent: true,
      },
      // Support analytics is a tab on the queue now, not a page of its own.
      // The active tab is local state, not a query param (see the console's
      // surface-tabs.tsx, which says why), so this lands on the queue with
      // Analytics one click away rather than deep-linking the tab.
      {
        source: "/admin/analytics/support",
        destination: `${CONSOLE_ORIGIN}/platform/tickets`,
        permanent: true,
      },
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
