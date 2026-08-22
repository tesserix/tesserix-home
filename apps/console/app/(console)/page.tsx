import { EstateMap } from "@/components/estate-map";
import { InternalTools } from "@/components/internal-tools";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { readToolsDirectory } from "@/lib/tools-directory";

export default async function ConsoleHome() {
  // The tools directory is data now (#318): it comes from platform_tools
  // through the platform API, falling back to the built-in list. The estate
  // map is still static — its context list is a validation vocabulary the CRM
  // writes against, and moving it is a separate decision.
  const directory = await readToolsDirectory();

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
      <InternalTools
        baseDomain={process.env.NEXT_PUBLIC_TOOLS_DOMAIN ?? "tesserix.app"}
        directory={directory}
      />
    </div>
  );
}
