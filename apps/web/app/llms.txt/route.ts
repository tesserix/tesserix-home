import { NextResponse } from "next/server";
import { products, productSlugs } from "@/app/(marketing)/products/[slug]/products-data";
import { COMPANY, SITE_URL } from "@/app/seo/structured-data";

/**
 * /llms.txt — the llms.txt convention (https://llmstxt.org): a short H1, a
 * blockquote summary, then linked sections with one-line descriptions, aimed
 * at LLMs reading the site rather than rendering it. The product list is
 * generated from products-data.ts so it can't drift from the real lineup.
 */

function buildLlmsTxt(): string {
  const productLines = productSlugs
    .map((slug) => {
      const product = products[slug];
      const status = product.status === "available" ? "live" : "coming soon";
      return `- [${product.title}](${SITE_URL}/products/${slug}): ${product.description} (${status})`;
    })
    .join("\n");

  return `# Tesserix

> ${COMPANY.description}

## Products

${productLines}

## Company

- [About](${SITE_URL}/about): Who we are and how we work.
- [Careers](${SITE_URL}/careers): Open roles (or the lack of them) at Tesserix.
- [Contact](${SITE_URL}/contact): How to reach the team.

## Legal

- [Privacy Policy](${SITE_URL}/privacy): How Tesserix collects and uses personal data.
- [Terms of Service](${SITE_URL}/terms): The terms that govern use of Tesserix products.
- [Cookie Policy](${SITE_URL}/cookies): How Tesserix uses cookies and similar technologies.
`;
}

export function GET() {
  return new NextResponse(buildLlmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
