import { ConsolePageHeader } from "@/components/kit/page-header";
import { SurfaceStateView } from "@/components/kit/states";

/**
 * Shown the moment the sidebar link is clicked. The listing usually comes from
 * platform-api's warm cache, but a replica that has just started reads every
 * open Dependabot alert in the org first — tens of seconds — and without this
 * the click looked like it had done nothing at all.
 */
export default function ReposLoading() {
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Repositories"
        description="Every repository in the GitHub organisation, its visibility and its open security alerts."
      />
      <SurfaceStateView state={{ kind: "loading" }} emptyMessage="" />
    </div>
  );
}
