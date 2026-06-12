"use client";

import { useRef } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import { Button } from "@tesserix/web";

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.09,
      delayChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] as const },
  },
};

const stats = [
  { value: "04", label: "Products in the portfolio" },
  { value: "02", label: "Live in production" },
  { value: "04", label: "Industries, one each" },
  { value: "0%", label: "Transaction fees, ever" },
];

const marqueeItems = [
  "Mark8ly",
  "FanZone Battle Ground",
  "MediCare",
  "HomeChef",
];

function Marquee() {
  const row = [...marqueeItems, ...marqueeItems, ...marqueeItems];
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden border-t [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]"
    >
      <div className="animate-marquee flex w-max items-center gap-6 whitespace-nowrap py-5">
        {[...row, ...row].map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="flex items-center gap-6 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground"
          >
            {item}
            <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
          </span>
        ))}
      </div>
    </div>
  );
}

export function Hero() {
  const prefersReducedMotion = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);

  // Apple-style scroll-out: hero content drifts up and fades as you scroll past
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"],
  });
  const contentY = useTransform(scrollYProgress, [0, 1], [0, 120]);
  const contentOpacity = useTransform(scrollYProgress, [0, 0.65], [1, 0]);

  return (
    <section ref={sectionRef} className="relative overflow-hidden bg-background">
      {/* Quiet dot-grid texture drawn from the border token, fading toward the fold */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_75%_75%_at_50%_-10%,black,transparent)]"
      />

      <div className="relative mx-auto max-w-7xl px-6 pt-24 pb-16 sm:pt-32 lg:px-8 lg:pt-36">
        <motion.div
          initial={prefersReducedMotion ? false : "hidden"}
          animate="visible"
          variants={containerVariants}
          style={
            prefersReducedMotion
              ? undefined
              : { y: contentY, opacity: contentOpacity }
          }
        >
          <motion.p
            className="inline-flex items-center gap-2.5 rounded-full border bg-card/60 px-4 py-1.5 font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground backdrop-blur"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Tesserix — a product studio
          </motion.p>

          <motion.h1
            className="mt-8 max-w-5xl text-4xl font-semibold tracking-tight text-foreground sm:text-6xl lg:text-7xl"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            Specialized software,
            <br />
            <span className="text-muted-foreground">
              built for the people who use it.
            </span>
          </motion.h1>

          <motion.p
            className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            We build focused SaaS products — one industry at a time. Commerce,
            sports, healthcare, food. Each product does one thing well and
            refuses to do everything else.
          </motion.p>

          <motion.div
            className="mt-10 flex flex-wrap items-center gap-4"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            <Button size="lg" asChild>
              <Link href="#products">
                Explore the products
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button size="lg" variant="ghost" asChild>
              <Link href="/about">About Tesserix</Link>
            </Button>
          </motion.div>

          <motion.dl
            className="mt-20 grid grid-cols-2 gap-x-8 gap-y-10 border-t pt-10 lg:grid-cols-4"
            variants={prefersReducedMotion ? undefined : itemVariants}
          >
            {stats.map((stat) => (
              <div key={stat.label}>
                <dd className="font-mono text-3xl font-medium tracking-tight text-foreground sm:text-4xl">
                  {stat.value}
                </dd>
                <dt className="mt-2 text-sm text-muted-foreground">
                  {stat.label}
                </dt>
              </div>
            ))}
          </motion.dl>
        </motion.div>
      </div>

      <Marquee />
    </section>
  );
}
