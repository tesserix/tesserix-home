"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import {
  Button,
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
  AnimateOnScroll,
  AppStoreBadges,
} from "@tesserix/web";
import { WaitlistForm } from "@/components/marketing/waitlist-form";
import { products } from "./products-data";

// Pricing lives on each product's own site — the only place it can stay
// accurate (Mark8ly's is location-based, so no static figure here would be
// correct for every visitor). Only products with a public pricing page get
// a link out; the rest render nothing in that slot.
const PRICING_LINKS: Record<string, string> = {
  mark8ly: "https://mark8ly.com/#pricing",
};

export function ProductContent({ slug }: { slug: string }) {
  const product = products[slug];

  if (!product) {
    notFound();
  }

  const isComingSoon = product.status === "coming-soon";
  const pricingLink = PRICING_LINKS[slug];

  return (
    <div>
      {/* Header */}
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_70%_80%_at_50%_-10%,black,transparent)]"
        />
        <div className="relative mx-auto max-w-7xl px-6 py-12 sm:py-16 lg:px-8">
          <Breadcrumb className="mb-10">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="/products">Products</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{product.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <AnimateOnScroll variant="fade-up" className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-4">
              {isComingSoon ? (
                <span className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-0.5 font-mono text-xs font-medium text-muted-foreground">
                  Coming soon
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 font-mono text-xs font-medium text-success">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-success"
                    aria-hidden="true"
                  />
                  Live
                </span>
              )}
            </div>
            <h1 className="mt-5 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl">
              {product.title}
            </h1>
            <p className="mt-4 text-xl text-muted-foreground">
              {product.tagline}
            </p>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              {product.longDescription}
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-4">
              {isComingSoon ? (
                <WaitlistForm slug={slug} title={product.title} />
              ) : (
                <Button size="lg" asChild>
                  <Link href="/contact">
                    Start free trial
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
              )}
              {/* An unreleased product has nowhere to send people yet. */}
              {!isComingSoon && product.website && (
                <a
                  href={product.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-mono text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {product.website.replace("https://", "")}
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
            </div>
            {/* The signup form carries its own microcopy, so this would repeat it. */}
            {!isComingSoon && (
              <p className="mt-4 text-sm text-muted-foreground">
                No credit card required · 14-day free trial
              </p>
            )}

            {product.listings && (
              <div className="mt-8 space-y-4">
                {product.vendorListing && (
                  <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                    For diners
                  </p>
                )}
                <AppStoreBadges
                  appName={product.title}
                  listings={product.listings}
                  placeholder="coming-soon"
                />
                {product.vendorListing && (
                  <>
                    <p className="pt-2 font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                      For home cooks
                    </p>
                    <AppStoreBadges
                      appName={`${product.title} for home cooks`}
                      listings={{ android: product.vendorListing }}
                      placeholder="coming-soon"
                    />
                  </>
                )}
              </div>
            )}
          </AnimateOnScroll>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-2xl">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              01 — Features
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              What&apos;s in the box.
            </h2>
          </AnimateOnScroll>

          <div className="mt-14 grid grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {product.features.map((feature, index) => (
              <AnimateOnScroll
                key={feature.title}
                variant="fade-up"
                delay={index * 0.05}
              >
                <div className="border-t pt-6">
                  <feature.icon
                    className="h-5 w-5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <h3 className="mt-4 text-lg font-semibold tracking-tight text-foreground">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {feature.description}
                  </p>
                </div>
              </AnimateOnScroll>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits & Pricing */}
      <section className="border-t py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12 lg:items-start">
            <AnimateOnScroll variant="fade-up" className="lg:col-span-6">
              <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                02 — Why {product.title}
              </p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Built for the job,
                <br />
                not the feature list.
              </h2>
              <ul className="mt-8 space-y-4">
                {product.benefits.map((benefit) => (
                  <li key={benefit} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="text-foreground">{benefit}</span>
                  </li>
                ))}
              </ul>
            </AnimateOnScroll>

            <AnimateOnScroll
              variant="fade-up"
              delay={0.1}
              className="lg:col-span-5 lg:col-start-8"
            >
              {isComingSoon ? (
                /* No prices to quote yet, so the slot states where the product
                   actually stands instead of leaving a hole in the layout. The
                   signup form lives once, in the header — repeating it here
                   would duplicate both the ask and the field's id. */
                <div className="rounded-2xl border bg-card p-8">
                  <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                    Status
                  </p>
                  <dl className="mt-6">
                    {[
                      {
                        term: "Stage",
                        detail: "In development",
                      },
                      {
                        term: "Pricing",
                        detail: "Announced at launch",
                      },
                      {
                        term: "Early access",
                        detail: "Join the list above",
                      },
                    ].map((row) => (
                      <div
                        key={row.term}
                        className="flex items-baseline justify-between gap-6 border-t py-4 first:border-t-0"
                      >
                        <dt className="font-medium text-foreground">
                          {row.term}
                        </dt>
                        <dd className="text-right font-mono text-sm text-muted-foreground">
                          {row.detail}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
                    {product.title} isn&apos;t available yet. We&apos;ll email
                    you the day it launches — once, and nothing else.
                  </p>
                </div>
              ) : pricingLink ? (
                /* Pricing lives on the product's own site — it's the only
                   place a figure can stay accurate. See PRICING_LINKS above. */
                <div className="rounded-2xl border bg-card p-8">
                  <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                    Pricing
                  </p>
                  <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
                    See current {product.title} pricing on its own site.
                  </p>
                  <Button className="mt-8 w-full" asChild>
                    <a
                      href={pricingLink}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View {product.title} pricing
                      <ArrowUpRight
                        className="ml-1.5 h-4 w-4"
                        aria-hidden="true"
                      />
                    </a>
                  </Button>
                </div>
              ) : null}
            </AnimateOnScroll>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up">
            <div className="relative overflow-hidden rounded-3xl bg-primary px-6 py-16 text-primary-foreground shadow-xl sm:px-16 sm:py-20">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(color-mix(in_srgb,var(--primary-foreground)_10%,transparent)_1px,transparent_1px)] [background-size:26px_26px] [mask-image:radial-gradient(ellipse_70%_90%_at_80%_0%,black,transparent)]"
              />
              <div className="relative flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-end">
                <div>
                  <h2 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
                    {isComingSoon
                      ? `Want ${product.title} sooner?`
                      : `Ready to try ${product.title}?`}
                  </h2>
                  {/* Deliberately not a second "we'll tell you when it ships" —
                      the waitlist above already owns that. This is the other
                      reason someone reads this page: they want to talk to us. */}
                  <p className="mt-4 max-w-md text-base leading-relaxed text-primary-foreground/70">
                    {isComingSoon
                      ? "Tell us how you'd use it. Early conversations shape what we build first."
                      : "Get started with a free trial — no credit card required."}
                  </p>
                </div>
                <Button size="lg" variant="secondary" asChild>
                  <Link href="/contact">
                    {isComingSoon ? "Talk to us" : "Start your free trial"}
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
