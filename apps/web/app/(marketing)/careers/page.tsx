import type { Metadata } from "next";
import { CareersContent } from "./careers-content";

export const metadata: Metadata = {
  title: "Careers",
  description:
    "Tesserix is a two-person studio with no open roles right now. Here's how we work, what we look for, and how to reach us.",
};

export default function CareersPage() {
  return <CareersContent />;
}
