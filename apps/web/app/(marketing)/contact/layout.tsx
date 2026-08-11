import type { Metadata } from "next";

// page.tsx here is a client component ("use client", for the form state), so
// its metadata has to live in this server-rendered layout instead — a client
// component can't export `metadata` directly.
export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with the team behind Tesserix's products. A reply from a person, usually within one business day.",
  alternates: {
    canonical: "/contact",
  },
};

export default function ContactLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
