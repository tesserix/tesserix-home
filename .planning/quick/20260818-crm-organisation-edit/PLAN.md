# Organisation edit surface (#227)

## Goal

An operator can correct an organisation's own fields — `name`, `location`,
`website_url`, `category`, `tags` — from the console, through `withCrmWrite`
like every other CRM write. Today the only `UPDATE crm_organisations` is
`linkConversion`, so a typo or an import-dropped URL can only be fixed by
deleting the row and cascading away its opportunities and activity log.

## Decisions (confirmed with Mahesh)

1. **An edit writes a `crm_activities` row.** One row per save, recording
   which fields changed. Creation stays unlogged — creating is not a stage
   transition — but changing a business's name under a live deal is exactly
   what the log exists to record.
2. **`converted_*` is not editable.** `crm_org_conversion_complete` requires
   `converted_ref` and `converted_product` travel together; `linkConversion`
   stays the deliberate single writer.

## Constraints carried from the existing code

- **`country` must be re-derived when `location` changes**, via
  `countryFromLocation` from `@tesserix/crm-country` — the same mapper
  `createOrganisation` (crm-writes.ts:171) and `commitImport`
  (crm-repo.ts:1409) use. #232 filters the follow-up queue by country; an
  edit that leaves `country` stale silently mis-files the organisation.
- **`updated_at = now()` by hand.** There is no trigger on the table.
- **`isSafeWebsiteUrl` (crm-url.ts:32) is checked in the data layer, not only
  the action.** `website_url` renders back as `<a href target="_blank">`; the
  writer that trusts its caller is how `javascript:` gets back in. The action
  keeps its own check to produce the field-level message.
- **No zod in apps/console.** Validation is hand-rolled at both layers,
  matching `organisations/new/actions.ts:53-63`.
- **The activity insert must share the update's transaction.** Follow
  `linkConversion` (crm-repo.ts:1673-1780): inline `INSERT INTO
  crm_activities`, kind `'note'`, *not* `logActivity` — that helper bumps
  `last_contacted_at` and runs the suppression check, neither of which is
  true of a field correction.
- **`organisation-detail-view.tsx` is 898 lines**, past the 800-line ceiling.
  The edit form lands in a new file; that view is not to grow.
- **Do not touch anything under `/admin/`**, and no links from the console to
  `/admin/` paths.

## Task 1 — data layer: `updateOrganisation`

`apps/console/lib/db/crm-writes.ts`.

**Delivered signature** (supersedes the sketch this plan first carried, which
omitted `actor` while also requiring the caller to supply it — `crm_activities.actor`
is `text NOT NULL`, so the two could not both hold):

```ts
export type OrganisationField = "name" | "location" | "websiteUrl" | "category" | "tags";

export interface ChangedField {
  field: OrganisationField;
  from: string | string[] | null;
  to: string | string[] | null;
}

export interface UpdateOrganisationInput {
  organisationId: string;
  actor: string;
  name: string;
  location?: string;
  websiteUrl?: string;
  category?: string[];
  tags?: string[];
}

export async function updateOrganisation(
  input: UpdateOrganisationInput,
): Promise<{ changed: ChangedField[] }>;
```

**Full replacement, not a patch.** An omitted `location`/`websiteUrl` clears
to NULL; an omitted `category`/`tags` clears to `[]` (both columns are
`text[] NOT NULL DEFAULT '{}'` — never NULL). This binds Task 3: **the edit
form must submit every editable field on every save**, pre-filled from the
current row. A partial submit silently erases the fields it omits.

- Rejects a blank `name` and an unsafe `websiteUrl`, mirroring
  `createOrganisation:105-122`.
- In one `tesserixTx`: `SELECT ... FOR UPDATE` the current row, diff it
  against the input, and if nothing changed, return `{ changed: [] }`
  **without** writing an UPDATE or an activity row — a no-op save must not
  forge an audit trail entry.
- Otherwise `UPDATE ... SET name, location, country, website_url, category,
  tags, updated_at = now()` and insert one `crm_activities` row
  (`organisation_id`, `actor`, kind `'note'`, a human-readable `body`,
  `metadata` = the per-field `{from, to}` diff).
- `actor` comes from the caller (the action passes `withCrmWrite`'s actor);
  do not default it inside the writer.
- Trim strings; empty string → NULL. Normalise `category`/`tags`: trim each
  entry, drop blanks, preserve order, de-duplicate.

Tests: unit in `crm-writes.test.ts`, and integration in
`crm-writes.integration.test.ts` against PGlite — covering the no-op case,
the country re-derivation, the array normalisation, the unsafe-URL rejection,
and that the activity row records the diff.

## Task 2 — server action: `updateOrganisationAction`

`apps/console/app/(console)/platform/crm/[organisation]/actions.ts`.

- Takes a `FormData` (matching `createOrganisationAction`'s shape) or a typed
  input — match whichever the create action does, for consistency.
- Field-level website message reusing the existing constant at
  `organisations/new/actions.ts:39`; blank-name rejection before any session
  or database work, so an invalid request never reaches
  `checkOperatorCapability` or the audit trail.
- `withCrmWrite(target, run, describe)` with no `capability` option — edits
  sit with create at the default, not with delete's `hard-delete`.
  `describe` → action `"crm.organisation.update"`, summary carrying the
  changed field names, target `` `${name} (${organisationId})` ``.
- `revalidatePath` for both the detail route and
  `/platform/crm/organisations` — the browse surface renders name and
  location.

Tests: `[organisation]/actions.test.ts`, matching that file's style of
reaching into `vi.mocked(withCrmWrite).mock.calls[0][1]` / `[0][2]`.

## Task 3 — UI: edit form

New file `apps/console/app/(console)/platform/crm/[organisation]/organisation-edit-form.tsx`,
rendered from `page.tsx`'s `actions` slot beside `DeleteOrganisationButton`.

- A dialog (the `@tesserix/web` primitive), pre-filled from the current row.
- Fields: `name` (required), `location`, `websiteUrl` (`type="url"`,
  `https://` placeholder), `category`, `tags`. The last two are the fields
  only the CSV import can set today — they are the import-repair path.
- Field-level error wiring (`isInvalid`/`errorText`, `role="alert"`,
  `aria-describedby`) copied from the manual-add form; other errors to a
  destructive `Callout`.
- On success: close, `router.refresh()`.

Tests: render tests alongside, matching `import-view.render.test.tsx`.

## Gates

`pnpm --filter console test:unit`, `pnpm lint`, `pnpm typecheck` (CI does not
run typecheck at all — #231 — so it must be run locally), `pnpm build`.

**No new dependencies.** If one becomes unavoidable, its `COPY` line must be
added to both Dockerfiles' per-package manifest block or the image build
fails while every local gate stays green.
