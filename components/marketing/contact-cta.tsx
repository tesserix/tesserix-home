"use client";

import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { Button, AnimateOnScroll } from "@tesserix/web";

export function ContactCTA() {
  return (
    <section className="py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up">
          <div className="rounded-2xl border bg-card px-6 py-16 sm:px-16 sm:py-20">
            <div className="mx-auto max-w-lg text-center">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Have a question?
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                We&apos;d love to hear from you. No sales pitch, just a conversation.
              </p>

              <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
                <Button size="default" asChild>
                  <Link href="/contact">
                    Get in touch
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
                <a
                  href="mailto:hello@tesserix.com"
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Mail className="h-3.5 w-3.5" aria-hidden="true" />
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
