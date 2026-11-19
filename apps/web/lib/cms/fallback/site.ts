import type { Belief, OpenSourceRepo, Principle, TeamMember } from "../types";

// Frozen copies of the /about, homepage and open-source content, served when the
// CMS is unreachable or not configured (see lib/cms/client.ts).

/** Both co-founders carry the same title deliberately — there is no CEO/CTO split. */
export const fallbackTeam: TeamMember[] = [
  {
    slug: "mahesh-sangawar",
    name: "Mahesh Sangawar",
    title: "Co-founder",
    bio: "Cloud architect and platform engineer building multi-tenant SaaS, Kubernetes platforms and developer tooling.",
    linkedIn: "https://www.linkedin.com/in/mahesh-sangawar-985a3214/",
    github: "https://github.com/mahesh-sangawar",
    photo: "/team/mahesh-sangawar.jpg",
  },
  {
    slug: "samyak-r",
    name: "Samyak Rout",
    title: "Co-founder",
    bio: "Full-stack and AI Platform engineer building cloud-native products end to end — Go services, Next.js apps and the delivery pipelines behind them.",
    linkedIn: "https://www.linkedin.com/in/samyak-r-96551a21/",
    github: "https://github.com/sam123ben",
    photo: "/team/samyak-r.jpg",
  },
];

/** The four operating principles, shared by /about ("How we work") and /careers ("What we look for"). */
export const fallbackPrinciples: Principle[] = [
  {
    title: "Small on purpose",
    body: "We're a small team by choice. Fewer layers means faster decisions — and the person fixing your bug is usually the person who wrote the feature.",
  },
  {
    title: "Opinionated by default",
    body: "Good tools make choices. We'd rather ship strong defaults you can override than a settings page with forty toggles nobody understands.",
  },
  {
    title: "Ship fast, fix faster",
    body: "We'd rather get something useful in your hands today than something perfect next year — and then improve it every single week.",
  },
  {
    title: "Built to last",
    body: "Fair prices for working software, so we're still here in ten years. No growth hacks, no dark patterns, no surprise pivots.",
  },
];

export const fallbackBeliefs: Belief[] = [
  {
    label: "Specialized > generic",
    title: "Built for one industry each",
    body: "A tool built for one industry beats a platform that flexes for ten. Each Tesserix product is opinionated about its domain — and stays out of the others.",
  },
  {
    label: "No surprise pricing",
    title: "The bill never mutates",
    body: "Flat plans, no transaction skim, no per-seat traps. You should know what you pay before you sign up, and the bill should look the same in month twelve as it did in month one.",
  },
  {
    label: "Humans reply",
    title: "No chatbot queues",
    body: "When you reach out, a person responds. We don't hide behind chatbots or queue you behind a knowledge base. Small team, real replies.",
  },
];

/** External repos on github.com/tesserix — tooling, not products. */
export const fallbackOpenSource: OpenSourceRepo[] = [
  {
    name: "sandboxctl",
    description: "One-command local Kubernetes sandbox — kind, Argo CD, Istio and a GitOps deploy loop.",
  },
  {
    name: "cloudnav",
    description: "Keyboard-driven multi-cloud TUI for Azure, GCP and AWS — resources, costs and IAM in one terminal.",
  },
  {
    name: "design-system",
    description: "@tesserix/web — the design system behind every Tesserix product. TypeScript, Tailwind.",
  },
  {
    name: "reposhift",
    description: "Azure DevOps to GitHub migration — repos, work items and pipelines. SaaS or self-hosted.",
  },
];
