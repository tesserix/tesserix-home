import type { Metadata } from "next";
import { industryListPlain } from "@/lib/cms/products";
import { fallbackProducts } from "@/lib/cms/fallback/products";
import { AboutContent } from "./about-content";

export const metadata: Metadata = {
  title: "About",
  description: `Tesserix is a small product studio building specialized SaaS — one industry at a time. ${industryListPlain(fallbackProducts)}.`,
  alternates: {
    canonical: "/about",
  },
};

export default function AboutPage() {
  return <AboutContent />;
}
