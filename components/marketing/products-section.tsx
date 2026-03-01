import { ShoppingBag, ChefHat, Hospital, Trophy } from "lucide-react";
import { ProductCard } from "./product-card";

const products = [
  {
    title: "Mark8ly",
    description:
      "Multi-tenant marketplace platform for launching and scaling branded online stores with powerful admin tools.",
    icon: <ShoppingBag className="h-5 w-5" />,
    href: "/products/mark8ly",
    status: "available" as const,
    featured: true,
  },
  {
    title: "HomeChef",
    description:
      "Connect home chefs with food lovers for authentic, home-cooked meal delivery in your community.",
    icon: <ChefHat className="h-5 w-5" />,
    href: "/products/homechef",
    status: "available" as const,
  },
  {
    title: "MediCare",
    description:
      "Complete hospital management system covering patient records, appointments, billing, and inventory.",
    icon: <Hospital className="h-5 w-5" />,
    href: "/products/medicare",
    status: "available" as const,
  },
  {
    title: "FanZone",
    description:
      "The ultimate cricket fan experience with live scores, predictions, and community banter.",
    icon: <Trophy className="h-5 w-5" />,
    href: "/products/fanzone",
    status: "available" as const,
  },
];

export function ProductsSection() {
  return (
    <section className="py-24 sm:py-32 border-t">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Products
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Software solutions for marketplaces, healthcare, food delivery, and sports.
          </p>
        </div>

        <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2">
          {products.map((product) => (
            <ProductCard key={product.title} {...product} />
          ))}
        </div>
      </div>
    </section>
  );
}
