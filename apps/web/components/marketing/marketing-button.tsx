import type { ElementType, ReactNode } from "react";

export type MarketingButtonVariant = "ink" | "outline" | "pill-white";

const VARIANT_CLASSES: Record<MarketingButtonVariant, string> = {
  // Dark solid button — primary CTA on light sections (hero, about-teaser).
  ink: "rounded-[10px] bg-primary px-7 py-3.5 text-[0.98rem] font-semibold text-primary-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-cobalt hover:shadow-[0_12px_28px_-12px_rgba(232,89,12,0.55)]",
  // Bordered card button — secondary CTA on light sections.
  outline:
    "inline-flex items-center rounded-[10px] border bg-card px-6 py-3.5 text-[0.98rem] font-medium text-foreground transition-colors hover:border-cobalt",
  // Rounded-full white pill for the dark CTA panel (contact-cta.tsx). Relies
  // on that panel wrapping its content in the `.dark` theme scope, where
  // `--primary-foreground` resolves to the same ink used here.
  "pill-white":
    "inline-flex items-center rounded-full bg-white px-[1.7rem] py-[0.9rem] text-[0.98rem] font-semibold text-primary-foreground transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_30px_-10px_rgba(232,89,12,0.6)]",
};

interface MarketingButtonProps {
  /** Renders as this component instead of a plain `<a>` — pass Next's `Link` for internal routes. */
  as?: ElementType;
  variant: MarketingButtonVariant;
  className?: string;
  href?: string;
  target?: string;
  rel?: string;
  children?: ReactNode;
}

/**
 * Shared button styling for the marketing site's hand-authored CTAs (hero,
 * about-teaser, contact-cta), which had drifted into three near-identical
 * copies of the same class strings. `as` lets a caller render it as
 * `Link` while keeping one source of truth for the look.
 */
export function MarketingButton({
  as: Component = "a",
  variant,
  className,
  ...props
}: MarketingButtonProps) {
  const classes = className
    ? `${VARIANT_CLASSES[variant]} ${className}`
    : VARIANT_CLASSES[variant];

  return <Component className={classes} {...props} />;
}
