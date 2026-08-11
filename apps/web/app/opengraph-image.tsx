import { ImageResponse } from "next/og";

/**
 * OpenGraph image — Next 16 file convention. Generated at build into a
 * 1200x630 PNG served on-domain as /opengraph-image, and automatically
 * wired into <meta property="og:image"> + <meta name="twitter:image"> by
 * the metadata API. Replaces the old /og-image.png reference, which 404'd
 * and made link unfurls (LinkedIn, Slack, X) fail. Mirrors the working
 * mark8ly generator so previews stay on-domain and always return 200.
 *
 * Every product page under /products/[slug] gets its own generated image
 * (see that route's opengraph-image.tsx); every other marketing page falls
 * back to this root one automatically via Next's metadata resolution.
 *
 * Brand: deep slate (#0F172A) on which the Tesserix wordmark sits — the
 * same navy used for --primary/--foreground and the mobile splash.
 */

export const alt = "Tesserix — specialized SaaS, one industry at a time.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          background: "#0F172A",
          padding: "80px 96px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Top eyebrow */}
        <div
          style={{
            display: "flex",
            fontSize: 22,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#94A3B8",
          }}
        >
          Tesserix
        </div>

        {/* Main typographic moment */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 96,
            fontWeight: 700,
            color: "#F8FAFC",
            letterSpacing: "-0.03em",
            lineHeight: 1.02,
          }}
        >
          <span>Specialized software,</span>
          <span>built for the people who use it.</span>
        </div>

        {/* Bottom: accent rule + tagline */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ width: "80px", height: "4px", background: "#38BDF8" }} />
          <div style={{ display: "flex", fontSize: 30, color: "#CBD5E1" }}>
            A product studio building specialized SaaS, one industry at a time.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
