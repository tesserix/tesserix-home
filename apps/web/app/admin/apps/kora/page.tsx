import { ProductOverviewLayout } from "@/components/admin/product-overview-layout";
import { getProductConfig } from "@/lib/products/configs";

export default function KoraOverviewPage() {
  return <ProductOverviewLayout config={getProductConfig("kora")} />;
}
