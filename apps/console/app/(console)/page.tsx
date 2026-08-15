import { EstateMap } from "@/components/estate-map";
import { InternalTools } from "@/components/internal-tools";
import { ConsolePageHeader } from "@/components/kit/page-header";

export default function ConsoleHome() {
  // No data fetch. The home page renders the estate map and the tools
  // directory, both of which are static data — so it no longer queries
  // Mark8ly's database on every render to produce numbers it does not show.
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Platform"
        description="The estate at a glance."
      />
      {/* No stat tiles here. Tenants, stores and leads are MARK8LY's business
          numbers, and a platform home that leads with one product's figures is
          the mistake the console spec exists to correct. They belong in
          Mark8ly's own rail; DashboardView and fetchDashboard are kept for it.

          What replaces them is the cross-product ticket queue (#133), which is
          a platform-wide signal rather than one product's. */}
      <EstateMap />
      {/* Base domain is configuration, not a constant: a non-production console
          must not hand operators links into production tools. */}
      <InternalTools baseDomain={process.env.NEXT_PUBLIC_TOOLS_DOMAIN ?? "tesserix.app"} />
    </div>
  );
}
