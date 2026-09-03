/**
 * Rendering a §3.4 entity record's fields.
 *
 * One rule so far, and it is the one worth having in a single place: how an
 * unparseable timestamp is shown. It lived in `kora/foods/food-index.tsx`
 * while Kora's two index pages were its only callers; it moved here unchanged
 * when the generic `[product]/[entity]` index became a third, so that page's
 * client bundle references a five-line module rather than Kora's whole food
 * index.
 *
 * Deliberately NOT `platform/tenants/tenant-directory.tsx`'s `formatCreated`,
 * which shares the name and does something different — it renders "04 Mar
 * 2026" for the estate tenant directory. Two surfaces, two formats; merging
 * them would change one of them.
 */

/** Renders a §4.3 timestamp, falling back to the raw value.
 *
 *  Verbatim rather than "unknown" on an unparseable date: the product sent
 *  something, and showing what it sent is how someone finds out what is wrong
 *  with it. Inventing a placeholder hides a contract deviation. */
export function formatCreated(value: string | undefined): string {
  if (!value) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toISOString().slice(0, 10);
}
