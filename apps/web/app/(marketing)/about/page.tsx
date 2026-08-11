import type { Metadata } from "next";
import { industryListPlain } from "../products/[slug]/products-data";
import { AboutContent } from "./about-content";

export const metadata: Metadata = {
  title: "About",
  description: `Tesserix is a small product studio building specialized SaaS — one industry at a time. ${industryListPlain()}.`,
  alternates: {
    canonical: "/about",
  },
};

export default function AboutPage() {
  return <AboutContent />;
}
