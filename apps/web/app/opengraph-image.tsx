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
 * Brand: "Structured Light" identity — warm-white ground with a subtle
 * blueprint grid, ink typography, a single cobalt accent, and a line-art
 * rendering of the nested-cube (tesseract) mark.
 */

export const alt =
  "Tesserix — specialized software, built for the people who use it.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GRID_LINE = "rgba(11,14,20,0.03)";

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          background: "#f5f7fa",
          backgroundImage: `repeating-linear-gradient(to right, ${GRID_LINE} 0px, ${GRID_LINE} 1px, transparent 1px, transparent 72px), repeating-linear-gradient(to bottom, ${GRID_LINE} 0px, ${GRID_LINE} 1px, transparent 1px, transparent 72px)`,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Left content column */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: "760px",
            height: "100%",
            padding: "80px",
          }}
        >
          {/* Kicker */}
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div style={{ width: "36px", height: "2px", background: "#2e5cff" }} />
            <div
              style={{
                display: "flex",
                fontSize: 20,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#6f7686",
                fontFamily: "monospace",
              }}
            >
              A PRODUCT STUDIO
            </div>
          </div>

          {/* Headline */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              fontSize: 64,
              fontWeight: 650,
              color: "#0b0e14",
              letterSpacing: "-2px",
              lineHeight: 1.05,
              maxWidth: "700px",
            }}
          >
            <span>Specialized software, built for the&nbsp;</span>
            <span style={{ color: "#2e5cff" }}>people</span>
            <span>&nbsp;who use it.</span>
          </div>

          {/* Bottom row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontSize: 20,
              color: "#6f7686",
              fontFamily: "monospace",
            }}
          >
            <span>tesserix.app</span>
            <span style={{ margin: "0 14px" }}>·</span>
            <span>Mark8ly · Fe3dr · Dwellm8 · MediCare · Kora</span>
          </div>
        </div>

        {/* Right: line-art tesseract mark */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="280"
            height="280"
            viewBox="0 0 280 280"
            style={{ transform: "rotate(-8deg)" }}
          >
            {/* Back square (outer) */}
            <rect
              x="20"
              y="20"
              width="180"
              height="180"
              fill="none"
              stroke="#0b0e14"
              strokeWidth="2"
            />
            {/* Front square (offset, accent) */}
            <rect
              x="80"
              y="80"
              width="180"
              height="180"
              fill="none"
              stroke="#1f3fd4"
              strokeWidth="2"
            />
            {/* Connecting corner lines */}
            <line x1="20" y1="20" x2="80" y2="80" stroke="#0b0e14" strokeWidth="1.5" />
            <line x1="200" y1="20" x2="260" y2="80" stroke="#0b0e14" strokeWidth="1.5" />
            <line x1="20" y1="200" x2="80" y2="260" stroke="#0b0e14" strokeWidth="1.5" />
            <line
              x1="200"
              y1="200"
              x2="260"
              y2="260"
              stroke="#0b0e14"
              strokeWidth="1.5"
            />
          </svg>
        </div>
      </div>
    ),
    { ...size },
  );
}
