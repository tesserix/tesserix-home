"use client";

import { useRef, useCallback } from "react";
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
    iconGradient: "from-orange-500/15 to-amber-500/10",
  },
  {
    title: "MediCare",
    tagline: "Hospital Management",
    description: "End-to-end hospital management for clinics of all sizes.",
    icon: Hospital,
    href: "/products/medicare",
    iconGradient: "from-emerald-500/15 to-teal-500/10",
  },
  {
    title: "FanZone",
    tagline: "Cricket & Sports",
    description: "Live scores, predictions, and a vibrant fan community.",
    icon: Trophy,
    href: "/products/fanzone",
    iconGradient: "from-blue-500/15 to-indigo-500/10",
  },
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  },
};

const ONBOARDING_URL = process.env.NEXT_PUBLIC_ONBOARDING_SITE_URL || "https://dev-onboarding.tesserix.app";

const cardVariants = {
  hidden: { opacity: 0, y: 24, scale: 0.96 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.5, delay: 0.3 + i * 0.1, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export function Hero() {
  const prefersReducedMotion = useReducedMotion();
  const heroRef = useRef<HTMLElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!heroRef.current || prefersReducedMotion) return;
    const rect = heroRef.current.getBoundingClientRect();
    heroRef.current.style.setProperty("--glow-x", `${e.clientX - rect.left}px`);
    heroRef.current.style.setProperty("--glow-y", `${e.clientY - rect.top}px`);
    heroRef.current.style.setProperty("--glow-opacity", "1");
  }, [prefersReducedMotion]);

  const handleMouseLeave = useCallback(() => {
    if (!heroRef.current) return;
    heroRef.current.style.setProperty("--glow-opacity", "0");
  }, []);

  return (
    <section
      ref={heroRef}
      className="relative overflow-hidden gradient-mesh-vivid cursor-glow"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Dot grid overlay */}
      <div className="pointer-events-none absolute inset-0 dot-grid opacity-60" />

      {/* Animated gradient orbs */}
      <div
        className={`pointer-events-none absolute -top-24 -right-24 h-[500px] w-[500px] rounded-full bg-gradient-to-br from-orange-500/[0.06] to-amber-500/[0.04] blur-3xl ${prefersReducedMotion ? "" : "orb-1"}`}
      />
      <div
        className={`pointer-events-none absolute -bottom-32 -left-32 h-[400px] w-[400px] rounded-full bg-gradient-to-tr from-amber-500/[0.05] to-yellow-500/[0.03] blur-3xl ${prefersReducedMotion ? "" : "orb-2"}`}
      />

      <div className="relative mx-auto max-w-7xl px-6 py-12 sm:py-16 lg:px-8 lg:py-20">
        <motion.div
          initial={prefersReducedMotion ? false : "hidden"}
          animate="visible"
          variants={containerVariants}
        >
          {/* Announcement pill */}
          <motion.div
            className="flex justify-center mb-6"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            <Link
              href="/products/mark8ly"
              className="announcement-pill inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium text-foreground border border-orange-500/20 transition-all hover:border-orange-500/40 hover:shadow-sm"
            >
              <Sparkles className="h-3.5 w-3.5 text-orange-500" />
              <span>Mark8ly is live — 12 months free</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>
          </motion.div>

          {/* Heading */}
          <motion.div
            className="text-center mb-12"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            <HeroTitle className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
              Build what&apos;s next
            </HeroTitle>
            <HeroDescription className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
              We build the software so you can focus on the business.
            </HeroDescription>
          </motion.div>

          {/* Bento: Mark8ly left + Upcoming right */}
          <motion.div
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {/* Mark8ly — Featured (spans 2 cols) */}
              <div
                className="group relative lg:col-span-2 rounded-2xl bg-card p-6 sm:p-8 overflow-hidden glow-border"
              >
                {/* Watermark logo */}
                <div className="pointer-events-none absolute bottom-2 right-4 h-64 w-64 sm:h-72 sm:w-72 opacity-[0.08] transition-opacity duration-300 group-hover:opacity-[0.14]">
                  <Image
                    src="/mark8ly-logo.png"
                    alt=""
                    fill
                    className="object-contain grayscale"
                    aria-hidden="true"
                  />
                </div>

                <div className="relative flex h-full flex-col">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center">
                      <Image
                        src="/mark8ly-icon.png"
                        alt="Mark8ly"
                        width={44}
                        height={44}
                        className="object-contain"
                      />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground">Mark8ly</h2>
                      <p className="text-sm text-muted-foreground">Your online store, ready this afternoon</p>
                    </div>
                  </div>

                  <p className="mt-4 text-muted-foreground leading-relaxed">
                    Launch your store in under an hour — no developer needed.
                    Beautiful themes, integrated payments, built-in SEO, and real human support.
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {[
                      { label: "No coding", highlight: false },
                      { label: "0% platform fees", highlight: true },
                      { label: "Custom domains", highlight: false },
                      { label: "Unlimited products", highlight: false },
                    ].map((h) => (
                      <span
                        key={h.label}
                        className={`inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-medium ${
                          h.highlight
                            ? "bg-gradient-to-r from-orange-500/10 to-amber-500/10 text-foreground border border-orange-500/20"
                            : "border bg-muted/50 text-muted-foreground"
                        }`}
                      >
                        {h.label}
                      </span>
                    ))}
                  </div>

                  {/* Selling points */}
                  <div className="mt-5 flex items-center gap-5 text-sm flex-wrap">
                    <div>
                      <span className="font-semibold text-foreground">12 months</span>
                      <span className="text-muted-foreground"> free</span>
                    </div>
                    <span className="h-3 w-px bg-border" />
                    <div>
                      <span className="font-semibold text-foreground">0%</span>
                      <span className="text-muted-foreground"> platform fees</span>
                    </div>
                    <span className="h-3 w-px bg-border" />
                    <div>
                      <span className="font-semibold text-foreground">₹499</span>
                      <span className="text-muted-foreground">/mo after</span>
                    </div>
                  </div>

                  <HeroActions className="mt-6 flex flex-col gap-2 flex-1 justify-end">
                    <span className="text-sm text-muted-foreground">
                      No credit card required
                    </span>
                    <div>
                      <Button size="lg" asChild className="btn-gradient btn-shimmer text-white border-0">
                        <a href={ONBOARDING_URL}>
                          Start your free year
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </a>
                      </Button>
                    </div>
                  </HeroActions>

                </div>
              </div>

              {/* Upcoming products — stacked right column */}
              <div className="flex flex-col gap-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Coming soon
                </p>
                {upcomingProducts.map((product, i) => (
                  <motion.div
                    key={product.title}
                    custom={i}
                    initial={prefersReducedMotion ? false : "hidden"}
                    animate="visible"
                    variants={prefersReducedMotion ? undefined : cardVariants}
                    className="flex-1"
                  >
                  <Link
                    href={product.href}
                    className="group rounded-2xl border bg-card p-5 card-hover-lift h-full flex flex-col spotlight-card"
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      e.currentTarget.style.setProperty("--spotlight-x", `${e.clientX - rect.left}px`);
                      e.currentTarget.style.setProperty("--spotlight-y", `${e.clientY - rect.top}px`);
                      e.currentTarget.style.setProperty("--spotlight-opacity", "1");
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.setProperty("--spotlight-opacity", "0");
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${product.iconGradient}`}>
                        <product.icon className="h-4 w-4 text-foreground" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">{product.title}</h3>
                        <p className="text-xs text-muted-foreground">{product.tagline}</p>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground leading-relaxed flex-1">
                      {product.description}
                    </p>
                    <div className="mt-3 flex items-center text-xs font-medium text-foreground">
                      Learn more
                      <ArrowRight className="ml-1 h-3 w-3 transition-transform group-hover:translate-x-1" />
                    </div>
                  </Link>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>

        </motion.div>
      </div>
    </section>
  );
}
