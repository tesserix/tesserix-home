"use client";

import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { Button, AnimateOnScroll } from "@tesserix/web";

export function ContactCTA() {
  return (
    <section className="py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up">
          <div className="relative overflow-hidden rounded-2xl bg-neutral-700 px-6 py-16 sm:px-16 sm:py-20">
            {/* Subtle background orbs */}
            <div className="pointer-events-none absolute -top-32 -left-32 h-72 w-72 rounded-full bg-orange-500/[0.05] blur-3xl orb-1" />
            <div className="pointer-events-none absolute -bottom-32 -right-32 h-80 w-80 rounded-full bg-amber-500/[0.05] blur-3xl orb-2" />

            <div className="relative mx-auto max-w-lg text-center">
              <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                Have a question?
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-neutral-300">
                We&apos;d love to hear from you. No sales pitch, just a conversation.
              </p>

              <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
                <Button
                  size="default"
                  variant="secondary"
                  asChild
                  className="bg-white text-gray-900 hover:bg-gray-100"
                >
                  <Link href="/contact">
                    Get in touch
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
                <a
                  href="mailto:hello@tesserix.com"
                  className="inline-flex items-center gap-2 text-sm text-neutral-400 transition-colors hover:text-white"
                >
                  <Mail className="h-3.5 w-3.5" />
                  hello@tesserix.com
                </a>
              </div>
            </div>
          </div>
        </AnimateOnScroll>
      </div>
    </section>
  );
}
