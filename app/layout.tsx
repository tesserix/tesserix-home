import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Tesserix - Commerce Infrastructure for Growing Businesses",
    template: "%s | Tesserix",
  },
  description:
    "Tesserix creates innovative SaaS solutions that empower businesses to thrive in the digital economy. Launch your marketplace in days with Mark8ly.",
  keywords: [
    "SaaS",
    "marketplace platform",
    "e-commerce",
    "multi-tenant",
    "business software",
    "Tesserix",
    "Mark8ly",
    "online marketplace",
    "commerce infrastructure",
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
    title: "Tesserix - Commerce Infrastructure for Growing Businesses",
    description:
      "Launch your marketplace in days, not months. Tesserix provides enterprise-grade commerce infrastructure for growing businesses.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Tesserix - Commerce Infrastructure",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tesserix - Commerce Infrastructure for Growing Businesses",
    description:
      "Launch your marketplace in days, not months. Enterprise-grade commerce infrastructure for growing businesses.",
    site: "@tesserix",
    creator: "@tesserix",
    images: ["/og-image.png"],
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

// JSON-LD structured data for organization
const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Tesserix",
  url: "https://tesserix.app",
  logo: "https://tesserix.app/logo.png",
  description:
    "Tesserix creates innovative SaaS solutions that empower businesses to thrive in the digital economy.",
  sameAs: [
    "https://twitter.com/tesserix",
    "https://linkedin.com/company/tesserix",
    "https://github.com/tesserix",
  ],
  contactPoint: {
    "@type": "ContactPoint",
    telephone: "+1-555-123-4567",
    contactType: "sales",
    email: "sales@tesserix.app",
  },
};

// JSON-LD for software product
const softwareSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Mark8ly",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "99",
    priceCurrency: "USD",
    priceValidUntil: "2025-12-31",
  },
  description:
    "Multi-tenant marketplace platform enabling businesses to launch and scale their own branded online stores.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
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
            __html: JSON.stringify(softwareSchema),
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
      </body>
    </html>
  );
}
