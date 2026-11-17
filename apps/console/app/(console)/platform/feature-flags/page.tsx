import Link from "next/link";
import { Flag, ArrowUpRight } from "lucide-react";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { fetchFeatureFlagProducts } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function FeatureFlagsPage() {
  const session = await getCurrentSession();
  if (!hasCapability(session?.roles, "platform"))
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Platform access is required to view feature flag controls.
      </p>
    );
  const result = await fetchFeatureFlagProducts()
    .then((products) => ({ products, error: false }))
    .catch(() => ({ products: [], error: true }));
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Feature flags"
        description="Control approved product releases from one console. Application permissions remain independently enforced."
        breadcrumbs={[
          { label: "Platform", href: "/" },
          { label: "Feature flags" },
        ]}
      />
      {result.error ? (
        <section role="alert" className="rounded-xl border bg-card p-6">
          <h2 className="font-semibold">
            The feature management API is unavailable
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Product connections could not be verified. Refresh this page to try
            again.
          </p>
        </section>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {result.products.map((product) => (
            <Link
              key={product.id}
              href="/platform/feature-flags/helivanta"
              className="group flex flex-col gap-5 rounded-xl border bg-card p-6 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-center justify-between">
                <span className="rounded-xl bg-primary/10 p-3 text-primary">
                  <Flag className="size-6" aria-hidden="true" />
                </span>
                <ArrowUpRight
                  className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  aria-hidden="true"
                />
              </div>
              <div>
                <h2 className="text-lg font-semibold">{product.name}</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {product.description}
                </p>
              </div>
              <div className="mt-auto flex justify-between gap-2 text-xs text-muted-foreground">
                <span>Production</span>
                <span>
                  {product.configured
                    ? "Open controls"
                    : "Connection setup pending"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
