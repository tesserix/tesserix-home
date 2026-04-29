"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowRight, ChefHat, Hospital, Trophy, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { HeroTitle, HeroDescription, HeroActions, Button } from "@tesserix/web";

const upcomingProducts = [
  {
    title: "HomeChef",
    tagline: "Food Delivery",
    description: "Connect home chefs with food lovers in your community.",
    icon: ChefHat,
    href: "/products/homechef",
  },
  {
    title: "MediCare",
    tagline: "Hospital Management",
    description: "End-to-end hospital management for clinics of all sizes.",
    icon: Hospital,
    href: "/products/medicare",
  },
  {
    title: "FanZone",
    tagline: "Cricket & Sports",
    description: "Live scores, predictions, and a vibrant fan community.",
    icon: Trophy,
    href: "/products/fanzone",
  },
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.05,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const },
  },
};

const ONBOARDING_URL =
  process.env.NEXT_PUBLIC_ONBOARDING_SITE_URL ||
  "https://dev-onboarding.tesserix.app";

export function Hero() {
  const prefersReducedMotion = useReducedMotion();

  return (
    <section className="relative bg-background">
      <div className="mx-auto max-w-7xl px-6 py-12 sm:py-16 lg:px-8 lg:py-20">
        <motion.div
          initial={prefersReducedMotion ? false : "hidden"}
          animate="visible"
          variants={containerVariants}
        >
          {/* Announcement pill */}
          <motion.div
            className="mb-6 flex justify-center"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            <Link
              href="/products/mark8ly"
              className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-foreground/30"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Mark8ly is live — 12 months free</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </Link>
          </motion.div>

          {/* Heading */}
          <motion.div
            className="mb-12 text-center"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            <HeroTitle className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
              Build what&apos;s next
            </HeroTitle>
            <HeroDescription className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
              We build the software so you can focus on the business.
            </HeroDescription>
          </motion.div>

          {/* Bento: Mark8ly featured + upcoming products */}
          <motion.div variants={prefersReducedMotion ? undefined : itemVariants}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {/* Mark8ly featured (spans 2 cols at lg) */}
              <div className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-8 md:col-span-2 lg:col-span-2">
                {/* Watermark logo */}
                <div className="pointer-events-none absolute -bottom-4 -right-4 h-56 w-56 opacity-[0.06] sm:h-64 sm:w-64">
                  <Image
                    src="/mark8ly-logo.png"
                    alt=""
                    fill
                    sizes="(min-width:640px) 256px, 224px"
                    className="object-contain grayscale"
                    aria-hidden="true"
                  />
                </div>

                <div className="relative flex h-full flex-col">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center">
                      <Image
                        src="/mark8ly-icon.png"
                        alt=""
                        width={44}
                        height={44}
                        className="object-contain"
                        aria-hidden="true"
                      />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground">
                        Mark8ly
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        Your online store, ready this afternoon
                      </p>
                    </div>
                  </div>

                  <p className="mt-4 leading-relaxed text-muted-foreground">
                    Launch your store in under an hour — no developer needed.
                    Beautiful themes, integrated payments, built-in SEO, and
                    real human support.
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {[
                      "No coding",
                      "0% platform fees",
                      "Custom domains",
                      "Unlimited products",
                    ].map((label) => (
                      <span
                        key={label}
                        className="inline-flex items-center rounded-md border bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                      >
                        {label}
                      </span>
                    ))}
                  </div>

                  <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                    <div>
                      <span className="font-semibold text-foreground">
                        12 months
                      </span>
                      <span className="text-muted-foreground"> free</span>
                    </div>
                    <span className="h-3 w-px bg-border" aria-hidden="true" />
                    <div>
                      <span className="font-semibold text-foreground">0%</span>
                      <span className="text-muted-foreground">
                        {" "}
                        platform fees
                      </span>
                    </div>
                    <span className="h-3 w-px bg-border" aria-hidden="true" />
                    <div>
                      <span className="font-semibold text-foreground">
                        ₹499
                      </span>
                      <span className="text-muted-foreground">/mo after</span>
                    </div>
                  </div>

                  <HeroActions className="mt-6 flex flex-1 flex-col justify-end gap-2">
                    <span className="text-sm text-muted-foreground">
                      No credit card required
                    </span>
                    <div>
                      <Button size="lg" asChild>
                        <a href={ONBOARDING_URL}>
                          Start your free year
                          <ArrowRight
                            className="ml-2 h-4 w-4"
                            aria-hidden="true"
                          />
                        </a>
                      </Button>
                    </div>
                  </HeroActions>
                </div>
              </div>

              {/* Upcoming products */}
              <div className="flex flex-col gap-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Coming soon
                </p>
                {upcomingProducts.map((product) => (
                  <Link
                    key={product.title}
                    href={product.href}
                    className="group flex h-full flex-1 flex-col rounded-2xl border bg-card p-5 transition-colors hover:border-foreground/30"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                        <product.icon
                          className="h-4 w-4 text-foreground"
                          aria-hidden="true"
                        />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">
                          {product.title}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {product.tagline}
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 flex-1 text-xs leading-relaxed text-muted-foreground">
                      {product.description}
                    </p>
                    <div className="mt-3 flex items-center text-xs font-medium text-foreground">
                      Learn more
                      <ArrowRight
                        className="ml-1 h-3 w-3 transition-transform group-hover:translate-x-1"
                        aria-hidden="true"
                      />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
