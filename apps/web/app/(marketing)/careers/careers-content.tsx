"use client";

import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { AnimateOnScroll, Button } from "@tesserix/web";
import { principles } from "../about/principles";

const lookingFor = [
  "People who'd rather ship something small and useful than debate it for a quarter.",
  "A bias toward ownership — you notice what's broken and you fix it, without waiting to be asked.",
  "Craft. We care as much about the code nobody sees as the interface everybody does.",
  "Comfort with a small team's pace: fewer meetings, more building, direct feedback.",
];

export function CareersContent() {
  return (
    <div>
      {/* Header */}
      <section className="relative overflow-hidden border-b">
        <div className="relative mx-auto max-w-7xl px-6 py-16 sm:py-24 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-3xl">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Careers
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl">
              No open roles
              <br />
              <span className="text-muted-foreground">right now.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
              Tesserix is a two-person studio. We&apos;re not hiring at the
              moment — but we&apos;re always glad to hear from people who
              think the way we build software.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* What Tesserix is */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up">
            <p className="inline-flex items-center gap-2.5 font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              <span className="h-px w-9 bg-cobalt" aria-hidden="true" />
              What we are
            </p>
            <p className="mt-8 max-w-4xl text-2xl font-medium leading-snug tracking-tight text-foreground sm:text-3xl lg:text-4xl">
              Two people, building specialized SaaS products one industry at
              a time.{" "}
              <span className="text-muted-foreground">
                No platform play, no headcount targets, no roadmap built
                around hiring. Just focused software and the two of us
                building it.
              </span>
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* How we work — reused principles */}
      <section className="border-t py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-2xl">
            <p className="inline-flex items-center gap-2.5 font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              <span className="h-px w-9 bg-cobalt" aria-hidden="true" />
              How we work
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

      {/* What we look for */}
      <section className="border-t py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-2xl">
            <p className="inline-flex items-center gap-2.5 font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              <span className="h-px w-9 bg-cobalt" aria-hidden="true" />
              What we look for
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
              If a role opens, this is who we&apos;d want.
            </h2>
          </AnimateOnScroll>

          <div className="mt-14 max-w-3xl">
            <dl>
              {lookingFor.map((item, index) => (
                <div
                  key={item}
                  className="flex items-baseline gap-4 border-t py-4 first:border-t-0"
                >
                  <dt
                    aria-hidden="true"
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {String(index + 1).padStart(2, "0")}
                  </dt>
                  <dd className="leading-relaxed text-muted-foreground">
                    {item}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* Write-in CTA */}
      <section className="border-t py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up">
            <div className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-end">
              <div>
                <p className="inline-flex items-center gap-2.5 font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  <span className="h-px w-9 bg-cobalt" aria-hidden="true" />
                  Get in touch
                </p>
                <h2 className="mt-4 max-w-xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  Nothing open — write to us anyway.
                </h2>
                <p className="mt-4 max-w-xl leading-relaxed text-muted-foreground">
                  If you think you&apos;d be a good fit for how we build,
                  tell us why. No form to fill out — just an email.
                </p>
              </div>
              <div className="flex flex-wrap gap-4">
                <Button size="lg" asChild>
                  <a href="mailto:sales@tesserix.app">
                    <Mail className="mr-2 h-4 w-4" aria-hidden="true" />
                    sales@tesserix.app
                  </a>
                </Button>
                <Button size="lg" variant="ghost" asChild>
                  <Link href="/about">
                    About Tesserix
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </div>
          </AnimateOnScroll>
        </div>
      </section>
    </div>
  );
}
