"use client";

import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  ChefHat,
  Hospital,
  ShoppingBag,
  Trophy,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimateOnScroll, Button } from "@tesserix/web";

type Status = "live" | "soon";

interface Product {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  status: Status;
  icon: LucideIcon;
  website?: string;
  href: string;
  highlights: string[];
}

const products: Product[] = [
  {
    slug: "mark8ly",
    title: "Mark8ly",
    tagline: "Quiet commerce for people who make things",
    description:
      "An editorial commerce platform for independent merchants. Launch your storefront in an afternoon, keep every sale, and look considered from day one.",
    status: "live",
    icon: ShoppingBag,
    website: "mark8ly.com",
    href: "/products/mark8ly",
    highlights: [
      "90 days free, then from $19/mo",
      "0% transaction fees",
      "Custom domains",
      "Quiet, considered theme system",
    ],
  },
  {
    slug: "fanzone",
    title: "FanZone Battle Ground",
    tagline: "Your cricket opinions finally matter",
    description:
      "Live predictions, trash-talk battle rooms, and ranked fan leaderboards. Built for IPL die-hards, fantasy players, and anyone who watches with strong opinions.",
    status: "live",
    icon: Trophy,
    website: "fanzonebattleground.com",
    href: "/products/fanzone",
    highlights: [
      "Free to join — 50 pts on signup",
      "Live battle rooms",
      "Match-by-match prediction markets",
      "Ranked leaderboards",
    ],
  },
  {
    slug: "medicare",
    title: "MediCare",
    tagline: "Hospital management without the bloat",
    description:
      "End-to-end clinic and hospital operations — patient records, scheduling, billing, pharmacy, and lab. Designed for clinics that outgrew spreadsheets but never wanted enterprise software.",
    status: "soon",
    icon: Hospital,
    href: "/products/medicare",
    highlights: [
      "Electronic health records",
      "Appointment scheduling",
      "Pharmacy & inventory",
      "HIPAA-aligned",
    ],
  },
  {
    slug: "homechef",
    title: "HomeChef",
    tagline: "Home cooks, real customers",
    description:
      "A delivery platform that connects home chefs with food lovers in their community. Chef onboarding, menu management, and delivery coordination in one place.",
    status: "soon",
    icon: ChefHat,
    href: "/products/homechef",
    highlights: [
      "Chef onboarding & verification",
      "Menu management",
      "Real-time order tracking",
      "Delivery coordination",
    ],
  },
];

function StatusPill({ status }: { status: Status }) {
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
        <span
          className="h-1.5 w-1.5 rounded-full bg-success"
          aria-hidden="true"
        />
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
      Coming soon
    </span>
  );
}

function ProductCard({ product }: { product: Product }) {
  const Icon = product.icon;
  return (
    <article className="group flex flex-col rounded-2xl border bg-card p-6 transition-colors hover:border-foreground/30 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
            <Icon className="h-5 w-5 text-foreground" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {product.title}
            </h3>
            <p className="text-sm text-muted-foreground">{product.tagline}</p>
          </div>
        </div>
        <StatusPill status={product.status} />
      </div>

      <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
        {product.description}
      </p>

      <ul className="mt-5 grid grid-cols-1 gap-y-1.5 sm:grid-cols-2">
        {product.highlights.map((h) => (
          <li
            key={h}
            className="flex items-start gap-2 text-sm text-muted-foreground"
          >
            <span
              className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden="true"
            />
            {h}
          </li>
        ))}
      </ul>

      <div className="mt-7 flex flex-wrap items-center gap-3 border-t pt-5">
        {product.status === "live" && product.website ? (
          <Button asChild variant="default" size="sm">
            <a
              href={`https://${product.website}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Visit {product.website}
              <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm">
          <Link href={product.href}>
            {product.status === "live" ? "Learn more" : "Get notified"}
            <ArrowRight
              className="ml-1.5 h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </Button>
      </div>
    </article>
  );
}

export function ProductsGrid() {
  return (
    <section id="products" className="border-t py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up" className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Products
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Four products. Each one focused.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            We&apos;d rather make four products that do specific things well
            than one platform that does everything badly.
          </p>
        </AnimateOnScroll>

        <div className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {products.map((product) => (
            <ProductCard key={product.slug} product={product} />
          ))}
        </div>
      </div>
    </section>
  );
}
