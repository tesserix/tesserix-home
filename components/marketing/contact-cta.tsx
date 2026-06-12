"use client";

import { useRef } from "react";
import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import { Button } from "@tesserix/web";

export function ContactCTA() {
  const prefersReducedMotion = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);

  // Panel scales and settles into place as it enters the viewport
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start end", "center center"],
  });
  const scale = useTransform(scrollYProgress, [0, 1], [0.94, 1]);
  const opacity = useTransform(scrollYProgress, [0, 0.6], [0.4, 1]);

  return (
    <section ref={sectionRef} className="relative py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <motion.div
          style={prefersReducedMotion ? undefined : { scale, opacity }}
          className="relative overflow-hidden rounded-3xl bg-primary px-6 py-20 text-primary-foreground shadow-xl sm:px-16 sm:py-24"
        >
          {/* Faint dot grid in the panel's own foreground token */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(color-mix(in_srgb,var(--primary-foreground)_10%,transparent)_1px,transparent_1px)] [background-size:26px_26px] [mask-image:radial-gradient(ellipse_70%_90%_at_80%_0%,black,transparent)]"
          />

          <div className="relative grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-primary-foreground/60">
                04 — Contact
              </p>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-5xl">
                Have a question?
                <br />
                You&apos;ll get a human.
              </h2>
            </div>

            <div className="flex flex-col justify-end gap-8 lg:col-span-4 lg:col-start-9">
              <p className="max-w-md text-base leading-relaxed text-primary-foreground/70">
                No sales pitch, no chatbot queue — just a conversation with the
                people who build the products.
              </p>
              <div className="flex flex-wrap items-center gap-5">
                <Button size="lg" variant="secondary" asChild>
                  <Link href="/contact">
                    Get in touch
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
                <a
                  href="mailto:sales@tesserix.app"
                  className="inline-flex items-center gap-2 font-mono text-sm text-primary-foreground/70 transition-colors hover:text-primary-foreground"
                >
                  <Mail className="h-4 w-4" aria-hidden="true" />
                  sales@tesserix.app
                </a>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
