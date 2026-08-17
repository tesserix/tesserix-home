/**
 * The one place that decides whether a `websiteUrl` is safe to store in
 * `crm_organisations.website_url`.
 *
 * That column is a plain `text` with no CHECK, and every value it holds is
 * later rendered back as a clickable `<a href target="_blank">` on the
 * organisation detail page (`[organisation]/page.tsx`). `type="url"` on an
 * HTML `<input>` is a browser-side hint only — a server action is directly
 * invocable — so nothing at the HTML layer stops `javascript:alert(1)` (or
 * `data:`, `vbscript:`, ...) from reaching this column and becoming a
 * clickable link for the next operator who opens the record.
 *
 * `crm-writes.ts` (manual create) and `crm-repo.ts` (CSV import,
 * `commitImport`) are both writers of this column; each calls this one
 * exported check rather than a copy, so a third writer can't reintroduce
 * the hole by skipping it.
 *
 * Parsed with the `URL` constructor, not a regex — a hand-rolled pattern
 * match on URLs is its own bug, prone to exactly the kind of scheme-check
 * bypass this function exists to close.
 */
export function isSafeWebsiteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
