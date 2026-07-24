import { SubscriptionsPageLayout } from "@/components/admin/subscriptions-page-layout";
import { getProductConfig } from "@/lib/products/configs";

export default function Mark8lySubscriptionsPage() {
  return <SubscriptionsPageLayout config={getProductConfig("mark8ly")} />;
}
