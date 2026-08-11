import { ImageResponse } from "next/og";
import { products } from "./products-data";

/**
 * Per-product OG image — Next 16 file convention for a dynamic segment.
 * Mirrors the root app/opengraph-image.tsx generator (same "Structured
 * Light" ground, blueprint grid, ink/cobalt/muted palette, and word-level
 * headline spans) but swaps in the product's title and tagline instead of
 * the studio-level copy, so link unfurls for a product page show that
 * product rather than the generic Tesserix card. An unrecognized slug 404s
 * before this ever renders (see page.tsx's notFound()), so the
 * generic-copy fallback below only guards generateStaticParams drifting
 * from `products`.
 */

export const alt = "Tesserix product";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GRID_LINE = "rgba(11,14,20,0.03)";

export async function generateStaticParams() {
  return Object.keys(products).map((slug) => ({ slug }));
}

export default async function ProductOpenGraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = products[slug];
  const eyebrow = product ? product.title : "Tesserix";
  const heading = product ? product.tagline : "Specialized SaaS, one industry at a time.";
  const sub = product
    ? product.description
    : "A small product studio building specialized software.";

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          background: "#f5f7fa",
          backgroundImage: `repeating-linear-gradient(to right, ${GRID_LINE} 0px, ${GRID_LINE} 1px, transparent 1px, transparent 72px), repeating-linear-gradient(to bottom, ${GRID_LINE} 0px, ${GRID_LINE} 1px, transparent 1px, transparent 72px)`,
          padding: "80px 96px",
          fontFamily: "system-ui, sans-serif",
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
              color: "#5f6675",
              fontFamily: "monospace",
            }}
          >
            Tesserix — {eyebrow}
          </div>
        </div>

        {/* Headline — word-level spans for deterministic wrap in satori */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            fontSize: 64,
            fontWeight: 600,
            color: "#0b0e14",
            letterSpacing: "-2px",
            lineHeight: 1.05,
            maxWidth: "980px",
          }}
        >
          {heading.split(" ").map((word, index) => (
            <span key={`${word}-${index}`} style={{ marginRight: "14px" }}>
              {word}
            </span>
          ))}
        </div>

        {/* Sub / description */}
        <div
          style={{
            display: "flex",
            fontSize: 26,
            color: "#5f6675",
            maxWidth: "820px",
            lineHeight: 1.35,
          }}
        >
          {sub}
        </div>
      </div>
    ),
    { ...size },
  );
}
