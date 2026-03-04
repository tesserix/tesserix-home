import type { Metadata } from "next";
import { AboutContent } from "./about-content";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about Tesserix - our mission, values, and the team building the future of commerce.",
};

export default function AboutPage() {
  return <AboutContent />;
}
