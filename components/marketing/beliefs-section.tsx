"use client";

import { AnimateOnScroll } from "@tesserix/web";

const beliefs = [
  {
    number: "01",
    title: "Specialized over generic",
    body: "A tool built for one industry beats a platform that flexes for ten. Each Tesserix product is opinionated about its domain — and stays out of the others.",
  },
  {
    number: "02",
    title: "Pricing without surprises",
    body: "Flat plans, no transaction skim, no per-seat traps. You should know what you pay before you sign up, and the bill should look the same in month twelve as it did in month one.",
  },
  {
    number: "03",
    title: "Humans on the other end",
    body: "When you reach out, a person responds. We don't hide behind chatbots or queue you behind a knowledge base. Small team, real replies.",
  },
];

export function BeliefsSection() {
  return (
    <section className="border-t py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up" className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            What we believe
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Three things we won&apos;t compromise on.
          </h2>
        </AnimateOnScroll>

        <div className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border bg-border lg:grid-cols-3">
          {beliefs.map((b) => (
            <div key={b.number} className="bg-card p-8">
              <span className="font-mono text-sm font-medium text-muted-foreground">
                {b.number}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-foreground">
                {b.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {b.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
