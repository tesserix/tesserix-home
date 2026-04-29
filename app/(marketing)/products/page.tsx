"use client";

import Link from "next/link";
import { ShoppingBag, ChefHat, Hospital, Trophy, ArrowRight } from "lucide-react";
import { Button, AnimateOnScroll } from "@tesserix/web";
const products = [
  {
    title: "Mark8ly",
    tagline: "Quiet commerce for people who make things",
    description:
      "An editorial commerce platform for independent merchants. Set up in an afternoon, keep your margins, and sell on a storefront that doesn't look like everyone else's.",
    icon: ShoppingBag,
    href: "/products/mark8ly",
    website: "mark8ly.com",
    pricing: "90 days free, then from $19/mo",
    features: [
      "Custom domains",
      "0% transaction fees",
      "Considered theme system",
      "Up to 100 products on Starter",
      "Cards, UPI, and wallets",
      "Real human support",
    ],
  },
  {
    title: "FanZone Battle Ground",
    tagline: "Your cricket opinions finally matter",
    description:
      "Live predictions, trash-talk battle rooms, and ranked fan leaderboards. Built for IPL die-hards, fantasy players, and anyone who watches with strong opinions.",
    icon: Trophy,
    href: "/products/fanzone",
    website: "fanzonebattleground.com",
    pricing: "Free to join — 50 pts on signup",
    features: [
      "Live battle rooms",
      "Match prediction markets",
      "Ranked leaderboards",
      "Hot takes & fan connect",
      "Live match scores",
      "Match alerts",
    ],
  },
  {
    title: "MediCare",
    tagline: "Hospital management without the bloat",
    description:
      "End-to-end clinic and hospital operations — patient records, scheduling, billing, pharmacy, and lab. Designed for clinics that outgrew spreadsheets but never wanted enterprise software.",
    icon: Hospital,
    href: "/products/medicare",
    comingSoon: true,
    features: [
      "Electronic health records",
      "Appointment scheduling",
      "Billing & invoicing",
      "Pharmacy & inventory",
      "Staff management",
      "Lab & diagnostics",
    ],
  },
  {
    title: "HomeChef",
    tagline: "Home cooks, real customers",
    description:
      "A delivery platform that connects home chefs with food lovers in their community. Chef onboarding, menu management, and delivery coordination in one place.",
    icon: ChefHat,
    href: "/products/homechef",
    comingSoon: true,
    features: [
      "Chef onboarding & verification",
      "Menu management",
      "Real-time order tracking",
      "Delivery coordination",
      "Customer reviews & ratings",
      "Payment processing",
    ],
  },
];

export default function ProductsPage() {
  return (
    <div>
      {/* Hero */}
      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Products
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              Software solutions designed to help businesses succeed in their domains.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* Products List */}
      <section className="pb-12 sm:pb-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="space-y-16 sm:space-y-20">
            {products.map((product, index) => (
              <AnimateOnScroll
                key={product.title}
                variant="fade-up"
              >
                <div
                  className={`flex flex-col gap-8 lg:flex-row lg:items-start ${
                    index % 2 === 1 ? "lg:flex-row-reverse" : ""
                  }`}
                >
                  {/* Icon/Visual */}
                  <div className="lg:w-1/3">
                    <div className="flex h-48 w-full items-center justify-center rounded-lg border bg-muted/30 shadow-sm">
                      <product.icon className="h-16 w-16 text-muted-foreground/50" />
                    </div>
                  </div>

                  {/* Content */}
                  <div className="lg:w-2/3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h2 className="text-2xl font-semibold text-foreground">
                        {product.title}
                      </h2>
                      {product.comingSoon && (
                        <span className="rounded-full border border-foreground/20 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                          Coming Soon
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3">
                      <p className="text-muted-foreground">{product.tagline}</p>
                      {product.website && (
                        <span className="text-sm font-medium text-muted-foreground">
                          {product.website}
                        </span>
                      )}
                    </div>

                    {/* Pricing teaser */}
                    {product.pricing && (
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {product.pricing}
                      </p>
                    )}

                    <p className="mt-4 text-muted-foreground leading-relaxed">{product.description}</p>

                    {/* Features Grid */}
                    <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {product.features.map((feature) => (
                        <div key={feature} className="flex items-center gap-2">
                          <div className="h-1 w-1 rounded-full bg-foreground shrink-0" />
                          <span className="text-sm text-muted-foreground">{feature}</span>
                        </div>
                      ))}
                    </div>

                    {/* CTA */}
                    <div className="mt-8">
                      <Button asChild>
                        <Link href={product.href}>
                          Explore {product.title}
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                </div>
              </AnimateOnScroll>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-12 sm:py-16 border-t">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Have a question?
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              We&apos;d love to hear from you.
            </p>
            <div className="mt-10">
              <Button size="lg" asChild>
                <Link href="/contact">Get in touch</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
