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
} from "@tesserix/web";
import { products } from "./products-data";

export function ProductContent({ slug }: { slug: string }) {
  const product = products[slug];

  if (!product) {
    notFound();
  }

  const isComingSoon = product.status === "coming-soon";

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
                <Button size="lg" asChild>
                  <Link href="/contact">
                    Get notified when we launch
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
              ) : (
                <Button size="lg" asChild>
                  <Link href="/contact">
                    Start free trial
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
              )}
              {product.website && (
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
              {product.github && (
                <a
                  href={product.github}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-mono text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  GitHub
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              {isComingSoon
                ? `We'll let you know when ${product.title} is ready.`
                : "No credit card required · 14-day free trial"}
            </p>
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
              <div className="rounded-2xl border bg-card p-8">
                <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Pricing
                </p>
                <div className="mt-6">
                  {[
                    {
                      name: "Starter",
                      note: "For individuals & small teams",
                      price: product.pricing.starter,
                    },
                    {
                      name: "Professional",
                      note: "For growing businesses",
                      price: product.pricing.professional,
                    },
                    {
                      name: "Enterprise",
                      note: "For large organizations",
                      price: product.pricing.enterprise,
                    },
                  ].map((plan) => (
                    <div
                      key={plan.name}
                      className="flex items-center justify-between border-t py-4 first:border-t-0"
                    >
                      <div>
                        <p className="font-medium text-foreground">
                          {plan.name}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {plan.note}
                        </p>
                      </div>
                      <p className="font-mono text-base font-medium text-foreground">
                        {plan.price}
                      </p>
                    </div>
                  ))}
                </div>
                <Button className="mt-8 w-full" asChild>
                  <Link href="/contact">
                    {isComingSoon ? "Get in touch" : "Get started today"}
                  </Link>
                </Button>
              </div>
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
                      ? `Interested in ${product.title}?`
                      : `Ready to try ${product.title}?`}
                  </h2>
                  <p className="mt-4 max-w-md text-base leading-relaxed text-primary-foreground/70">
                    {isComingSoon
                      ? "Leave your email and we'll reach out when it's ready."
                      : "Get started with a free trial — no credit card required."}
                  </p>
                </div>
                <Button size="lg" variant="secondary" asChild>
                  <Link href="/contact">
                    {isComingSoon ? "Get in touch" : "Start your free trial"}
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
