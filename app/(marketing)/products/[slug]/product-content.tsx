"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, ArrowRight } from "lucide-react";
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
  return (
    <div>
      {/* Hero */}
      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          {/* Breadcrumb */}
          <Breadcrumb className="mb-6">
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

          <AnimateOnScroll variant="fade-up" className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              {product.title}
            </h1>
            {product.status === "coming-soon" && (
              <span className="mt-3 inline-block rounded-full border border-foreground/20 px-3 py-1 text-xs font-medium text-muted-foreground">
                Coming Soon
              </span>
            )}
            <p className="mt-2 text-xl text-muted-foreground">{product.tagline}</p>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              {product.longDescription}
            </p>

            {/* Single Primary CTA */}
            <div className="mt-10">
              {product.status === "coming-soon" ? (
                <>
                  <Button size="lg" asChild>
                    <Link href="/contact">
                      Get notified when we launch
                      <ArrowRight className="ml-2 h-5 w-5" />
                    </Link>
                  </Button>
                  <p className="mt-3 text-sm text-muted-foreground">
                    We&apos;ll let you know when {product.title} is ready.
                  </p>
                </>
              ) : (
                <>
                  <Button size="lg" asChild>
                    <Link href="/contact">
                      Start free trial
                      <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
                    </Link>
                  </Button>
                  <p className="mt-3 text-sm text-muted-foreground">
                    No credit card required · 14-day free trial
                  </p>
                </>
              )}
            </div>

            {/* External links */}
            {(product.website || product.github) && (
              <div className="mt-4 flex items-center justify-center gap-4">
                {product.website && (
                  <a
                    href={product.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Visit {product.website.replace("https://", "")} →
                  </a>
                )}
                {product.github && (
                  <a
                    href={product.github}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View on GitHub →
                  </a>
                )}
              </div>
            )}
          </AnimateOnScroll>
        </div>
      </section>

      {/* Features */}
      <section className="py-12 sm:py-16 bg-muted/30">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Powerful Features
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Everything you need to succeed with {product.title}.
            </p>
          </AnimateOnScroll>

          <AnimateOnScroll variant="fade-up" className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {product.features.map((feature) => (
              <div key={feature.title} className="rounded-lg border bg-card p-6 transition-colors hover:border-foreground/10">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <feature.icon className="h-5 w-5 text-foreground" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-foreground">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </AnimateOnScroll>
        </div>
      </section>

      {/* Benefits */}
      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto grid max-w-5xl grid-cols-1 gap-16 lg:grid-cols-2 lg:items-center">
            <AnimateOnScroll variant="fade-up">
              <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Why Choose {product.title}?
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                Focus on what matters while we handle the technical infrastructure.
              </p>
              <ul className="mt-8 space-y-4">
                {product.benefits.map((benefit) => (
                  <li key={benefit} className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-foreground mt-0.5 shrink-0" />
                    <span className="text-foreground">{benefit}</span>
                  </li>
                ))}
              </ul>
            </AnimateOnScroll>

            {/* Pricing Preview */}
            <AnimateOnScroll variant="fade-up" delay={0.1}>
              <div className="rounded-lg border bg-card p-8 shadow-sm">
                <h3 className="text-xl font-semibold text-foreground">Pricing Plans</h3>
                <p className="mt-2 text-muted-foreground">
                  Choose the plan that fits your needs.
                </p>

                <div className="mt-8 space-y-4">
                  <div className="flex items-center justify-between py-3 border-b">
                    <div>
                      <p className="font-medium text-foreground">Starter</p>
                      <p className="text-sm text-muted-foreground">For individuals & small teams</p>
                    </div>
                    <p className="text-lg font-semibold text-foreground">
                      {product.pricing.starter}
                    </p>
                  </div>
                  <div className="flex items-center justify-between py-3 border-b">
                    <div>
                      <p className="font-medium text-foreground">Professional</p>
                      <p className="text-sm text-muted-foreground">For growing businesses</p>
                    </div>
                    <p className="text-lg font-semibold text-foreground">
                      {product.pricing.professional}
                    </p>
                  </div>
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <p className="font-medium text-foreground">Enterprise</p>
                      <p className="text-sm text-muted-foreground">For large organizations</p>
                    </div>
                    <p className="text-lg font-semibold text-foreground">
                      {product.pricing.enterprise}
                    </p>
                  </div>
                </div>

                <Button className="w-full mt-8" asChild>
                  <Link href="/contact">Get started today</Link>
                </Button>
              </div>
            </AnimateOnScroll>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-12 sm:py-16 bg-primary">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-primary-foreground sm:text-4xl">
              {product.status === "coming-soon"
                ? `Interested in ${product.title}?`
                : `Ready to try ${product.title}?`}
            </h2>
            <p className="mt-4 text-lg text-primary-foreground/80">
              {product.status === "coming-soon"
                ? "Leave your email and we'll reach out when it's ready."
                : "Get started with a free trial — no credit card required."}
            </p>
            <div className="mt-10">
              <Button
                size="lg"
                variant="secondary"
                asChild
                className="bg-white text-primary hover:bg-white/90"
              >
                <Link href="/contact">
                  {product.status === "coming-soon" ? "Get in touch" : "Start your free trial"}
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
