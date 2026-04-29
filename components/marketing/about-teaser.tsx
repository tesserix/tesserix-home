"use client";

import Link from "next/link";
import { ArrowRight, Rocket, BadgeDollarSign, MessageCircle } from "lucide-react";
import { Button, AnimateOnScroll } from "@tesserix/web";

const values = [
  {
    icon: Rocket,
    title: "Ship fast, fix faster",
    description:
      "We'd rather get something useful in your hands today than something perfect next year.",
  },
  {
    icon: BadgeDollarSign,
    title: "Pricing that makes sense",
    description:
      "No surprise fees, no per-seat nonsense. You know what you're paying before you sign up.",
  },
  {
    icon: MessageCircle,
    title: "Humans on the other end",
    description:
      "When you reach out, a person responds. We don't hide behind chatbots or ticket queues.",
  },
];

export function AboutTeaser() {
  return (
    <section className="py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto grid max-w-2xl grid-cols-1 gap-x-16 gap-y-12 lg:mx-0 lg:max-w-none lg:grid-cols-2 lg:items-center">
          {/* Content */}
          <AnimateOnScroll variant="fade-up">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              We build products we&apos;d want to use ourselves
            </h2>
            <p className="mt-6 text-lg leading-8 text-muted-foreground">
              Tesserix is a small team shipping real software for real businesses.
              We started with Mark8ly because we saw how hard it was to launch an
              online store without spending a fortune on developers.
            </p>
            <p className="mt-4 text-muted-foreground leading-relaxed">
              Now we&apos;re building tools for healthcare, food delivery, and sports
              communities — each one designed to solve a specific problem well,
              not to check a feature list.
            </p>

            <div className="mt-8">
              <Button variant="outline" asChild>
                <Link href="/about">
                  More about us
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </AnimateOnScroll>

          {/* What we care about */}
          <AnimateOnScroll variant="fade-up" delay={0.1}>
            <div className="space-y-4">
              {values.map((v) => (
                <div
                  key={v.title}
                  className="rounded-xl border p-5 transition-colors hover:border-foreground/30"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                      <v.icon className="h-5 w-5 text-foreground" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">{v.title}</p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {v.description}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </AnimateOnScroll>
        </div>
      </div>
    </section>
  );
}
