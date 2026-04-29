"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { Button } from "@tesserix/web";

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
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const },
  },
};

export function Hero() {
  const prefersReducedMotion = useReducedMotion();

  return (
    <section className="relative bg-background">
      <div className="mx-auto max-w-7xl px-6 py-16 sm:py-20 lg:px-8 lg:py-28">
        <motion.div
          initial={prefersReducedMotion ? false : "hidden"}
          animate="visible"
          variants={containerVariants}
          className="max-w-3xl"
        >
          <motion.p
            className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            Tesserix
          </motion.p>

          <motion.h1
            className="mt-4 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            Specialized software,
            <br />
            built for the people who use it.
          </motion.h1>

          <motion.p
            className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            We build focused SaaS products — one industry at a time. Mark8ly for
            independent commerce. FanZone for cricket fans. MediCare and
            HomeChef coming next.
          </motion.p>

          <motion.div
            className="mt-10 flex flex-wrap items-center gap-4"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            <Button size="lg" asChild>
              <Link href="#products">
                See our products
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button size="lg" variant="ghost" asChild>
              <Link href="/about">About Tesserix</Link>
            </Button>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
