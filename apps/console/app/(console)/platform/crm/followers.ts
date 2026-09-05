/**
 * Compact follower count — `1.2k`, `15k`, `1.2M`.
 *
 * Its own module because the organisations browse list
 * (`organisations/organisations-view.tsx`) and the organisation detail page
 * (`[organisation]/organisation-detail-view.tsx`) both render this number and
 * an operator moves between them mid-task: they filter and rank on the list,
 * then open a row to confirm the figure against the contact it belongs to. A
 * copy in each is two roundings waiting to disagree about the same contact.
 *
 * Not shared any wider than this app: `formatFollowers` in
 * `apps/web/app/admin/apps/mark8ly/leads/page.tsx` is the same arithmetic over
 * a different table in a different app, and reaching across that boundary
 * would couple two surfaces that only happen to agree today.
 *
 * The decimal is dropped from five figures up because at that size the tenth
 * of a thousand is noise the operator cannot act on, and every caller keeps
 * the exact number a hover away via `followersTitle`.
 */
export function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * The hover text that restores the precision `formatFollowers` drops.
 *
 * Shared alongside the formatter rather than written at each call site: the
 * abbreviation is only defensible while the exact figure stays reachable, so
 * the two belong together.
 */
export function followersTitle(n: number): string {
  return `${n.toLocaleString()} followers`;
}
