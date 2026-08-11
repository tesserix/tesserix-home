"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

interface RevealProps {
  children: ReactNode;
  /** Stagger delay in seconds, applied via `transition-delay`. */
  delay?: number;
  className?: string;
}

/**
 * Scroll-triggered reveal, replacing `@tesserix/web`'s `AnimateOnScroll`.
 *
 * `AnimateOnScroll` server-renders its children at `opacity: 0` (framer
 * motion's `initial="hidden"` variant is applied during SSR), so anything
 * below the fold is invisible until React hydrates and IntersectionObserver
 * fires — a blank page for no-JS clients, crawlers, and the pre-hydration
 * window on slow connections.
 *
 * This component renders children visible by default. Only once mounted
 * does it check whether the element is already inside the viewport; if not,
 * it arms the CSS transition (`.sl-reveal[data-armed]` in globals.css, opacity
 * 0 / translateY(26px)) and observes for the element entering the viewport,
 * at which point `data-inview` clears it back to visible. Elements already
 * in view on mount are never armed, so there's no flash from visible ->
 * hidden -> visible.
 */
export function Reveal({ children, delay = 0, className }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const alreadyVisible = rect.top < window.innerHeight && rect.bottom > 0;
    if (alreadyVisible) {
      setInView(true);
      return;
    }

    // Arm before observing, in the same effect pass, so the element goes
    // straight from "visible, unarmed" to "hidden, armed" without a paint
    // in between — no flash of unstyled content.
    setArmed(true);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0, rootMargin: "-60px 0px" },
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  const style = delay
    ? ({ transitionDelay: `${delay}s` } satisfies CSSProperties)
    : undefined;

  return (
    <div
      ref={ref}
      className={className ? `sl-reveal ${className}` : "sl-reveal"}
      data-armed={armed ? "" : undefined}
      data-inview={inView ? "" : undefined}
      style={style}
    >
      {children}
    </div>
  );
}
