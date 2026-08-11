"use client";

import { useRef } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  ChefHat,
  Hospital,
  Salad,
  ShoppingBag,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import type { MotionValue } from "framer-motion";
import { AnimateOnScroll, AppStoreBadges, Button } from "@tesserix/web";
import {
  isComingSoon,
  products as productsData,
} from "@/app/(marketing)/products/[slug]/products-data";

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
  iconClass: string;
  listings?: Partial<
    Record<"ios" | "android", { url: string; artworkSrc: string }>
  >;
}

// Card accent colors are purely presentational and have no equivalent in
// products-data.ts, so they stay here keyed by slug.
const ICON_CLASSES: Record<string, string> = {
  mark8ly: "text-chart-5",
  fe3dr: "text-warning",
  dwellm8: "text-primary",
  medicare: "text-info",
  kora: "text-success",
};

const ICONS: Record<string, LucideIcon> = {
  mark8ly: ShoppingBag,
  fe3dr: ChefHat,
  dwellm8: Building2,
  medicare: Hospital,
  kora: Salad,
};

// Title, tagline, description, highlights and launch state all come from
// products-data.ts — the single source of truth for product copy — rather
// than being restated here, where they had drifted (Mark8ly alone had three
// different descriptions across this file, products/page.tsx and
// products-data.ts). Cards scroll-stack in the order products-data lists
// them, which already leads with shipped products.
const products: Product[] = Object.entries(productsData).map(
  ([slug, product]) => ({
    slug,
    title: product.title,
    tagline: product.tagline,
    description: product.description,
    icon: ICONS[slug] ?? ShoppingBag,
    website: product.website?.replace(/^https?:\/\//, ""),
    href: `/products/${slug}`,
    highlights: product.highlights,
    iconClass: ICON_CLASSES[slug] ?? "text-foreground",
    status: isComingSoon(slug) ? ("soon" as const) : ("live" as const),
    // Only the customer-facing app belongs here — Fe3dr's vendor app is a
    // second audience shown on the product detail page, not the homepage card.
    listings: product.listings,
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

interface StackCardProps {
  product: Product;
  index: number;
  total: number;
  progress: MotionValue<number>;
  reducedMotion: boolean;
}

function StackCard({
  product,
  index,
  total,
  progress,
  reducedMotion,
}: StackCardProps) {
  const Icon = product.icon;

  // As the next card scrolls over, this one settles back and dims — Apple deck style
  const targetScale = 1 - (total - 1 - index) * 0.045;
  const scale = useTransform(progress, [index / total, 1], [1, targetScale]);

  return (
    <div
      className="sticky"
      style={{ top: `calc(7rem + ${index * 1.75}rem)` }}
    >
      <motion.article
        style={reducedMotion ? undefined : { scale }}
        className="group relative mb-10 origin-top overflow-hidden rounded-3xl border bg-card shadow-xl"
      >
        <Icon
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-10 -right-10 h-56 w-56 text-foreground/[0.03] sm:h-72 sm:w-72"
        />

        <div className="relative grid grid-cols-1 gap-x-12 gap-y-8 p-8 sm:p-12 lg:grid-cols-2">
          <div>
            <div className="flex items-center gap-4">
              <span className="font-mono text-sm text-muted-foreground">
                {String(index + 1).padStart(2, "0")} /{" "}
                {String(total).padStart(2, "0")}
              </span>
              <StatusPill status={product.status} />
            </div>

            <div className="mt-6 flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-muted/50">
                <Icon
                  className={`h-6 w-6 ${product.iconClass}`}
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                {product.title}
              </h3>
            </div>
            <p className="mt-3 text-base text-muted-foreground">
              {product.tagline}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {product.status === "live" && product.website ? (
                <Button asChild size="default">
                  <a
                    href={`https://${product.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Visit {product.website}
                    <ArrowUpRight
                      className="ml-1.5 h-4 w-4"
                      aria-hidden="true"
                    />
                  </a>
                </Button>
              ) : null}
              <Button asChild variant="outline" size="default">
                <Link href={product.href}>
                  {product.status === "live" ? "Learn more" : "Get notified"}
                  <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            </div>

            {product.listings && (
              <AppStoreBadges
                className="mt-6"
                appName={product.title}
                listings={product.listings}
                placeholder="coming-soon"
              />
            )}
          </div>

          <div className="lg:border-l lg:pl-12">
            <p className="text-base leading-relaxed text-muted-foreground">
              {product.description}
            </p>
            <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {product.highlights.map((highlight) => (
                <li
                  key={highlight}
                  className="flex items-start gap-2.5 text-sm text-muted-foreground"
                >
                  <span
                    className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60"
                    aria-hidden="true"
                  />
                  {highlight}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </motion.article>
    </div>
  );
}

export function ProductsGrid() {
  const prefersReducedMotion = useReducedMotion();
  const stackRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: stackRef,
    offset: ["start start", "end end"],
  });

  return (
    <section id="products" className="relative border-t py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up">
          <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-12">
            <div className="lg:col-span-6">
              <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                01 — Products
              </p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
                Five products.
                <br />
                Each one focused.
              </h2>
            </div>
            <div className="lg:col-span-5 lg:col-start-8 lg:self-end">
              <p className="text-lg leading-relaxed text-muted-foreground">
                We&apos;d rather make five products that do specific things
                well than one platform that does everything badly.
              </p>
            </div>
          </div>
        </AnimateOnScroll>

        <div ref={stackRef} className="relative mt-16">
          {products.map((product, index) => (
            <StackCard
              key={product.slug}
              product={product}
              index={index}
              total={products.length}
              progress={scrollYProgress}
              reducedMotion={Boolean(prefersReducedMotion)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
