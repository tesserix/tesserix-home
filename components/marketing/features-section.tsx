"use client";

import { Zap, Shield, Globe, Headphones, TrendingUp, Code } from "lucide-react";
import { AnimateOnScroll, StaggerContainer, StaggerItem } from "@/components/ui/animate-on-scroll";

const features = [
  {
    icon: Zap,
    title: "Launch Fast",
    description: "Go from idea to production in days, not months. Our platforms are ready to deploy.",
  },
  {
    icon: Shield,
    title: "Enterprise Security",
    description: "SOC 2 compliant infrastructure with encryption, audit logs, and role-based access.",
  },
  {
    icon: Globe,
    title: "Scale Globally",
    description: "Built for growth with auto-scaling infrastructure and multi-region support.",
  },
  {
    icon: Headphones,
    title: "24/7 Support",
    description: "Dedicated support team ready to help you succeed at every step.",
  },
  {
    icon: TrendingUp,
    title: "Analytics Built-in",
    description: "Comprehensive dashboards and insights to make data-driven decisions.",
  },
  {
    icon: Code,
    title: "Developer Friendly",
    description: "Clean APIs, webhooks, and documentation for seamless integrations.",
  },
];

export function FeaturesSection() {
  return (
    <section className="py-14 sm:py-16 border-t">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Why Tesserix?
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Everything you need to build, launch, and scale your business.
          </p>
        </AnimateOnScroll>

        <StaggerContainer className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <StaggerItem key={feature.title}>
              <div className="rounded-lg border bg-card p-6 card-hover-scale transition-colors hover:border-foreground/10">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted transition-colors">
                  <feature.icon className="h-5 w-5 text-foreground" />
                </div>
                <h3 className="mt-4 font-semibold text-foreground">{feature.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {feature.description}
                </p>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}
