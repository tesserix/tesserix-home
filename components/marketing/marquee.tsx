"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

const items = [
  "Zero platform fees",
  "Launch in under an hour",
  "Custom domains included",
  "Built-in SEO tools",
  "Real human support",
  "Unlimited products",
  "Integrated payments",
  "Beautiful themes",
  "Mobile-first design",
  "99.9% uptime SLA",
];

export function Marquee() {
  const prefersReducedMotion = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(true);

  useEffect(() => {
    if (prefersReducedMotion) return;
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => setPaused(!entries[0].isIntersecting),
      { rootMargin: "0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [prefersReducedMotion]);

  if (prefersReducedMotion) {
    return (
      <section className="overflow-hidden border-t border-b bg-muted/30 py-6">
        <div className="mx-auto flex max-w-7xl flex-wrap justify-center gap-4 px-6">
          {items.slice(0, 5).map((item) => (
            <span key={item} className="text-sm text-muted-foreground">
              {item}
            </span>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      ref={sectionRef}
      className="relative overflow-hidden border-t border-b bg-muted/20 py-4"
    >
      <div
        className="pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-24 bg-gradient-to-r from-background to-transparent"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute right-0 top-0 bottom-0 z-10 w-24 bg-gradient-to-l from-background to-transparent"
        aria-hidden="true"
      />

      <div
        className="marquee-track flex gap-8 whitespace-nowrap"
        data-paused={paused}
      >
        {[...items, ...items].map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="inline-flex shrink-0 items-center gap-2 text-sm text-muted-foreground"
          >
            <span
              className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
              aria-hidden="true"
            />
            {item}
          </span>
        ))}
      </div>
    </section>
  );
}
