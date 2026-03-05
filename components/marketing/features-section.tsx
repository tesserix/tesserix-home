"use client";

import { Zap, Shield, Globe, Headphones, TrendingUp, Code } from "lucide-react";
import {
  FeatureGrid,
  FeatureCard,
  FeatureIcon,
  FeatureTitle,
  FeatureDescription,
  AnimateOnScroll,
  StaggerContainer,
  StaggerItem,
} from "@tesserix/web";
const features = [
  {
    icon: Zap,
    title: "Launch Fast",
    description: "Go from idea to production in days, not months. Our platforms are ready to deploy.",
    gradient: "from-orange-500/15 to-amber-500/10",
  },
  {
    icon: Shield,
    title: "Enterprise Security",
    description: "SOC 2 compliant infrastructure with encryption, audit logs, and role-based access.",
    gradient: "from-amber-500/15 to-yellow-500/10",
  },
  {
    icon: Globe,
    title: "Scale Globally",
    description: "Built for growth with auto-scaling infrastructure and multi-region support.",
    gradient: "from-orange-600/15 to-rose-500/10",
  },
  {
    icon: Headphones,
    title: "24/7 Support",
    description: "Dedicated support team ready to help you succeed at every step.",
    gradient: "from-amber-600/15 to-orange-500/10",
  },
  {
    icon: TrendingUp,
    title: "Analytics Built-in",
    description: "Comprehensive dashboards and insights to make data-driven decisions.",
    gradient: "from-yellow-500/15 to-amber-500/10",
  },
  {
    icon: Code,
    title: "Developer Friendly",
    description: "Clean APIs, webhooks, and documentation for seamless integrations.",
    gradient: "from-orange-500/15 to-red-500/10",
  },
];

export function FeaturesSection() {
  return (
    <section className="py-14 sm:py-16 relative">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Why Tesserix?
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Everything you need to build, launch, and scale your business.
          </p>
        </AnimateOnScroll>

        <StaggerContainer className="mx-auto mt-12 max-w-5xl">
          <FeatureGrid className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <StaggerItem key={feature.title}>
              <FeatureCard className="card-hover-scale transition-colors hover:border-foreground/10 spotlight-card"
                onMouseMove={(e: React.MouseEvent<HTMLDivElement>) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  e.currentTarget.style.setProperty("--spotlight-x", `${e.clientX - rect.left}px`);
                  e.currentTarget.style.setProperty("--spotlight-y", `${e.clientY - rect.top}px`);
                  e.currentTarget.style.setProperty("--spotlight-opacity", "1");
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
                  e.currentTarget.style.setProperty("--spotlight-opacity", "0");
                }}
              >
                <FeatureIcon className={`bg-gradient-to-br ${feature.gradient} transition-colors`}>
                  <feature.icon className="h-5 w-5 text-foreground" />
                </FeatureIcon>
                <FeatureTitle>{feature.title}</FeatureTitle>
                <FeatureDescription className="leading-relaxed">
                  {feature.description}
                </FeatureDescription>
              </FeatureCard>
            </StaggerItem>
          ))}
          </FeatureGrid>
        </StaggerContainer>
      </div>
    </section>
  );
}
