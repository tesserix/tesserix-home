"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, useReducedMotion } from "framer-motion";

const stats = [
  { value: 500, suffix: "+", label: "Stores launched" },
  { value: 10, suffix: "K+", label: "Orders processed" },
  { value: 99.9, suffix: "%", label: "Uptime" },
  { value: 4, suffix: " products", label: "And growing" },
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

interface StatItemProps {
  value: number;
  suffix: string;
  label: string;
  delay: number;
  inView: boolean;
  index: number;
}

function StatItem({ value, suffix, label, delay, inView, index }: StatItemProps) {
  const [started, setStarted] = useState(false);
  const count = useCountUp(value, 1600, started);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    if (!inView) return;
    const timer = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(timer);
  }, [inView, delay]);

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.4, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-xl border bg-card p-6 text-center"
    >
      <div className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
        {started ? count : 0}
        <span className="text-foreground">{suffix}</span>
      </div>
      <p className="mt-2 text-sm font-medium text-muted-foreground">{label}</p>
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
    return () => {
      if (el) observer.unobserve(el);
    };
  }, [handleIntersection]);

  return (
    <section ref={ref} className="border-t border-b py-14 sm:py-16">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-6">
          {stats.map((stat, i) => (
            <StatItem
              key={stat.label}
              value={stat.value}
              suffix={stat.suffix}
              label={stat.label}
              delay={i * 120}
              inView={inView}
              index={i}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
