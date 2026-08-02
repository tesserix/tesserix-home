import { ProductOverviewLayout } from "@/components/admin/product-overview-layout";
import { getProductConfig } from "@/lib/products/configs";

export default function Dwellm8OverviewPage() {
  return <ProductOverviewLayout config={getProductConfig("dwellm8")} />;
}
