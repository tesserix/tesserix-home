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
import type { MotionValue } from "framer-motion";
import { AnimateOnScroll } from "@tesserix/web";
import {
  industryListExcluding,
  isComingSoon,
  productSlugs,
  products,
} from "@/app/(marketing)/products/[slug]/products-data";

const STATEMENT = `Tesserix is a small team shipping real software for real businesses. We started with Mark8ly because launching an online store shouldn't cost a fortune. Now we're building for ${industryListExcluding("commerce")} — each product designed to solve one problem well, not to check a feature list.`;

/** Short editorial gloss per product; names and launch state come from data. */
const roadmapNotes: Record<string, string> = {
  mark8ly: "Editorial commerce",
  fe3dr: "Home-cooked delivery",
  dwellm8: "Rental management",
  medicare: "Clinic operations",
  kora: "AI nutrition tracking",
};

// Derived from products-data.ts rather than restated here: this list had
// drifted and showed Dwellm8 as "Live" while the product stack directly above
// it on the same page showed the same product as "Coming soon".
const roadmap = productSlugs.map((slug) => ({
  name: products[slug].title,
  note: roadmapNotes[slug] ?? "",
  status: isComingSoon(slug) ? "In development" : "Live",
}));

interface WordProps {
  word: string;
  start: number;
  end: number;
  progress: MotionValue<number>;
}

function Word({ word, start, end, progress }: WordProps) {
  const opacity = useTransform(progress, [start, end], [0.15, 1]);
  return (
    <motion.span style={{ opacity }} className="text-foreground">
      {word}{" "}
    </motion.span>
  );
}

/** Apple-style statement: words brighten one by one as the paragraph scrolls through the viewport. */
function ScrollRevealStatement() {
  const prefersReducedMotion = useReducedMotion();
  const ref = useRef<HTMLParagraphElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "end 0.45"],
  });

  const words = STATEMENT.split(" ");

  if (prefersReducedMotion) {
    return (
      <p className="max-w-[44rem] text-balance text-[clamp(1.5rem,3.4vw,2.5rem)] font-semibold leading-[1.24] tracking-[-0.035em] text-foreground">
        {STATEMENT}
      </p>
    );
  }

  return (
    <p
      ref={ref}
      className="relative max-w-[44rem] text-balance text-[clamp(1.5rem,3.4vw,2.5rem)] font-semibold leading-[1.24] tracking-[-0.035em]"
    >
      {words.map((word, index) => (
        <Word
          key={`${word}-${index}`}
          word={word}
          start={index / words.length}
          end={(index + 1) / words.length}
          progress={scrollYProgress}
        />
      ))}
    </p>
  );
}

export function AboutTeaser() {
  return (
    <section className="border-t py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up">
          <p className="inline-flex items-center gap-[0.7rem] font-mono text-[0.7rem] uppercase tracking-[0.14em] text-cobalt">
            <span className="h-px w-[2.2rem] bg-cobalt" aria-hidden="true" />
            The studio
          </p>
        </AnimateOnScroll>

        <div className="mt-8">
          <ScrollRevealStatement />
          <p className="mt-[1.8rem] font-mono text-[0.72rem] uppercase tracking-[0.1em] text-muted-foreground">
            The studio &middot; Sydney &amp; remote
          </p>
        </div>

        <div className="mt-16 grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <p className="leading-relaxed text-muted-foreground">
              We&apos;re not chasing a platform play. Each product gets its own
              roadmap, its own users, and our full attention until it&apos;s
              genuinely good.
            </p>
            <div className="mt-8">
              <Link
                href="/about"
                className="inline-flex items-center rounded-[10px] border bg-card px-6 py-3.5 text-[0.98rem] font-medium text-foreground transition-colors hover:border-cobalt"
              >
                More about us
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="lg:col-span-6 lg:col-start-7">
            <dl>
              {roadmap.map((item, index) => (
                <AnimateOnScroll
                  key={item.name}
                  variant="fade-up"
                  delay={index * 0.06}
                >
                  <div className="flex items-baseline justify-between gap-4 border-t py-4">
                    <dt className="flex items-baseline gap-3">
                      <span className="font-semibold text-foreground">
                        {item.name}
                      </span>
                      <span className="hidden text-sm text-muted-foreground sm:inline">
                        {item.note}
                      </span>
                    </dt>
                    <dd className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          item.status === "Live"
                            ? "bg-success"
                            : "bg-muted-foreground/50"
                        }`}
                        aria-hidden="true"
                      />
                      {item.status}
                    </dd>
                  </div>
                </AnimateOnScroll>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}
