"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { AnimateOnScroll, Button } from "@tesserix/web";

type Status = "live" | "soon";

interface ProductEntry {
  title: string;
  tagline: string;
  description: string;
  status: Status;
  href: string;
  website?: string;
  pricing?: string;
  features: string[];
}

const products: ProductEntry[] = [
  {
    title: "Mark8ly",
    tagline: "Quiet commerce for people who make things",
    description:
      "An editorial commerce platform for independent merchants. Set up in an afternoon, keep your margins, and sell on a storefront that doesn't look like everyone else's.",
    status: "live",
    href: "/products/mark8ly",
    website: "mark8ly.com",
    pricing: "90 days free, then from $19/mo",
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
    title: "FanZone Battle Ground",
    tagline: "Your cricket opinions finally matter",
    description:
      "Live predictions, trash-talk battle rooms, and ranked fan leaderboards. Built for IPL die-hards, fantasy players, and anyone who watches with strong opinions.",
    status: "live",
    href: "/products/fanzone",
    website: "fanzonebattleground.com",
    pricing: "Free to join — 50 pts on signup",
    features: [
      "Live battle rooms",
      "Match prediction markets",
      "Ranked leaderboards",
      "Hot takes & fan connect",
      "Live match scores",
      "Match alerts",
    ],
  },
  {
    title: "MediCare",
    tagline: "Hospital management without the bloat",
    description:
      "End-to-end clinic and hospital operations — patient records, scheduling, billing, pharmacy, and lab. Designed for clinics that outgrew spreadsheets but never wanted enterprise software.",
    status: "soon",
    href: "/products/medicare",
    features: [
      "Electronic health records",
      "Appointment scheduling",
      "Billing & invoicing",
      "Pharmacy & inventory",
      "Staff management",
      "Lab & diagnostics",
    ],
  },
  {
    title: "HomeChef",
    tagline: "Home cooks, real customers",
    description:
      "A delivery platform that connects home chefs with food lovers in their community. Chef onboarding, menu management, and delivery coordination in one place.",
    status: "soon",
    href: "/products/homechef",
    features: [
      "Chef onboarding & verification",
      "Menu management",
      "Real-time order tracking",
      "Delivery coordination",
      "Customer reviews & ratings",
      "Payment processing",
    ],
  },
];

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
          {product.pricing ? (
            <p className="mt-4 font-mono text-xs text-foreground">
              {product.pricing}
            </p>
          ) : null}
          {product.website ? (
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
