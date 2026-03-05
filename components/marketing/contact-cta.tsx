"use client";

import Link from "next/link";
import { Button, AnimateOnScroll } from "@tesserix/web";
export function ContactCTA() {
  return (
    <section className="py-14 sm:py-16 bg-foreground relative overflow-hidden">
      {/* Animated background orbs */}
      <div className="pointer-events-none absolute -top-40 -left-40 h-80 w-80 rounded-full bg-orange-500/10 blur-3xl orb-1" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-amber-500/10 blur-3xl orb-2" />
      <div className="pointer-events-none absolute inset-0 dot-grid opacity-[0.04]" />

      <div className="mx-auto max-w-7xl px-6 lg:px-8 relative">
        <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-background sm:text-4xl">
            Have a question?
          </h2>
          <p className="mt-4 text-lg text-background/70">
            We&apos;d love to hear from you. No sales pitch, just a conversation.
          </p>
          <div className="mt-10">
            <Button
              size="lg"
              variant="secondary"
              asChild
              className="bg-white text-foreground hover:bg-white/90 btn-shimmer"
            >
              <Link href="/contact">Get in touch</Link>
            </Button>
          </div>
        </AnimateOnScroll>
      </div>
    </section>
  );
}
