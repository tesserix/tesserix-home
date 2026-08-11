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
 * dividers, muted secondary text): every band shares the site-wide
 * `max-w-7xl px-6 lg:px-8` rail so the body copy hangs off the same left edge
 * as the title, rather than sitting in its own centred column. Line length is
 * handled per-paragraph in `LegalSection` instead.
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
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
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
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="max-w-3xl">{children}</div>
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
 *
 * The body is capped at `max-w-prose` (65ch) rather than filling the column —
 * long-form policy text is the one place on the site where measure, not
 * column width, sets the line length. Each section animates in on its own,
 * matching how every other list on the site reveals section by section.
 */
export function LegalSection({ number, title, children }: LegalSectionProps) {
  return (
    // The divider lives on the AnimateOnScroll wrapper, not the inner
    // <section> — the wrappers are the siblings in the flow, so `first:` has
    // to resolve against them for the leading rule to be suppressed.
    <AnimateOnScroll
      variant="fade-up"
      className="block border-t py-10 first:border-t-0 first:pt-0"
    >
      <section>
        <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {number}
        </p>
        <h2 className="mt-3 text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        <div className="mt-5 max-w-prose space-y-4 leading-relaxed text-muted-foreground">
          {children}
        </div>
      </section>
    </AnimateOnScroll>
  );
}
