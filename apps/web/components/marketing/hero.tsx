import type { CSSProperties } from "react";
import Link from "next/link";
import { Tesseract } from "@/components/marketing/tesseract";
import { MarketingButton } from "@/components/marketing/marketing-button";
import {
  launchedProductSlugs,
  productSlugs,
  productTitle,
  industryListPlain,
} from "@/app/(marketing)/products/[slug]/products-data";

/** Inline custom property carrying the CSS-only stagger delay for `.hero-rise`. */
function riseDelay(seconds: number): CSSProperties {
  return { "--d": `${seconds}s` } as CSSProperties;
}

export function Hero() {
  const launched = launchedProductSlugs();
  const comingSoonCount = productSlugs.length - launched.length;

  return (
    <section className="relative min-h-[100svh] flex items-center overflow-hidden bg-background">
      <div
        className="absolute z-0 right-[clamp(-10rem,-2vw,0rem)] top-1/2 h-[clamp(26rem,46vw,46rem)] w-[clamp(26rem,46vw,46rem)] -translate-y-1/2 max-[860px]:opacity-[0.22] max-[860px]:right-[-35%]"
      >
        <Tesseract className="h-full w-full" />
      </div>

      <div className="relative z-[2] mx-auto w-full max-w-7xl px-6 pt-28 pb-16 lg:px-8">
        <p
          className="hero-rise inline-flex items-center gap-2.5 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground"
          style={riseDelay(0.05)}
        >
          <span className="h-px w-9 bg-cobalt" aria-hidden="true" />
          A product studio
        </p>

        <h1
          className="hero-rise mt-6 max-w-[14ch] text-balance text-[clamp(2.8rem,7vw,5.8rem)] font-semibold leading-[0.99] tracking-[-0.048em] text-foreground"
          style={riseDelay(0.13)}
        >
          Specialized software, built for the{" "}
          <em className="not-italic text-cobalt">people</em> who use it.
        </h1>

        <p
          className="hero-rise mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground"
          style={riseDelay(0.24)}
        >
          We build focused SaaS products — one industry at a time.{" "}
          {industryListPlain()}. Each product does one thing well and refuses
          to do everything else.
        </p>

        <div
          className="hero-rise mt-9 flex flex-wrap items-center gap-4"
          style={riseDelay(0.34)}
        >
          <MarketingButton as={Link} href="#products" variant="ink">
            Explore the products
          </MarketingButton>
          <MarketingButton as={Link} href="/about" variant="outline">
            About Tesserix
          </MarketingButton>
        </div>

        <p
          className="hero-rise mt-14 flex flex-wrap gap-0 border-t pt-0 font-mono text-xs tracking-[0.06em] text-muted-foreground"
          style={riseDelay(0.46)}
        >
          {launched.map((slug) => (
            <span
              key={slug}
              className="inline-flex items-center gap-2 py-3.5 pr-6"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-success"
                aria-hidden="true"
              />
              <b className="font-semibold text-foreground">
                {productTitle(slug)}
              </b>
              &nbsp;live
            </span>
          ))}
          {comingSoonCount > 0 && (
            <span className="inline-flex items-center py-3.5 pr-6">
              {comingSoonCount} more in development
            </span>
          )}
        </p>
      </div>
    </section>
  );
}
