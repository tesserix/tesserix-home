import { ImageResponse } from "next/og";
import { products } from "./products-data";

/**
 * Per-product OG image — Next 16 file convention for a dynamic segment.
 * Mirrors the root app/opengraph-image.tsx generator (same brand colors) but
 * swaps in the product's title and tagline instead of the studio-level copy,
 * so link unfurls for a product page show that product rather than the
 * generic Tesserix card. An unrecognized slug 404s before this ever
 * renders (see page.tsx's notFound()), so the generic-copy fallback below
 * only guards generateStaticParams drifting from `products`.
 */

export const alt = "Tesserix product";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

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
          background: "#0F172A",
          padding: "80px 96px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 22,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#94A3B8",
          }}
        >
          Tesserix — {eyebrow}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 72,
            fontWeight: 700,
            color: "#F8FAFC",
            letterSpacing: "-0.03em",
            lineHeight: 1.08,
          }}
        >
          <span>{heading}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ width: "80px", height: "4px", background: "#38BDF8" }} />
          <div style={{ display: "flex", fontSize: 28, color: "#CBD5E1" }}>{sub}</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
