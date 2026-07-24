import { ProductOverviewLayout } from "@/components/admin/product-overview-layout";
import { getProductConfig } from "@/lib/products/configs";

export default function HomechefOverviewPage() {
  return <ProductOverviewLayout config={getProductConfig("homechef")} />;
}
