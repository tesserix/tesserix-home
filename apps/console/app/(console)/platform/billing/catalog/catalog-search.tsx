// Load-bearing, same reason every other module on this surface carries one:
// `SearchFilterInput` and the empty state below reach `@tesserix/web`, whose
// barrel is `"use client"` — its exports are `undefined` in a server component
// (#539). `lib/server-component-web-import.guard.test.ts` holds the line.
"use client";

import { Button, EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@tesserix/web";
import { SearchX } from "lucide-react";
import { SearchFilterInput } from "@/components/kit/filter-bar";
// Type-only, the discipline this whole directory keeps: `plan-catalog-repo.ts`
// carries `import "server-only"`, so a VALUE import would drag `pg` into this
// bundle. Rows arrive as plain props.
import type { CatalogRow } from "@/lib/db/plan-catalog-repo";
import type { DraftEditorRow } from "./draft-editor";

/**
 * Search across the catalog's 42 lookup keys, shared by both panels.
 *
 * # Search is PRESENTATION, and nothing else
 *
 * Everything here filters what is RENDERED. Nothing here may reach a count, a
 * summary, or a publish. The Draft tab's `countChangedDraftRows` badge
 * (`catalog-surface.tsx`) is computed from `page.tsx`'s unfiltered rows and is
 * deliberately out of reach of these functions: a hidden changed row is still a
 * changed row and will still publish, so a search that shrank "12 changed" to
 * "2 changed" would let an operator publish eleven edits they believe are not
 * there. `catalog-search.test.tsx` asserts that invariant directly.
 *
 * # Why filtering is per LOOKUP KEY and not per row
 *
 * `readCatalogRows` returns flat (price x currency) rows — 78 of them for 42
 * prices. Dropping the individual rows that do not match would leave
 * `DevelopedCard` captioning a seven-currency Price "One price, 1 currency",
 * which is the exact false read `groupCatalogRows` exists to prevent. So a
 * currency match keeps the whole price it belongs to, and the caption stays
 * true of the Price rather than of the search.
 */

/** Trimmed and lower-cased once, at the boundary, so every comparison below is
 *  a plain substring test. An all-whitespace query is the same as no query. */
export function normalizeCatalogSearch(query: string): string {
  return query.trim().toLowerCase();
}

/** The three fields a search matches — named as an interface so both row
 *  shapes on this surface (published `CatalogRow`s and the editor's joined
 *  rows) test against exactly the same rule. */
export interface CatalogSearchable {
  readonly lookupKey: string;
  readonly plan: string;
  /** Every currency the price carries. Lower-case ISO 4217 as stored, per
   *  `plan_catalog_amounts_currency_is_lowercase_iso_4217`; a three-letter
   *  code therefore matches as a substring like everything else, so `inr`
   *  finds the INR rows and `in` finds them too. */
  readonly currencies: readonly string[];
}

/** `normalized` must already have been through {@link normalizeCatalogSearch}.
 *  An empty query matches everything — "no search" is not a filter. */
export function matchesCatalogSearch(entry: CatalogSearchable, normalized: string): boolean {
  if (normalized === "") return true;
  return (
    entry.lookupKey.toLowerCase().includes(normalized) ||
    entry.plan.toLowerCase().includes(normalized) ||
    entry.currencies.some((currency) => currency.toLowerCase().includes(normalized))
  );
}

/**
 * Narrows published rows to the lookup keys that match — all of a matching
 * price's rows, or none of them (see this module's header on why).
 *
 * Returns the input array unchanged for an empty query, so `Browse` can tell
 * "nothing matched" from "nothing to show" by identity as well as by length.
 */
export function filterCatalogRowsBySearch(
  rows: readonly CatalogRow[],
  query: string,
): readonly CatalogRow[] {
  const normalized = normalizeCatalogSearch(query);
  if (normalized === "") return rows;

  const currenciesByKey = new Map<string, string[]>();
  for (const row of rows) {
    const currencies = currenciesByKey.get(row.lookupKey) ?? [];
    currencies.push(row.currency);
    currenciesByKey.set(row.lookupKey, currencies);
  }

  const matched = new Set<string>();
  for (const row of rows) {
    if (matched.has(row.lookupKey)) continue;
    const entry: CatalogSearchable = {
      lookupKey: row.lookupKey,
      plan: row.plan,
      currencies: currenciesByKey.get(row.lookupKey) ?? [],
    };
    if (matchesCatalogSearch(entry, normalized)) matched.add(row.lookupKey);
  }

  return rows.filter((row) => matched.has(row.lookupKey));
}

/**
 * The same rule over the editor's rows, which are already one per lookup key
 * with their currencies folded in — so this one is a straight filter with no
 * regrouping step.
 */
export function filterDraftEditorRowsBySearch(
  rows: readonly DraftEditorRow[],
  query: string,
): readonly DraftEditorRow[] {
  const normalized = normalizeCatalogSearch(query);
  if (normalized === "") return rows;
  return rows.filter((row) =>
    matchesCatalogSearch(
      {
        lookupKey: row.lookupKey,
        plan: row.plan,
        currencies: row.amounts.map((amount) => amount.currency),
      },
      normalized,
    ),
  );
}

/**
 * The search box itself.
 *
 * `SearchFilterInput` from the kit rather than a second debounced input: it
 * already holds the draft locally, debounces the commit, and flushes on blur
 * and Enter. Its `onCommit` contract is written for `useUrlFilters` but names
 * nothing about the URL — it takes the committed string and gives it back —
 * so a `useState` setter satisfies it exactly, and the "an external change to
 * the value still wins over the draft" effect it carries is a no-op when the
 * value it is fed is the one it just committed.
 */
export function CatalogSearchField({
  label,
  value,
  onChange,
}: {
  /** Both the accessible name and the placeholder, per `SearchFilterInput`.
   *  The two panels pass different labels — their searches are separate. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  return <SearchFilterInput label={label} value={value} onCommit={onChange} />;
}

/**
 * What a search that matched nothing renders.
 *
 * `SurfaceStateView`'s `filtered-empty` was the house component to reach for
 * and does not fit: its copy is fixed ("No rows match the current filters")
 * and only the `empty` kind takes a message prop, so it cannot name the term
 * that was searched. On a client-side search over rows already on the page,
 * the term IS the whole explanation — an operator who mistyped a lookup key
 * needs to see what they typed. The shape below is `SurfaceStateView`'s,
 * icon and clear-action included, with the one sentence it could not carry.
 */
export function CatalogSearchEmpty({
  query,
  onClear,
}: {
  readonly query: string;
  readonly onClear: () => void;
}) {
  return (
    <EmptyState>
      <EmptyStateIcon>
        <SearchX aria-hidden="true" />
      </EmptyStateIcon>
      <EmptyStateTitle>No matches</EmptyStateTitle>
      <EmptyStateDescription>
        {`No lookup key, plan or currency matches “${query}”. Clearing the search shows everything again — nothing has been filtered out of what publishes.`}
      </EmptyStateDescription>
      <EmptyStateActions>
        <Button type="button" variant="outline" onClick={onClear}>
          Clear search
        </Button>
      </EmptyStateActions>
    </EmptyState>
  );
}
