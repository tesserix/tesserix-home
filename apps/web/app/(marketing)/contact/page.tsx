import { getProducts } from "@/lib/cms/products";
import { ContactForm } from "./contact-form";

export default async function ContactPage() {
  const products = Object.values(await getProducts()).map((p) => ({ slug: p.slug, title: p.title }));
  return <ContactForm products={products} />;
}
