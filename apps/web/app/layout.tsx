import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import { industryListPlain } from "./(marketing)/products/[slug]/products-data";
import { team } from "./(marketing)/about/team";
import { buildOrganizationSchema, buildWebSiteSchema } from "./seo/structured-data";
import "./globals.css";

const SITE_DESCRIPTION = `Tesserix is a small product studio building specialized SaaS — one industry at a time. ${industryListPlain()}.`;


const sans = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-app-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-app-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Tesserix — Specialized SaaS, One Industry at a Time",
    template: "%s | Tesserix",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "SaaS",
    "product studio",
    "Tesserix",
    "Mark8ly",
    "Fe3dr",
    "Dwellm8",
    "specialized software",
    "commerce platform",
    "home-cooked food delivery",
    "rental management software",
    "nutrition tracking",
  ],
  authors: [{ name: "Tesserix", url: "https://tesserix.app" }],
  creator: "Tesserix",
  publisher: "Tesserix",
  metadataBase: new URL("https://tesserix.app"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://tesserix.app",
    siteName: "Tesserix",
    title: "Tesserix — Specialized SaaS, One Industry at a Time",
    description: SITE_DESCRIPTION,
    // og:image is supplied by app/opengraph-image.tsx (Next file convention) —
    // an on-domain generated PNG. Do not re-add an explicit `images` here, or
    // it overrides the generated route and can point at a 404 again.
  },
  twitter: {
    card: "summary_large_image",
    title: "Tesserix — Specialized SaaS, One Industry at a Time",
    description: SITE_DESCRIPTION,
    site: "@tesserix_app",
    creator: "@tesserix_app",
    // twitter:image also comes from app/opengraph-image.tsx.
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
  verification: {
    google: "google-site-verification-code",
  },
};

// JSON-LD structured data for the company and site — see app/seo/structured-data.ts
// for the verified facts and why price/rating are deliberately never emitted.
// Per-product SoftwareApplication + BreadcrumbList schema lives on each
// product detail page instead of a single hardcoded product here.
const organizationSchema = buildOrganizationSchema(team);
const websiteSchema = buildWebSiteSchema();

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Prefill the support widget with the logged-in admin's identity (skips
  // OTP); anonymous visitors get the email-verification flow.
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(organizationSchema),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(websiteSchema),
          }}
        />
      </head>
      <body className="min-h-screen bg-background antialiased">
        {/* Skip to main content link for accessibility */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 bg-background border rounded-lg px-4 py-2 z-[100] font-medium"
        >
          Skip to main content
        </a>
        {children}
        {/* Otto support chat is admin-only — mounted in app/admin/layout.tsx.
            Public visitors use the /contact page instead. */}
      </body>
    </html>
  );
}
