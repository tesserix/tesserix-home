import type { Metadata } from "next";
import { getProducts, industryListPlain } from "@/lib/cms/products";
import { getPrinciples, getTeam } from "@/lib/cms/site";
import { AboutContent } from "./about-content";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "About",
    description: `Tesserix is a small product studio building specialized SaaS — one industry at a time. ${industryListPlain(await getProducts())}.`,
    alternates: {
      canonical: "/about",
    },
  };
}

export default async function AboutPage() {
  const [products, team, principles] = await Promise.all([getProducts(), getTeam(), getPrinciples()]);
  return <AboutContent products={products} team={team} principles={principles} />;
}
