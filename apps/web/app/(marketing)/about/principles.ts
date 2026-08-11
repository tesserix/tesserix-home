export interface Principle {
  number: string;
  title: string;
  body: string;
}

/**
 * The four operating principles Tesserix runs on. Shared between /about
 * ("How we work") and /careers ("What we look for") so the prose is defined
 * once and never drifts between pages.
 */
export const principles: Principle[] = [
  {
    number: "01",
    title: "Small on purpose",
    body: "We're a small team by choice. Fewer layers means faster decisions — and the person fixing your bug is usually the person who wrote the feature.",
  },
  {
    number: "02",
    title: "Opinionated by default",
    body: "Good tools make choices. We'd rather ship strong defaults you can override than a settings page with forty toggles nobody understands.",
  },
  {
    number: "03",
    title: "Ship fast, fix faster",
    body: "We'd rather get something useful in your hands today than something perfect next year — and then improve it every single week.",
  },
  {
    number: "04",
    title: "Built to last",
    body: "Fair prices for working software, so we're still here in ten years. No growth hacks, no dark patterns, no surprise pivots.",
  },
];
