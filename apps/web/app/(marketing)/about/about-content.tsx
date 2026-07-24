"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AnimateOnScroll, Button } from "@tesserix/web";

const principles = [
  {
    number: "01",
    title: "Small on purpose",
    body: "We're a small team by choice. Fewer layers means faster decisions — and the person fixing your bug is usually the person who wrote the feature.",
  },
  {
    number: "02",
    title: "Opinionated by default",
    body: "Good tools make choices. We'd rather ship strong defaults you can override than a settings page with forty toggles nobody understands.",
  },
  {
    number: "03",
    title: "Ship fast, fix faster",
    body: "We'd rather get something useful in your hands today than something perfect next year — and then improve it every single week.",
  },
  {
    number: "04",
    title: "Built to last",
    body: "Fair prices for working software, so we're still here in ten years. No growth hacks, no dark patterns, no surprise pivots.",
  },
];

const focus = [
  { area: "Commerce", product: "Mark8ly", status: "Live" },
  { area: "Sports", product: "FanZone Battle Ground", status: "Live" },
  { area: "Healthcare", product: "MediCare", status: "In development" },
  { area: "Food", product: "HomeChef", status: "In development" },
];

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

      {/* How we work */}
      <section className="border-t py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-2xl">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              02 — How we work
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
                  03 — Next
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
