import type { Metadata } from "next";

// page.tsx here is a client component ("use client", for the animated
// scroll-in rows), so its metadata has to live in this server-rendered
// layout instead — a client component can't export `metadata` directly.
export const metadata: Metadata = {
  title: "Products",
  description:
    "The Tesserix product portfolio: Mark8ly, Fe3dr, Dwellm8, MediCare and Kora — one product per industry, each focused on doing a specific job well.",
  alternates: {
    canonical: "/products",
  },
};

export default function ProductsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
