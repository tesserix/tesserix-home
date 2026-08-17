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
 * `crm-writes.ts` (`createOrganisation`, manual create) and `crm-repo.ts`
 * (`commitImport`, CSV import) are the only two writers of this column, and
 * each calls this check itself, inside the data-layer function that performs
 * the INSERT — not one layer up in its action. That placement is the whole
 * guarantee: an exported writer that trusts its caller to have checked is
 * reachable unguarded by the next caller someone adds. `organisations/new`'s
 * action checks as well, and should — it is what turns the refusal into a
 * field-level message on the form — but nothing depends on it having done so.
 *
 * The two writers differ in what they do on a failed check, deliberately:
 * a manual create rejects the whole write (the operator is right there and
 * can fix the field), while an import stores NULL and counts the drop
 * (`droppedWebsiteUrls`), because one bad cell must not cost the other rows
 * in the batch.
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
