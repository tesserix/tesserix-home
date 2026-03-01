"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AnimateOnScroll } from "@/components/ui/animate-on-scroll";

export function ContactCTA() {
  return (
    <section className="py-14 sm:py-16 bg-foreground relative overflow-hidden">
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
              className="bg-white text-foreground hover:bg-white/90"
            >
              <Link href="/contact">Get in touch</Link>
            </Button>
          </div>
        </AnimateOnScroll>
      </div>
    </section>
  );
}
