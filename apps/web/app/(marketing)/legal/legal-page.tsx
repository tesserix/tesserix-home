"use client";

import type { ReactNode } from "react";
import { AnimateOnScroll } from "@tesserix/web";

/**
 * Single source of truth for the "last updated" date shown on every legal
 * page. Deliberately not `new Date()` — a static build must not render a
 * misleading always-today date.
 */
export const LAST_UPDATED = "11 August 2026";

interface LegalPageProps {
  eyebrow: string;
  title: string;
  description: string;
  lastUpdated: string;
  children: ReactNode;
}

/**
 * Shared presentational shell for /privacy, /terms and /cookies. Matches the
 * marketing site's editorial language (mono uppercase eyebrow, hairline
 * dividers, muted secondary text) but narrows the body measure to `max-w-3xl`
 * for readability, since these pages are long-form prose rather than
 * marketing sections.
 */
export function LegalPage({
  eyebrow,
  title,
  description,
  lastUpdated,
  children,
}: LegalPageProps) {
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
              {eyebrow}
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl">
              {title}
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
              {description}
            </p>
            <p className="mt-6 font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">
              Last updated: {lastUpdated}
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* Product-specific policies note */}
      <section className="border-b bg-muted/30 py-6">
        <div className="mx-auto max-w-3xl px-6 lg:px-8">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This is Tesserix&apos;s general policy. Individual products may
            publish their own — Fe3dr, for example, maintains its own
            policies at{" "}
            <a
              href="https://fe3dr.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline-offset-4 hover:underline"
            >
              fe3dr.com
            </a>
            .
          </p>
        </div>
      </section>

      {/* Body */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-3xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up">{children}</AnimateOnScroll>
        </div>
      </section>
    </div>
  );
}

interface LegalSectionProps {
  number: string;
  title: string;
  children: ReactNode;
}

/**
 * A single numbered section within a legal page: hairline `border-t` divider
 * (matching the "How we work" pattern on /about), a heading, and prose body.
 */
export function LegalSection({ number, title, children }: LegalSectionProps) {
  return (
    <section className="border-t py-8 first:border-t-0 first:pt-0">
      <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {number}
      </p>
      <h2 className="mt-3 text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}
