import type { Metadata } from "next";
import { AboutContent } from "./about-content";

export const metadata: Metadata = {
  title: "About",
  description:
    "Tesserix is a small product studio building specialized SaaS — one industry at a time. Commerce, sports, healthcare, food.",
};

export default function AboutPage() {
  return <AboutContent />;
}
