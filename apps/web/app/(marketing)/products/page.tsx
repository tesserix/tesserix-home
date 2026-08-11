"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { AnimateOnScroll, Button } from "@tesserix/web";
import { isComingSoon, products as productsData } from "./[slug]/products-data";

type Status = "live" | "soon";

interface ProductEntry {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  status: Status;
  href: string;
  website?: string;
  features: string[];
}

// Title, tagline, description, highlights and launch state all come from
// products-data.ts — the single source of truth for product copy — rather
// than being restated here, where they had drifted (Mark8ly alone had three
// different descriptions across this file, products-grid.tsx and
// products-data.ts). Shipped products lead in products-data.ts; the
// numbering down the left is positional, so that ordering stays meaningful.
const products: ProductEntry[] = Object.entries(productsData).map(
  ([slug, product]) => ({
    slug,
    title: product.title,
    tagline: product.tagline,
    description: product.description,
    website: product.website?.replace(/^https?:\/\//, ""),
    features: product.highlights,
    href: `/products/${slug}`,
    status: isComingSoon(slug) ? ("soon" as const) : ("live" as const),
  }),
);

function StatusPill({ status }: { status: Status }) {
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 font-mono text-xs font-medium text-success">
        <span
          className="h-1.5 w-1.5 rounded-full bg-success"
          aria-hidden="true"
        />
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-0.5 font-mono text-xs font-medium text-muted-foreground">
      Coming soon
    </span>
  );
}

function ProductRow({
  product,
  index,
}: {
  product: ProductEntry;
  index: number;
}) {
  return (
    <article className="group relative -mx-4 rounded-xl px-4 transition-colors hover:bg-muted/40 sm:-mx-6 sm:px-6">
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 border-t py-10 sm:py-14 lg:grid-cols-12">
        <div className="flex items-center gap-4 lg:col-span-2 lg:flex-col lg:items-start">
          <span className="font-mono text-sm text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <StatusPill status={product.status} />
        </div>

        <div className="lg:col-span-4">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            <Link href={product.href} className="after:absolute after:inset-0">
              {product.title}
            </Link>
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {product.tagline}
          </p>
          {/* Destinations are only real for products you can use today — an
              unreleased one has nowhere to send anyone yet. Pricing lives on
              each product's own site, not here. */}
          {product.status === "live" && product.website ? (
            <a
              href={`https://${product.website}`}
              target="_blank"
              rel="noopener noreferrer"
              className="relative z-10 mt-2 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              {product.website}
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : null}
        </div>

        <div className="lg:col-span-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {product.description}
          </p>
          <ul className="mt-5 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {product.features.map((feature) => (
              <li
                key={feature}
                className="flex items-start gap-2 text-sm text-muted-foreground"
              >
                <span
                  className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60"
                  aria-hidden="true"
                />
                {feature}
              </li>
            ))}
          </ul>
        </div>

        <div className="hidden lg:col-span-1 lg:flex lg:items-start lg:justify-end">
          <ArrowUpRight
            className="h-5 w-5 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
            aria-hidden="true"
          />
        </div>
      </div>
    </article>
  );
}

export default function ProductsPage() {
  return (
    <div>
      {/* Header */}
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_70%_80%_at_50%_-10%,black,transparent)]"
        />
        <div className="relative mx-auto max-w-7xl px-6 py-16 sm:py-24 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-2xl">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Products
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl">
              The portfolio.
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              Five products, five industries. Each one focused on doing a
              specific job well — and nothing else.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* Index */}
      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="border-b">
            {products.map((product, index) => (
              <AnimateOnScroll
                key={product.title}
                variant="fade-up"
                delay={index * 0.05}
              >
                <ProductRow product={product} index={index} />
              </AnimateOnScroll>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up">
            <div className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-end">
              <div>
                <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Not sure which fits?
                </p>
                <h2 className="mt-4 max-w-xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  Tell us what you&apos;re building.
                </h2>
              </div>
              <Button size="lg" asChild>
                <Link href="/contact">
                  Get in touch
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </AnimateOnScroll>
        </div>
      </section>
    </div>
  );
}
