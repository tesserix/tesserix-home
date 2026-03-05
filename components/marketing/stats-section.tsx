"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, useReducedMotion } from "framer-motion";

const stats = [
  { value: 500, suffix: "+", label: "Stores launched", icon: "store" },
  { value: 10, suffix: "K+", label: "Orders processed", icon: "orders" },
  { value: 99.9, suffix: "%", label: "Uptime", icon: "uptime" },
  { value: 4, suffix: " products", label: "And growing", icon: "products" },
];

function useCountUp(target: number, duration: number, start: boolean) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!start) return;

    let startTime: number | null = null;
    let rafId: number;

    const isDecimal = target % 1 !== 0;

    function animate(timestamp: number) {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = eased * target;
      setCount(isDecimal ? Math.round(current * 10) / 10 : Math.floor(current));
      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      }
    }

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [target, duration, start]);

  return count;
}

function StatItem({ value, suffix, label, delay, inView, index }: {
  value: number;
  suffix: string;
  label: string;
  delay: number;
  inView: boolean;
  index: number;
}) {
  const [started, setStarted] = useState(false);
  const count = useCountUp(value, 2000, started);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    if (!inView) return;
    const timer = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(timer);
  }, [inView, delay]);

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay: index * 0.1, ease: [0.22, 1, 0.36, 1] }}
      className="relative text-center p-6 rounded-xl border bg-card shadow-sm group"
    >
      <div className="text-4xl font-bold tracking-tight sm:text-5xl text-foreground">
        {started ? count : 0}
        <span className="text-orange-800 dark:text-orange-300">{suffix}</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground font-medium">{label}</p>

      {/* Decorative accent line */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-0 bg-gradient-to-r from-orange-500 to-amber-500 rounded-full transition-all duration-500 group-hover:w-12" />
    </motion.div>
  );
}

export function StatsSection() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  const handleIntersection = useCallback((entries: IntersectionObserverEntry[]) => {
    if (entries[0].isIntersecting) setInView(true);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(handleIntersection, { threshold: 0.3 });
    const el = ref.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [handleIntersection]);

  return (
    <section ref={ref} className="py-14 sm:py-16 relative overflow-hidden">
      {/* Gradient divider top */}
      <div className="section-divider absolute top-0 left-0 right-0" />

      {/* Subtle background orb */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[600px] rounded-full bg-gradient-to-r from-orange-500/[0.03] to-amber-500/[0.03] blur-3xl" />

      <div className="mx-auto max-w-7xl px-6 lg:px-8 relative">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-6">
          {stats.map((stat, i) => (
            <StatItem
              key={stat.label}
              value={stat.value}
              suffix={stat.suffix}
              label={stat.label}
              delay={i * 150}
              inView={inView}
              index={i}
            />
          ))}
        </div>
      </div>

      {/* Gradient divider bottom */}
      <div className="section-divider absolute bottom-0 left-0 right-0" />
    </section>
  );
}
