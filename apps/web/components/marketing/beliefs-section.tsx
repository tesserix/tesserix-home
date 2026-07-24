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
    <section className="relative border-t py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up" className="max-w-2xl">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            02 — Principles
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Three things we won&apos;t compromise on.
          </h2>
        </AnimateOnScroll>

        <div className="mt-16 grid grid-cols-1 gap-x-8 gap-y-14 lg:grid-cols-3">
          {beliefs.map((belief, index) => (
            <AnimateOnScroll
              key={belief.number}
              variant="fade-up"
              delay={index * 0.1}
            >
              <div className="group relative border-t pt-8">
                <span
                  aria-hidden="true"
                  className="font-mono text-6xl font-semibold tracking-tight text-muted-foreground/25 transition-colors duration-500 group-hover:text-muted-foreground/50 sm:text-7xl"
                >
                  {belief.number}
                </span>
                <h3 className="mt-6 text-xl font-semibold tracking-tight text-foreground">
                  {belief.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {belief.body}
                </p>
              </div>
            </AnimateOnScroll>
          ))}
        </div>
      </div>
    </section>
  );
}
