// See components/kit/page-header.tsx: @tesserix/web's barrel is "use client",
// so its exports are `undefined` inside a server component.
"use client";

import { ESTATE, type EstateProduct } from "@tesserix/console-core";

function ProductCard({ product }: { product: EstateProduct }) {
  return (
    <li
      className={
        product.migrated
          ? "flex flex-col gap-2 rounded-lg border border-success/40 bg-success-soft p-4"
          : "flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
      }
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{product.name}</h3>
        {/* The context key is the thing that actually identifies a rail in
            code, and it is not always the display name — Fe3dr's is
            "homechef". Showing it saves a lookup. */}
        <code className="ml-auto font-mono text-[10px] text-foreground-subtle">
          {product.context}
        </code>
      </div>

      <p className="text-xs text-muted-foreground">{product.summary}</p>

      <p className="mt-auto pt-1 text-xs tabular-nums text-muted-foreground">
        {product.entries === 0 ? (
          // "0 rail entries · still in apps/web" would be wrong twice over: it
          // is not in apps/web either. A product with no rail anywhere is a gap,
          // and should read as one.
          <span className="font-medium text-foreground">No rail yet</span>
        ) : (
          <>
            <span className="font-medium text-foreground">{product.entries}</span>{" "}
            rail {product.entries === 1 ? "entry" : "entries"}
            {/* THREE states, not two. `migrated` alone cannot answer this:
                a rail can be counted from console-core (`entriesFrom`) while
                not yet shipping, which is Mark8ly since tesserix-home#406 —
                its single entry is `pending` and `routes.ts` says a pending
                entry links NOWHERE, not even to apps/web. Deriving the
                suffix from `migrated` printed "· still in apps/web" over a
                count that came from neither. Same class of bug the
                `entries === 0` branch above already guards. */}
            {product.migrated ? (
              <span className="ml-2 font-medium text-success">
                · in console-core
              </span>
            ) : product.entriesFrom === "console-core" ? (
              <span className="ml-2">· scaffolded in console-core, not yet live</span>
            ) : (
              <span className="ml-2">· still in apps/web</span>
            )}
          </>
        )}
      </p>
    </li>
  );
}

/**
 * What the console covers, and how much of it has actually moved. This is the
 * migration's own status board: the one product whose IA lives in the shared
 * package is highlighted, and the rest are named rather than left implicit, so
 * the scale of what remains is visible instead of being a surprise.
 */
export function EstateMap() {
  const migrated = ESTATE.filter((product) => product.migrated).length;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="estate-heading">
      <div className="flex flex-col gap-1 border-t border-border pt-6">
        <h2 id="estate-heading" className="text-base font-semibold">
          The estate
        </h2>
        <p className="text-sm text-muted-foreground">
          {/* Derived, not written out. The prose said "five products" and went
              stale the moment HMS was added — the same way the DevAI and
              Dwellm8 summaries did. A count that has to be edited by hand is a
              count that eventually disagrees with the list beneath it. */}
          One platform rail and{" "}
          <span className="tabular-nums">{ESTATE.length - 1}</span> products.{" "}
          <span className="tabular-nums">
            {migrated} of {ESTATE.length}
          </span>{" "}
          migrated to the shared IA package; the rest still render from{" "}
          <code className="font-mono text-xs">apps/web</code>.
        </p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ESTATE.map((product) => (
          <ProductCard key={product.context} product={product} />
        ))}
      </ul>
    </section>
  );
}
