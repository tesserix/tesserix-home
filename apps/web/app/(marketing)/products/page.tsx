"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { AnimateOnScroll, Button } from "@tesserix/web";
import { isComingSoon } from "./[slug]/products-data";

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

// Status comes from products-data.ts, the one place launch state is recorded,
// rather than being restated here where it had drifted out of date.
// Shipped products lead; the numbering down the left is positional, so ordering
// them this way keeps it meaningful rather than arbitrary.
const products: ProductEntry[] = (
  [
    {
      slug: "mark8ly",
      title: "Mark8ly",
      tagline: "Quiet commerce for people who make things",
      description:
        "An editorial commerce platform for independent merchants. Set up in an afternoon, keep your margins, and sell on a storefront that doesn't look like everyone else's.",
      website: "mark8ly.com",
      features: [
        "Custom domains",
        "0% transaction fees",
        "Considered theme system",
        "Up to 100 products on Starter",
        "Cards, UPI, and wallets",
        "Real human support",
      ],
    },
    {
      slug: "fe3dr",
      title: "Fe3dr",
      tagline: "Ghar ka khana, delivered.",
      description:
        "Real home-cooked food from verified kitchens near you. Cooked to order, collect it or have it delivered. Currently live in Pune.",
      website: "fe3dr.com",
      features: [
        "Verified home cooks",
        "Cooked to order",
        "Collection or delivery",
        "Live in Pune",
      ],
    },
    {
      slug: "dwellm8",
      title: "Dwellm8",
      tagline: "Rent, managed like a record",
      description:
        "India-first rental management — owners, managing firms and tenants on one record. Rent by UPI on an append-only ledger, maintenance with a liability answer, and the whole tenancy from listing to move-out.",
      website: "dwellm8.com",
      features: [
        "Tenancy agreements & rent schedules",
        "UPI rent collection, instant receipts",
        "Maintenance & cost-sharing engine",
        "Delegated portfolio management",
        "Listings, enquiries & applications",
        "Six mobile apps, one platform",
      ],
    },
    {
      slug: "medicare",
      title: "MediCare",
      tagline: "Hospital management without the bloat",
      description:
        "End-to-end clinic and hospital operations — patient records, scheduling, billing, pharmacy, and lab. Designed for clinics that outgrew spreadsheets but never wanted enterprise software.",
      features: [
        "Electronic health records",
        "Appointment scheduling",
        "Billing & invoicing",
        "Pharmacy & inventory",
        "Staff management",
        "Lab & diagnostics",
      ],
    },
  ] satisfies ReadonlyArray<Omit<ProductEntry, "status" | "href">>
).map((p) => ({
  ...p,
  href: `/products/${p.slug}`,
  status: isComingSoon(p.slug) ? ("soon" as const) : ("live" as const),
}));

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
              Four products, four industries. Each one focused on doing a
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
