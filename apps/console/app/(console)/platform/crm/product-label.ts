import { ESTATE } from "@tesserix/console-core";

/**
 * The estate's product name for a row's raw context, falling back to the raw
 * value (or "Unassigned") for a row with no product.
 *
 * `product` is null on any lead below `qualified` and on every migrated deal
 * (0020/0021 grandfather those rows), so both the work queues and the closed
 * list render it. Its own module because `page.tsx` and `closed-tab.tsx` both
 * need it and `page.tsx` imports `closed-tab.tsx` — a copy in each would be
 * two spellings of "Unassigned" waiting to disagree.
 */
export function productLabel(product: string | null): string {
  if (!product) return "Unassigned";
  return ESTATE.find((entry) => entry.context === product)?.name ?? product;
}
