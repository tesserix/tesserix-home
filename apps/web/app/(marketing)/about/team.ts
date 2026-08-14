export interface TeamMember {
  slug: string;
  name: string;
  title: string;
  /**
   * One-line bio drawn only from what is actually published on the person's
   * public GitHub/LinkedIn profile. `undefined` when no such text could be
   * verified — render the missing-bio case gracefully, never invent one.
   */
  bio?: string;
  linkedIn: string;
  github: string;
}

/**
 * The Tesserix team, shown on /about ("Who we are"). Both co-founders carry
 * the same title deliberately — there is no CEO/CTO split. Photos are not
 * yet supplied; each member's image lives at `/team/<slug>.jpg` and the UI
 * falls back to an initials monogram until that file exists.
 */
export const team: TeamMember[] = [
  {
    slug: "mahesh-sangawar",
    name: "Mahesh Sangawar",
    title: "Co-founder",
    bio: "Cloud architect and platform engineer building multi-tenant SaaS, Kubernetes platforms and developer tooling.",
    linkedIn: "https://www.linkedin.com/in/mahesh-sangawar-985a3214/",
    github: "https://github.com/mahesh-sangawar",
  },
  {
    slug: "samyak-r",
    name: "Samyak Rout",
    title: "Co-founder",
    bio: "Full-stack and AI Platform engineer building cloud-native products end to end — Go services, Next.js apps and the delivery pipelines behind them.",
    linkedIn: "https://www.linkedin.com/in/samyak-r-96551a21/",
    github: "https://github.com/sam123ben",
  },
];
