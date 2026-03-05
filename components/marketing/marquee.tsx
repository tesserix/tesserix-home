"use client";

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

  if (prefersReducedMotion) {
    return (
      <section className="py-6 border-t border-b bg-muted/30 overflow-hidden">
        <div className="mx-auto max-w-7xl px-6 flex flex-wrap gap-4 justify-center">
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
    <section className="py-4 border-b bg-muted/20 overflow-hidden relative">
      {/* Fade edges */}
      <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-24 z-10 bg-gradient-to-r from-background to-transparent" />
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-24 z-10 bg-gradient-to-l from-background to-transparent" />

      <div className="marquee-track flex gap-8 whitespace-nowrap">
        {[...items, ...items].map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground shrink-0"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-orange-500 to-amber-500" />
            {item}
          </span>
        ))}
      </div>
    </section>
  );
}
