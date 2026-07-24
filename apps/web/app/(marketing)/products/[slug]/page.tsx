import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { products } from "./products-data";
import { ProductContent } from "./product-content";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = products[slug];

  if (!product) {
    return {
      title: "Product Not Found",
    };
  }

  return {
    title: product.title,
    description: product.description,
  };
}

export async function generateStaticParams() {
  return Object.keys(products).map((slug) => ({ slug }));
}

export default async function ProductPage({ params }: PageProps) {
  const { slug } = await params;

  if (!products[slug]) {
    notFound();
  }

  return <ProductContent slug={slug} />;
}
