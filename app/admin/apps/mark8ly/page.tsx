import { ProductOverviewLayout } from "@/components/admin/product-overview-layout";
import { getProductConfig } from "@/lib/products/configs";

export default function Mark8lyOverviewPage() {
  return <ProductOverviewLayout config={getProductConfig("mark8ly")} />;
}
