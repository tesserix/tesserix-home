"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { AnimateOnScroll, AppStoreBadges } from "@tesserix/web";
import {
  isComingSoon,
  products as productsData,
} from "@/app/(marketing)/products/[slug]/products-data";

type ShotTreatment = "browser" | "duo-phone";

/**
 * Visual treatment for each live product's screenshot frame. This is a
 * homepage-only presentational choice (not derived from products-data), so
 * it's a simple lookup keyed by slug. A launched product with no entry here
 * falls back to the browser frame using /screens/{slug}-web.jpg.
 */
const SHOT_TREATMENTS: Record<string, ShotTreatment> = {
  mark8ly: "browser",
  fe3dr: "duo-phone",
};

interface LiveProduct {
  slug: string;
  title: string;
  tagline: string;
  website?: string;
  href: string;
  listings?: Partial<
    Record<"ios" | "android", { url: string; artworkSrc: string }>
  >;
}

interface SoonProduct {
  slug: string;
  title: string;
  description: string;
  href: string;
}

// Title, tagline, description and launch state all come from
// products-data.ts — the single source of truth for product copy — rather
// than being restated here. Live products render as ledger rows in
// products-data order; coming-soon products render as cards, also in order.
const liveProducts: LiveProduct[] = [];
const soonProducts: SoonProduct[] = [];

for (const [slug, product] of Object.entries(productsData)) {
  if (isComingSoon(slug)) {
    soonProducts.push({
      slug,
      title: product.title,
      description: product.description,
      href: `/products/${slug}`,
    });
  } else {
    liveProducts.push({
      slug,
      title: product.title,
      tagline: product.tagline,
      website: product.website?.replace(/^https?:\/\//, ""),
      href: `/products/${slug}`,
      listings: product.listings,
    });
  }
}

const FRAME_CLASSES =
  "overflow-hidden rounded-[14px] border bg-card shadow-[0_24px_60px_-28px_rgba(11,14,20,0.25)] transition-[transform,box-shadow] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-1 group-hover:shadow-[0_32px_70px_-28px_rgba(11,14,20,0.32)]";

interface BrowserFrameProps {
  website: string;
  src: string;
  alt: string;
  width: number;
  height: number;
}

function BrowserFrame({ website, src, alt, width, height }: BrowserFrameProps) {
  return (
    <div className={FRAME_CLASSES}>
      <div className="flex items-center gap-1.5 border-b bg-muted/40 px-3.5 py-2">
        <span
          className="h-2 w-2 rounded-full bg-muted-foreground/30"
          aria-hidden="true"
        />
        <span
          className="h-2 w-2 rounded-full bg-muted-foreground/30"
          aria-hidden="true"
        />
        <span
          className="h-2 w-2 rounded-full bg-muted-foreground/30"
          aria-hidden="true"
        />
        <span className="ml-2 rounded-md border bg-background px-2.5 py-0.5 font-mono text-[0.58rem] text-muted-foreground">
          {website}
        </span>
      </div>
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        sizes="(min-width: 1024px) 45vw, 100vw"
        className="h-auto w-full"
      />
    </div>
  );
}

interface DuoPhoneFrameProps {
  leftSrc: string;
  leftAlt: string;
  rightSrc: string;
  rightAlt: string;
}

function DuoPhoneFrame({
  leftSrc,
  leftAlt,
  rightSrc,
  rightAlt,
}: DuoPhoneFrameProps) {
  return (
    <div className={FRAME_CLASSES}>
      <div className="flex items-start justify-center gap-[4%] bg-[linear-gradient(150deg,#10141c,#1a212e)] px-[6%] py-[5%]">
        <div className="w-[38%] rounded-[18px] border border-white/10 bg-[#0d1017] p-[5px]">
          <div className="overflow-hidden rounded-[14px]">
            <Image
              src={leftSrc}
              alt={leftAlt}
              width={1080}
              height={1920}
              loading="lazy"
              sizes="(min-width: 1024px) 18vw, 38vw"
              className="h-auto w-full"
            />
          </div>
        </div>
        <div className="w-[38%] translate-y-[8%] rounded-[18px] border border-white/10 bg-[#0d1017] p-[5px]">
          <div className="overflow-hidden rounded-[14px]">
            <Image
              src={rightSrc}
              alt={rightAlt}
              width={1080}
              height={1920}
              loading="lazy"
              sizes="(min-width: 1024px) 18vw, 38vw"
              className="h-auto w-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductShot({ slug, website }: { slug: string; website?: string }) {
  const treatment = SHOT_TREATMENTS[slug] ?? "browser";

  if (treatment === "duo-phone") {
    // Only Fe3dr uses the duo-phone treatment today, so its two screenshots
    // are wired directly rather than through a generic per-slug lookup.
    return (
      <DuoPhoneFrame
        leftSrc="/screens/fe3dr-app-browse.png"
        leftAlt="Fe3dr customer app"
        rightSrc="/screens/fe3dr-app-orders.png"
        rightAlt="Fe3dr cook orders queue"
      />
    );
  }

  const isMark8ly = slug === "mark8ly";
  return (
    <BrowserFrame
      website={website ?? slug}
      src={
        isMark8ly ? "/screens/mark8ly-storefront.jpg" : `/screens/${slug}-web.jpg`
      }
      alt={isMark8ly ? "Mark8ly storefront" : `${website ?? slug} website`}
      width={1568}
      height={682}
    />
  );
}

function ProductRow({ product }: { product: LiveProduct }) {
  return (
    <AnimateOnScroll variant="fade-up">
      <article className="group grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] items-center gap-[clamp(1.5rem,4vw,4rem)] border-b py-[clamp(2.2rem,5vh,3.4rem)] max-[860px]:grid-cols-1">
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="text-[clamp(1.7rem,3.2vw,2.4rem)] font-semibold tracking-[-0.03em] text-foreground">
              {product.title}
            </h3>
            <span className="inline-flex items-center gap-[0.45rem] rounded-full border border-[rgba(18,163,116,0.35)] bg-[rgba(18,163,116,0.07)] px-[0.7rem] py-[0.3rem] font-mono text-[0.66rem] uppercase tracking-[0.1em] text-success">
              <span
                className="h-[5px] w-[5px] rounded-full bg-success"
                aria-hidden="true"
              />
              Live
            </span>
          </div>
          <p className="mt-3 max-w-[26rem] text-muted-foreground">
            {product.tagline}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-6">
            {product.website ? (
              <a
                href={`https://${product.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[0.94rem] font-semibold text-cobalt hover:underline"
              >
                Visit {product.website}
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            ) : null}
            <Link
              href={product.href}
              className="inline-flex items-center gap-1 text-[0.94rem] text-muted-foreground transition-colors hover:text-foreground"
            >
              Learn more
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>

          {product.listings ? (
            <AppStoreBadges
              className="mt-4"
              appName={product.title}
              listings={product.listings}
              placeholder="coming-soon"
            />
          ) : null}
        </div>

        <ProductShot slug={product.slug} website={product.website} />
      </article>
    </AnimateOnScroll>
  );
}

function SoonCard({ product }: { product: SoonProduct }) {
  return (
    <AnimateOnScroll variant="fade-up">
      <article className="rounded-[14px] border bg-card p-[1.6rem] transition-[border-color,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-0.5 hover:border-cobalt">
        <div className="flex flex-wrap items-baseline gap-[0.8rem]">
          <h3 className="text-[1.2rem] font-semibold tracking-[-0.015em] text-foreground">
            {product.title}
          </h3>
          <span className="inline-flex items-center rounded-full border px-[0.7rem] py-[0.3rem] font-mono text-[0.66rem] uppercase tracking-[0.1em] text-muted-foreground">
            Soon
          </span>
        </div>
        <p className="mt-[0.7rem] text-[0.92rem] text-muted-foreground">
          {product.description}
        </p>
        <p className="mt-[1.1rem] font-mono text-[0.64rem] uppercase tracking-[0.1em] text-muted-foreground">
          In development · 2026
        </p>
        <Link
          href={product.href}
          className="mt-4 inline-flex items-center gap-1 text-[0.94rem] text-muted-foreground transition-colors hover:text-foreground"
        >
          Get notified
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </article>
    </AnimateOnScroll>
  );
}

export function ProductsGrid() {
  return (
    <section id="products" className="relative py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up">
          <p className="inline-flex items-center gap-[0.7rem] font-mono text-[0.7rem] uppercase tracking-[0.14em] text-cobalt">
            <span className="h-px w-[2.2rem] bg-cobalt" aria-hidden="true" />
            The portfolio
          </p>
          <h2 className="mt-4 max-w-2xl text-balance text-[clamp(2rem,4.6vw,3.4rem)] font-semibold leading-[1.04] tracking-[-0.04em] text-foreground">
            Five products. Each one focused.
          </h2>
          <p className="mt-4 max-w-[34rem] text-muted-foreground">
            We&apos;d rather make five products that do specific things well
            than one platform that does everything badly.
          </p>
        </AnimateOnScroll>

        <div className="mt-12 border-t border-line-strong">
          {liveProducts.map((product) => (
            <ProductRow key={product.slug} product={product} />
          ))}
        </div>

        {soonProducts.length > 0 ? (
          <div className="mt-8 grid grid-cols-3 gap-4 max-[860px]:grid-cols-1">
            {soonProducts.map((product) => (
              <SoonCard key={product.slug} product={product} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
