import { countWord, getProducts, isComingSoon } from "@/lib/cms/products";
import { ProductsIndex, type ProductEntry } from "./products-index";

// Title, tagline, description, highlights and launch state all come from the
// product data — the single source of truth for product copy. Shipped products
// lead; the numbering down the left is positional, so that ordering stays meaningful.
export default async function ProductsPage() {
  const data = await getProducts();
  const products: ProductEntry[] = Object.values(data).map((product) => ({
    slug: product.slug,
    title: product.title,
    tagline: product.tagline,
    description: product.description,
    website: product.website?.replace(/^https?:\/\//, ""),
    features: product.highlights,
    href: `/products/${product.slug}`,
    status: isComingSoon(data, product.slug) ? "soon" : "live",
  }));
  return <ProductsIndex products={products} portfolioSize={countWord(products.length)} />;
}
