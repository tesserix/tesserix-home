import type { Metadata } from "next";
import { Users, Globe, Shield, Zap } from "lucide-react";
import { AnimateOnScroll, StaggerContainer, StaggerItem } from "@/components/ui/animate-on-scroll";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about Tesserix - our mission, values, and the team building the future of commerce.",
};

const values = [
  {
    icon: Users,
    title: "Customer First",
    description:
      "Every decision we make starts with our customers. We build solutions that solve real problems and deliver measurable value.",
  },
  {
    icon: Shield,
    title: "Security & Trust",
    description:
      "Enterprise-grade security is built into everything we do. Your data and your customers' data are protected by industry-leading standards.",
  },
  {
    icon: Zap,
    title: "Innovation",
    description:
      "We continuously push the boundaries of what's possible, leveraging the latest technologies to give our customers a competitive edge.",
  },
  {
    icon: Globe,
    title: "Global Scale",
    description:
      "Our infrastructure is designed for global scale, ensuring your business can grow without limits.",
  },
];

const team = [
  {
    name: "Leadership Team",
    description:
      "Our leadership brings decades of combined experience from leading technology companies, with deep expertise in e-commerce, cloud infrastructure, and enterprise software.",
  },
  {
    name: "Engineering",
    description:
      "World-class engineers passionate about building reliable, scalable systems that power businesses around the world.",
  },
  {
    name: "Customer Success",
    description:
      "Dedicated team ensuring every customer achieves their business goals with our platform.",
  },
];

export default function AboutPage() {
  return (
    <div>
      {/* Hero */}
      <section className="py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              About Tesserix
            </h1>
            <p className="mt-6 text-lg leading-8 text-muted-foreground">
              We are on a mission to democratize access to enterprise-grade commerce tools,
              enabling businesses of all sizes to compete and succeed in the digital economy.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* Mission */}
      <section className="py-14 sm:py-20 bg-muted/30">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="mx-auto max-w-3xl">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Our Mission
            </h2>
            <p className="mt-6 text-lg leading-8 text-muted-foreground border-l-2 border-foreground/10 pl-6">
              Tesserix was founded with a simple belief: that every business deserves access to
              powerful, reliable, and affordable software tools. Too often, small and medium businesses
              are forced to choose between expensive enterprise solutions and inadequate consumer products.
            </p>
            <p className="mt-4 text-lg leading-8 text-muted-foreground border-l-2 border-foreground/10 pl-6">
              We&apos;re changing that. By building multi-tenant SaaS platforms from the ground up, we can
              offer enterprise-grade features at a fraction of the cost, allowing businesses to focus
              on what they do best: serving their customers.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* Values */}
      <section className="py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Our Values
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              The principles that guide everything we do.
            </p>
          </AnimateOnScroll>

          <StaggerContainer className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2">
            {values.map((value) => (
              <StaggerItem key={value.title}>
                <div className="rounded-lg border p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg border">
                    <value.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-lg font-medium text-foreground">
                    {value.title}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">{value.description}</p>
                </div>
              </StaggerItem>
            ))}
          </StaggerContainer>
        </div>
      </section>

      {/* Team */}
      <section className="py-14 sm:py-20 bg-muted/30">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Our Team
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              A diverse team united by a shared passion for building great products.
            </p>
          </AnimateOnScroll>

          <StaggerContainer className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-8 sm:grid-cols-3">
            {team.map((group) => (
              <StaggerItem key={group.name}>
                <div className="text-center rounded-lg border bg-card p-6 card-hover-lift">
                  <h3 className="text-lg font-semibold text-foreground">{group.name}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{group.description}</p>
                </div>
              </StaggerItem>
            ))}
          </StaggerContainer>
        </div>
      </section>

    </div>
  );
}
