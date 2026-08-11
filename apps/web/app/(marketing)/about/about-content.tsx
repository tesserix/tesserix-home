"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AnimateOnScroll, Button } from "@tesserix/web";
import { principles } from "./principles";
import { team } from "./team";
import { TeamMemberCard } from "@/components/marketing/team-member-card";
import type { Industry } from "../products/[slug]/products-data";
import {
  isComingSoon,
  productSlugs,
  products,
} from "../products/[slug]/products-data";

/** Human-readable label for each industry the portfolio covers. */
const industryLabels: Record<Industry, string> = {
  commerce: "Commerce",
  food: "Food",
  rentals: "Rental management",
  healthcare: "Healthcare",
  nutrition: "Nutrition",
};

// One row per product, in portfolio order, derived from products-data.ts —
// the one place launch state and the industry mapping are recorded. This list
// used to be hand-maintained and had drifted: it omitted Kora entirely while
// the copy beside it promises one product per industry.
const focus = productSlugs.map((slug) => ({
  area: industryLabels[products[slug].industry],
  product: products[slug].title,
  status: isComingSoon(slug) ? "In development" : "Live",
}));

export function AboutContent() {
  return (
    <div>
      {/* Header */}
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_70%_80%_at_50%_-10%,black,transparent)]"
        />
        <div className="relative mx-auto max-w-7xl px-6 py-16 sm:py-24 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-3xl">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              About
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl">
              A small studio
              <br />
              <span className="text-muted-foreground">
                with strong opinions.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
              Tesserix builds specialized SaaS products — one industry at a
              time. No platform play, no feature checklists. Just focused
              software for people who are tired of tools that almost fit.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* Why we exist */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              01 — Why we exist
            </p>
            <p className="mt-8 max-w-4xl text-2xl font-medium leading-snug tracking-tight text-foreground sm:text-3xl lg:text-4xl">
              Too many businesses choose between expensive enterprise suites
              and flimsy consumer tools.{" "}
              <span className="text-muted-foreground">
                We build the missing middle — software that's specialized,
                affordable, and genuinely good at the one job it was hired to
                do.
              </span>
            </p>
          </AnimateOnScroll>

          <div className="mt-16 grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <p className="leading-relaxed text-muted-foreground">
                We started with Mark8ly because launching an online store
                shouldn&apos;t require a developer or a fortune. Each product
                since follows the same recipe: pick one industry, learn it
                deeply, and build the tool we&apos;d want if it were our
                business.
              </p>
            </div>
            <div className="lg:col-span-6 lg:col-start-7">
              <dl>
                {focus.map((item) => (
                  <div
                    key={item.area}
                    className="flex items-baseline justify-between gap-4 border-t py-4"
                  >
                    <dt className="flex items-baseline gap-3">
                      <span className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">
                        {item.area}
                      </span>
                      <span className="font-semibold text-foreground">
                        {item.product}
                      </span>
                    </dt>
                    <dd className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          item.status === "Live"
                            ? "bg-success"
                            : "bg-muted-foreground/50"
                        }`}
                        aria-hidden="true"
                      />
                      {item.status}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </section>

      {/* Who we are */}
      <section className="border-t py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-2xl">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              02 — Who we are
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
              The two people behind Tesserix.
            </h2>
          </AnimateOnScroll>

          {/* `mt-14` matches "How we work" below, so the first card's hairline
              reads as a section divider rather than an underline on the h2. */}
          <div className="mt-14 max-w-3xl">
            {team.map((member, index) => (
              <AnimateOnScroll
                key={member.slug}
                variant="fade-up"
                delay={index * 0.08}
              >
                <TeamMemberCard member={member} />
              </AnimateOnScroll>
            ))}
          </div>
        </div>
      </section>

      {/* How we work */}
      <section className="border-t py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-2xl">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              03 — How we work
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
              The rules we run on.
            </h2>
          </AnimateOnScroll>

          <div className="mt-14 grid grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2">
            {principles.map((principle, index) => (
              <AnimateOnScroll
                key={principle.number}
                variant="fade-up"
                delay={index * 0.08}
              >
                <div className="group border-t pt-8">
                  <span
                    aria-hidden="true"
                    className="font-mono text-5xl font-semibold tracking-tight text-muted-foreground/25 transition-colors duration-500 group-hover:text-muted-foreground/50 sm:text-6xl"
                  >
                    {principle.number}
                  </span>
                  <h3 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
                    {principle.title}
                  </h3>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                    {principle.body}
                  </p>
                </div>
              </AnimateOnScroll>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up">
            <div className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-end">
              <div>
                <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  04 — Next
                </p>
                <h2 className="mt-4 max-w-xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  See what we&apos;re building.
                </h2>
              </div>
              <div className="flex flex-wrap gap-4">
                <Button size="lg" asChild>
                  <Link href="/products">
                    Explore the products
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
                <Button size="lg" variant="ghost" asChild>
                  <Link href="/contact">Get in touch</Link>
                </Button>
              </div>
            </div>
          </AnimateOnScroll>
        </div>
      </section>
    </div>
  );
}
