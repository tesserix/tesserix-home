"use client";

import { useRef } from "react";
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
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import type { MotionValue } from "framer-motion";
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
  iconClass: string;
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
    iconClass: "text-chart-5",
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
    iconClass: "text-success",
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
    iconClass: "text-info",
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
    iconClass: "text-warning",
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
                Four products.
                <br />
                Each one focused.
              </h2>
            </div>
            <div className="lg:col-span-5 lg:col-start-8 lg:self-end">
              <p className="text-lg leading-relaxed text-muted-foreground">
                We&apos;d rather make four products that do specific things
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
