# CRM Browse at Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CRM organisation browse surface usable at 259 rows today and at several products' worth of leads tomorrow — pagination, filters that match the axes the data actually varies on, and identity rendering that tells the truth about solo Instagram creators.

**Architecture:** Three shippable groups, each its own PR. Group A fixes reachability (pagination + total count) because nothing else matters while a third of the rows are invisible. Group B adds the filter axes. Group C fixes how a row identifies itself. Every filter lives in SQL, ahead of `ORDER BY`/`LIMIT` — filtering a returned page answers "matches among the first N" rather than "the first N matches", which in a work queue is a silent false negative.

**Tech Stack:** Next.js 16 App Router (React 19 server components), TypeScript, `pg` against tesserix-postgres, `pglite` for integration tests, vitest, `@tesserix/web`.

**Issues:** #225 (pagination). Follows #213.

## Context — the production data this is designed against

Measured 2026-08-18, immediately after the CRM migration landed 259 leads:

| Field | Spread | Consequence |
|---|---|---|
| `crm_opportunities.stage` | 259 × `new` | no discriminating power **yet** |
| `crm_opportunities.product` | 259 × NULL | every row is "Unassigned" |
| `crm_opportunities.owner` | 259 × NULL | no discriminating power yet |
| `crm_opportunities.source` | 259 × `instagram_outreach` | single-valued; not worth a filter |
| `crm_contacts.followers_count` | 178 `<1k`, 24 `1k–10k`, 6 `10k+`, 51 NULL | **the real qualification axis today** |
| `crm_contacts.email` | 3 present, 256 NULL | tiny but high-value: the only non-DM reachable leads |
| `crm_contacts.instagram_handle` | 259 present | the actual identity of every row |
| `crm_organisations.location` | 208 NULL, then `Australia` 16, `Chennai` 3, `Mumbai, Maharashtra` 3, `Kerala` 2, `Delhi` 2 | free text mixing countries, states and cities |
| `crm_organisations.category` | 65 empty, 32 literal `"None"`, then a long tail | scrape noise; **not** a filter axis |

Three design consequences, all load-bearing:

**Product and stage get filters despite being single-valued today.** They are the axes the estate grows along — a second product's leads arrive and product becomes the primary cut. Building them now is deliberate, not speculative.

**Location is filtered by COUNTRY, not by the raw string.** The raw values mix granularities — `Australia` is a country, `Chennai` and `Delhi` are cities, `Kerala` is a state, `Mumbai, Maharashtra` is both. Filtering that free text gives a long tail of near-duplicates that gets worse with every product added. So a normalised `country` column is added and filtered as a closed set of chips, while the raw `location` stays exactly as scraped for display. **Normalise, do not overwrite** — the raw string is what the scrape actually saw and is the only way to re-derive country if the mapping is later found wrong.

**Category gets nothing at all.** `"None"` as a literal string is scrape noise, and filtering on it would dignify bad data.

## Global Constraints

- **Nothing under `apps/web/app/admin/` is edited, and no console file gains a navigational link to an `/admin/` path.** The console is a fully independent app; the old admin is not being retired.
- **Filters live in SQL, ahead of `ORDER BY`/`LIMIT`.** Never filter an already-returned page in TypeScript.
- **Bound parameters only.** Separately, escape `%` and `_` (backslash first) in any ILIKE pattern with `ESCAPE '\'` — `filterClause` (`crm-repo.ts:113`) is the established treatment.
- **`product` lives on `crm_opportunities`, never on the organisation.** An organisation matches a product filter when it has *at least one* opportunity carrying that product. Reuse `UNASSIGNED_PRODUCT` from `@/lib/db/crm-filters` for the null case — do not invent a second sentinel.
- **Every active filter counts toward `resolveState`'s `filtered` flag**, so an empty result reads as `filtered-empty` ("nothing matches what you asked for") rather than `empty` ("nothing is waiting").
- Reads go through `dbReadError` (`@/lib/db-read-error`), never `toSurfaceError` — a raw `pg` message would render a relation name to an operator.
- `resolveState` is imported from `@/components/kit/surface-state`, never from `@/components/kit/states` (a `"use client"` module whose exports throw when called in a server component).
- WCAG 2.1 AA on every surface. Filter controls keyboard-operable, results changes announced.
- Comments explain *why*, not *what*, matching surrounding density.
- Gates before every commit: `pnpm --filter console exec vitest run`, `pnpm --filter console lint`, `pnpm --filter console exec tsc --noEmit`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/db/migrations/0025_crm_organisations_country.sql` (create) | derived `country` column + partial index |
| `apps/web/scripts/backfill-crm-country.mjs` (create) | one-shot backfill; dry-run by default, names unmapped values |
| `apps/console/lib/db/crm-country.ts` (create) | `countryFromLocation` — the single mapping, shared by backfill, import, manual create |
| `apps/console/lib/db/crm-repo.ts` (modify) | `OrganisationFilter` gains fields; `listOrganisations` gains keyset pagination + total; `commitImport` derives country |
| `apps/console/lib/db/crm-writes.ts` (modify) | `createOrganisation` derives country |
| `apps/console/lib/db/crm-filters.ts` (modify) | follower-band constants shared by repo and view |
| `apps/console/app/(console)/platform/crm/organisations/page.tsx` (modify) | reads the new params, passes them down, resolves state |
| `apps/console/app/(console)/platform/crm/organisations/organisations-view.tsx` (modify) | `FilterBar` instead of a lone `SearchFilterInput`; pager; handle-first identity |

---

# GROUP A — Reachability (PR 1)

### Task 1: Total count and keyset pagination

**Files:**
- Modify: `apps/console/lib/db/crm-repo.ts` (`listOrganisations`, and the `OrganisationFilter`/`OrganisationListRow` interfaces)
- Test: `apps/console/lib/db/crm-repo.integration.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface OrganisationPage {
  rows: OrganisationListRow[];
  /** Total matching the filter, ignoring pagination. */
  total: number;
  /** Opaque cursor for the next page; null when this is the last page. */
  nextCursor: string | null;
}

export async function listOrganisations(
  filter: OrganisationFilter,
  limit: number,
  cursor?: string,
): Promise<OrganisationPage>
```

`OrganisationFilter` gains `cursor` handling via the third argument, not a filter field — a cursor is position, not a predicate.

**Why keyset, not OFFSET.** The list orders by `created_at DESC`. `OFFSET 200` makes Postgres walk and discard 200 rows every page, and worse, a row inserted while the operator pages shifts every subsequent page by one — so a lead can be skipped entirely, which on this surface means never contacted. Keyset on `(created_at, id)` is stable under concurrent inserts and reads straight off the existing ordering. `id` is the tiebreaker because `created_at` is not unique — the migration wrote 259 rows inside one batch.

- [ ] **Step 1: Write the failing integration test**

Extend the existing `describe("listOrganisations", …)` block in `crm-repo.integration.test.ts`. Reuse the existing pglite harness; do not create a second instance. Seed at least 5 organisations with distinct, ordered `created_at` values.

```typescript
it("returns a total that ignores the page limit", async () => {
  const page = await listOrganisations({}, 2);
  expect(page.rows).toHaveLength(2);
  // The count an operator reads as "2 of 7" — it must reflect the whole
  // matching set, not the page, or the pager lies about how much is left.
  expect(page.total).toBeGreaterThanOrEqual(5);
});

it("pages forward without repeating or skipping a row", async () => {
  const first = await listOrganisations({}, 2);
  const second = await listOrganisations({}, 2, first.nextCursor ?? undefined);
  const ids = [...first.rows, ...second.rows].map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
});

it("reports nextCursor null on the last page", async () => {
  const all = await listOrganisations({}, 100);
  expect(all.nextCursor).toBeNull();
});

it("counts the filtered set, not the whole table", async () => {
  // A total that ignores the filter would tell the operator there are 259
  // matches for a search returning 1.
  const page = await listOrganisations({ search: "Glebe Flowers" }, 50);
  expect(page.total).toBe(page.rows.length);
});

it("does not skip a row when one is inserted between pages", async () => {
  // The OFFSET failure this design exists to avoid: a newer row shifts every
  // later page by one, and the row pushed across the boundary is never seen.
  const first = await listOrganisations({}, 2);
  await db.query(`INSERT INTO crm_organisations (name) VALUES ($1)`, ["Inserted Mid-Page"]);
  const second = await listOrganisations({}, 2, first.nextCursor ?? undefined);
  expect(second.rows.map((r) => r.id)).not.toContain(first.rows[1].id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/db/crm-repo.integration.test.ts`
Expected: FAIL — `listOrganisations` returns an array, not `{ rows, total, nextCursor }`.

- [ ] **Step 3: Implement**

Split the existing WHERE-building into a helper both the page query and the count query call, so the two can never disagree about what "matching" means — a count built from a second, hand-copied predicate is the classic way a pager starts lying.

The cursor encodes `created_at` and `id` of the last row on the page. Encode it opaquely (base64 of `<iso>|<uuid>` is enough) so the surface cannot be tempted to construct one, and **validate it on the way in** — a malformed cursor is rejected, never coerced. The keyset predicate is `(g.created_at, g.id) < ($cursorTs, $cursorId)` with `ORDER BY g.created_at DESC, g.id DESC`.

Fetch `limit` rows exactly; derive `nextCursor` from whether `total` exceeds rows-seen-so-far, or fetch `limit + 1` and drop the extra — pick one and say which in a comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter console exec vitest run lib/db/crm-repo.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Run every gate, then commit**

```bash
pnpm --filter console exec vitest run && pnpm --filter console lint && pnpm --filter console exec tsc --noEmit
git add apps/console/lib/db/crm-repo.ts apps/console/lib/db/crm-repo.integration.test.ts
git commit -m "feat(crm): paginate listOrganisations with a keyset cursor and a total"
```

---

### Task 2: The pager on the surface

**Files:**
- Modify: `apps/console/app/(console)/platform/crm/organisations/page.tsx`
- Modify: `apps/console/app/(console)/platform/crm/organisations/organisations-view.tsx`
- Test: `apps/console/app/(console)/platform/crm/organisations/page.test.tsx`

**Interfaces:**
- Consumes: `listOrganisations(filter, limit, cursor)` → `OrganisationPage` from Task 1.
- Produces: the surface reads `?cursor=<opaque>` alongside its existing `?q=` and `?import=`.

- [ ] **Step 1: Write the failing test**

```typescript
it("shows how many of the total are on screen", async () => {
  listOrganisations.mockResolvedValue({ rows: manyRows(100), total: 259, nextCursor: "abc" });
  render(await Page({ searchParams: Promise.resolve({}) }));
  // The truncation notice this replaces said only "there are more". An
  // operator sizing up a 259-lead backlog needs the number.
  expect(screen.getByText(/100 of 259/i)).toBeInTheDocument();
});

it("offers a next control only when there is a next page", async () => {
  listOrganisations.mockResolvedValue({ rows: manyRows(100), total: 259, nextCursor: "abc" });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole("link", { name: /next/i })).toBeInTheDocument();
});

it("offers no next control on the last page", async () => {
  listOrganisations.mockResolvedValue({ rows: manyRows(9), total: 9, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.queryByRole("link", { name: /next/i })).toBeNull();
});

it("passes the cursor through to the repo", async () => {
  listOrganisations.mockResolvedValue({ rows: [], total: 0, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({ cursor: "abc" }) }));
  expect(listOrganisations).toHaveBeenCalledWith(expect.anything(), expect.any(Number), "abc");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/crm/organisations"`
Expected: FAIL — the page still calls the old array-returning signature.

- [ ] **Step 3: Implement**

Replace the over-fetch-by-one truncation notice with the real pager. **Delete the deferred-pagination comment** — it is no longer true.

Paging is links (`<a href>` carrying `?cursor=`), not buttons: a page of results is a location, so it must be back-button-navigable and shareable. Preserve every other active param when building the next link, or paging silently drops the operator's filters.

Announce the result count change politely (`aria-live="polite"`) so a screen-reader operator learns the list changed.

- [ ] **Step 4: Run tests, then every gate, then commit**

```bash
pnpm --filter console exec vitest run && pnpm --filter console lint && pnpm --filter console exec tsc --noEmit
git add "apps/console/app/(console)/platform/crm/organisations"
git commit -m "feat(crm): page the organisation browse surface"
```

**PR 1 opens here** — `feat(crm): paginate the organisation browse surface (#225)`.

---

# GROUP B — Filters (PR 2)

### Task 3: A normalised `country` column

**Files:**
- Create: `apps/web/db/migrations/0025_crm_organisations_country.sql`
- Create: `apps/console/lib/db/crm-country.ts`
- Test: `apps/console/lib/db/crm-country.test.ts`

**Why a column and not a query-time derivation.** Deriving country from free text on every read means the mapping runs 259 times per page load and cannot be indexed, so the filter would degrade exactly as the dataset grows — which is the thing this plan exists to prevent. A column is derived once and indexed.

**Interfaces:**
- Produces: `crm_organisations.country text` (ISO 3166-1 alpha-2, e.g. `AU`, `IN`), and

```typescript
// crm-country.ts
/** Best-effort country for a raw scraped location. Null when unknown. */
export function countryFromLocation(location: string | null): string | null;
export const COUNTRY_LABELS: Readonly<Record<string, string>>;
```

- [ ] **Step 1: Write the failing mapper test**

```typescript
it("maps a bare country name", () => {
  expect(countryFromLocation("Australia")).toBe("AU");
});

it("maps Indian cities and states to IN", () => {
  // The scrape returns city, state and "city, state" interchangeably —
  // Chennai, Kerala and "Mumbai, Maharashtra" are all one country.
  expect(countryFromLocation("Chennai")).toBe("IN");
  expect(countryFromLocation("Kerala")).toBe("IN");
  expect(countryFromLocation("Mumbai, Maharashtra")).toBe("IN");
  expect(countryFromLocation("Delhi")).toBe("IN");
});

it("is case- and whitespace-insensitive", () => {
  expect(countryFromLocation("  chennai ")).toBe("IN");
});

it("returns null for an unknown location rather than guessing", () => {
  // A wrong country is worse than no country: it silently files a lead
  // under a market it is not in, and the operator has no way to notice.
  expect(countryFromLocation("Somewhere Else")).toBeNull();
  expect(countryFromLocation(null)).toBeNull();
  expect(countryFromLocation("")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/db/crm-country.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the mapper**

An explicit lookup table, not a library — the estate has one country of operation plus scattered international leads, and a full geocoding dependency for 51 non-null values would be absurd. Normalise by lowercasing, trimming, and taking the segment after the last comma as well as the whole string, so both `Mumbai, Maharashtra` and `Maharashtra` resolve.

Cover at minimum every value present in production today (`Australia`, `Chennai`, `Mumbai, Maharashtra`, `Kerala`, `Delhi`) plus the obvious Indian metros and states, and return `null` for anything unrecognised. Record in a comment that unmapped values are expected and are surfaced, not hidden.

- [ ] **Step 4: Write the migration**

`0025_crm_organisations_country.sql` adds the column and its index. The column is **derived, not authoritative** — say so in the header, and say that `location` is never overwritten.

```sql
ALTER TABLE crm_organisations
  ADD COLUMN IF NOT EXISTS country text;

-- Partial: most rows have no location to derive from (208 of 259 today),
-- and the only query filtering on this asks for a specific country.
CREATE INDEX IF NOT EXISTS crm_org_country_idx
  ON crm_organisations (country)
  WHERE country IS NOT NULL;
```

Do **not** backfill in SQL. The mapping lives in TypeScript so one implementation serves the backfill, the import path and manual add; a second copy in SQL is the divergence this codebase has been bitten by before.

- [ ] **Step 5: Write the backfill script**

`apps/web/scripts/backfill-crm-country.mjs`, modelled on `migrate-leads-to-crm.mjs`: dry-run by default, `--commit` to write, reports mapped / unmapped counts, and **names the distinct unmapped values on exit** so the operator can extend the table rather than discovering the gap through an empty filter.

- [ ] **Step 6: Run the tests, then every gate, then commit**

```bash
pnpm --filter console exec vitest run && pnpm --filter console lint && pnpm --filter console exec tsc --noEmit
git add apps/web/db/migrations/0025_crm_organisations_country.sql apps/web/scripts/backfill-crm-country.mjs apps/console/lib/db/crm-country.ts apps/console/lib/db/crm-country.test.ts
git commit -m "feat(crm): derive a country column from scraped locations"
```

---

### Task 4: Populate country on the write paths

**Files:**
- Modify: `apps/console/lib/db/crm-repo.ts` (`commitImport`)
- Modify: `apps/console/lib/db/crm-writes.ts` (`createOrganisation`)
- Test: `apps/console/lib/db/crm-repo.write.integration.test.ts`, `apps/console/lib/db/crm-writes.integration.test.ts`

**Why this task exists.** A backfilled column that no writer maintains decays into a filter that silently stops matching new rows — the operator sees fewer results and has no reason to suspect the filter rather than the data. Both writers must derive `country` at insert time, using the same `countryFromLocation` the backfill used.

- [ ] **Step 1: Write the failing tests**

```typescript
it("derives country when an import row carries a location", async () => {
  await commitImport([rowWithLocation("Chennai")], "actor");
  const rows = await db.query(`SELECT location, country FROM crm_organisations WHERE name = $1`, [name]);
  // location is kept exactly as scraped; country is the derived view of it.
  expect(rows.rows[0].location).toBe("Chennai");
  expect(rows.rows[0].country).toBe("IN");
});

it("leaves country null for an unmappable import location", async () => {
  await commitImport([rowWithLocation("Somewhere Else")], "actor");
  const rows = await db.query(`SELECT country FROM crm_organisations WHERE name = $1`, [name]);
  expect(rows.rows[0].country).toBeNull();
});

it("derives country on manual create", async () => {
  const { organisationId } = await createOrganisation({ name: "Manual Co", location: "Delhi" });
  const rows = await db.query(`SELECT country FROM crm_organisations WHERE id = $1`, [organisationId]);
  expect(rows.rows[0].country).toBe("IN");
});
```

- [ ] **Step 2: Run tests to verify they fail, implement, re-run**

Run: `pnpm --filter console exec vitest run lib/db/`
Both writers call `countryFromLocation(location)` and insert the result alongside the raw `location`.

- [ ] **Step 3: Run every gate, then commit**

```bash
pnpm --filter console exec vitest run && pnpm --filter console lint && pnpm --filter console exec tsc --noEmit
git add apps/console/lib/db/crm-repo.ts apps/console/lib/db/crm-writes.ts apps/console/lib/db/crm-repo.write.integration.test.ts apps/console/lib/db/crm-writes.integration.test.ts
git commit -m "feat(crm): derive country on the import and manual-create paths"
```

---

### Task 5: Repo-side filter predicates

**Files:**
- Modify: `apps/console/lib/db/crm-repo.ts` (`OrganisationFilter`)
- Modify: `apps/console/lib/db/crm-filters.ts` (follower bands)
- Test: `apps/console/lib/db/crm-repo.integration.test.ts`

**Interfaces:**
- Consumes: `UNASSIGNED_PRODUCT` from `crm-filters.ts`.
- Produces:

```typescript
// crm-filters.ts
export const FOLLOWER_BANDS = {
  under1k: { label: "Under 1k", min: 0, max: 999 },
  k1to10k: { label: "1k–10k", min: 1000, max: 9999 },
  over10k: { label: "10k+", min: 10000, max: null },
} as const;
export type FollowerBand = keyof typeof FOLLOWER_BANDS;
export function isFollowerBand(value: string): value is FollowerBand;

// crm-repo.ts — OrganisationFilter gains:
  product?: string;        // a real product, or UNASSIGNED_PRODUCT
  country?: string;        // ISO 3166-1 alpha-2, exact match on the derived column
  followers?: FollowerBand;
  hasEmail?: boolean;
```

- [ ] **Step 1: Write the failing integration test**

Seed organisations covering each axis: one with a `mark8ly` opportunity, one with a NULL-product opportunity, one in `Chennai`, one with a contact at 15000 followers, one with an email and one without.

```typescript
it("matches an organisation by a product on any of its opportunities", async () => {
  // product lives on the opportunity, and an org may have several — so this
  // is an EXISTS, never a join that would duplicate the org row.
  const page = await listOrganisations({ product: "mark8ly" }, 50);
  expect(page.rows.map((r) => r.id)).toContain(mark8lyOrgId);
  expect(page.rows.map((r) => r.id)).not.toContain(unassignedOrgId);
});

it("matches unassigned organisations on the shared sentinel", async () => {
  // Every migrated lead is unassigned today — this is the most-used option,
  // not an edge case.
  const page = await listOrganisations({ product: UNASSIGNED_PRODUCT }, 50);
  expect(page.rows.map((r) => r.id)).toContain(unassignedOrgId);
  expect(page.rows.map((r) => r.id)).not.toContain(mark8lyOrgId);
});

it("returns one row per organisation when several opportunities match", async () => {
  // Two mark8ly opportunities on one org must not render it twice.
  await db.query(`INSERT INTO crm_opportunities (organisation_id, stage, product) VALUES ($1,'new','mark8ly')`, [mark8lyOrgId]);
  const page = await listOrganisations({ product: "mark8ly" }, 50);
  expect(page.rows.filter((r) => r.id === mark8lyOrgId)).toHaveLength(1);
});

it("matches organisations by derived country, across location granularities", async () => {
  // The point of the derived column: "Chennai", "Kerala" and
  // "Mumbai, Maharashtra" are one country and must come back together,
  // which no substring match on the raw location could do.
  const page = await listOrganisations({ country: "IN" }, 50);
  const ids = page.rows.map((r) => r.id);
  expect(ids).toEqual(expect.arrayContaining([chennaiOrgId, keralaOrgId, mumbaiOrgId]));
  expect(ids).not.toContain(australiaOrgId);
});

it("excludes organisations whose country could not be derived", async () => {
  // 208 of 259 rows have no location at all. They must not fall into some
  // default country and be read as leads in a market they are not in.
  const page = await listOrganisations({ country: "IN" }, 50);
  expect(page.rows.map((r) => r.id)).not.toContain(noLocationOrgId);
});

it("filters by follower band on the primary contact", async () => {
  const page = await listOrganisations({ followers: "over10k" }, 50);
  expect(page.rows.map((r) => r.id)).toEqual([bigCreatorOrgId]);
});

it("excludes unknown follower counts from every band", async () => {
  // 51 of 259 contacts have no follower count. A NULL must not silently
  // land in the lowest band and be read as a qualified-out lead.
  const page = await listOrganisations({ followers: "under1k" }, 50);
  expect(page.rows.map((r) => r.id)).not.toContain(nullFollowersOrgId);
});

it("filters to organisations whose contact has an email", async () => {
  const page = await listOrganisations({ hasEmail: true }, 50);
  expect(page.rows.map((r) => r.id)).toEqual([emailOrgId]);
});

it("composes filters", async () => {
  const page = await listOrganisations({ product: UNASSIGNED_PRODUCT, hasEmail: true }, 50);
  expect(page.total).toBe(page.rows.length);
});

it("counts the filtered set when filters compose", async () => {
  // The count query and the page query must build their predicate from the
  // same helper — a hand-copied second predicate is how a pager starts lying.
  const page = await listOrganisations({ country: "IN" }, 1);
  expect(page.total).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run lib/db/crm-repo.integration.test.ts`
Expected: FAIL — the new filter fields are not in `OrganisationFilter`.

- [ ] **Step 3: Implement**

Every new predicate goes into the shared WHERE-builder from Task 1, so the count and the page stay in agreement.

- **product:** `EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.organisation_id = g.id AND o.product = $n)`, or `AND o.product IS NULL` for the sentinel. `EXISTS`, not a join — a join fans one organisation into a row per matching opportunity.
- **country:** `g.country = $n` — an exact match on the derived column from Task 3, not a pattern over the raw `location`. Uses `crm_org_country_idx`. A NULL `country` matches no filter value, which is correct: an underivable location is not evidence of any market.
- **followers:** an `EXISTS` over the primary contact (`ORDER BY is_primary DESC, created_at ASC LIMIT 1`), bounded by the band. `followers_count IS NOT NULL` is required explicitly — a NULL must not fall into the lowest band.
- **hasEmail:** `EXISTS (… AND c.email IS NOT NULL)`.

- [ ] **Step 4: Run tests to verify they pass, then every gate, then commit**

```bash
pnpm --filter console exec vitest run && pnpm --filter console lint && pnpm --filter console exec tsc --noEmit
git add apps/console/lib/db/crm-repo.ts apps/console/lib/db/crm-filters.ts apps/console/lib/db/crm-repo.integration.test.ts
git commit -m "feat(crm): add product, location, follower and email filters to the org list"
```

---

### Task 6: The filter bar on the surface

**Files:**
- Modify: `apps/console/app/(console)/platform/crm/organisations/page.tsx`
- Modify: `apps/console/app/(console)/platform/crm/organisations/organisations-view.tsx`
- Test: `apps/console/app/(console)/platform/crm/organisations/page.test.tsx`

**Interfaces:**
- Consumes: `OrganisationFilter`'s new fields (Task 3); `FOLLOWER_BANDS`, `isFollowerBand`, `UNASSIGNED_PRODUCT`.

- [ ] **Step 1: Write the failing test**

```typescript
it("passes every recognised filter through to the repo", async () => {
  listOrganisations.mockResolvedValue({ rows: [], total: 0, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({
    q: "priya", product: "mark8ly", country: "IN", followers: "over10k", email: "1",
  }) }));
  expect(listOrganisations).toHaveBeenCalledWith(
    { search: "priya", product: "mark8ly", country: "IN", followers: "over10k", hasEmail: true },
    expect.any(Number),
    undefined,
  );
});

it("drops an unrecognised follower band rather than passing it to SQL", async () => {
  // Same contract the queue's readQueueFilters follows: an unrecognised
  // value means no filter, never a value the repo has to defend against.
  listOrganisations.mockResolvedValue({ rows: [], total: 0, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({ followers: "banana" }) }));
  expect(listOrganisations).toHaveBeenCalledWith({}, expect.any(Number), undefined);
});

it("resolves filtered-empty, not empty, when a filter matches nothing", async () => {
  listOrganisations.mockResolvedValue({ rows: [], total: 0, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({ product: "mark8ly" }) }));
  expect(screen.getByText("No matches")).toBeInTheDocument();
  expect(screen.queryByText("Nothing here yet")).toBeNull();
});

it("offers Unassigned as a product option", async () => {
  // Every migrated lead is unassigned; without this option the product
  // filter hides the entire current dataset.
  listOrganisations.mockResolvedValue({ rows: [], total: 0, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText(/unassigned/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/crm/organisations"`
Expected: FAIL — the page reads only `q` and `import`.

- [ ] **Step 3: Implement**

Swap the lone `SearchFilterInput` for a full `FilterBar` — the surface now has five filters, which is what `FilterBar` exists for. Update the comment above the descriptors: it currently explains why a single descriptor was enough, and that reason has expired.

Product options come from `ESTATE` (the same source the queue's product filter uses), plus `UNASSIGNED_PRODUCT` last. Follower options come from `FOLLOWER_BANDS`. Country options come from the distinct non-null `country` values present, labelled via `COUNTRY_LABELS` — a closed set of chips, never a free-text box over the raw location.

Reject unrecognised values rather than sanitising: an unknown `followers` or `product` yields no filter, matching `readQueueFilters`' existing contract.

**Every active filter must count toward `filtered`** when resolving state, and clearing filters must also clear the cursor — paging into page 3 and then narrowing a filter would otherwise land on an empty page 3 of a shorter list.

- [ ] **Step 4: Run tests, then every gate, then commit**

```bash
pnpm --filter console exec vitest run && pnpm --filter console lint && pnpm --filter console exec tsc --noEmit
git add "apps/console/app/(console)/platform/crm/organisations"
git commit -m "feat(crm): add the filter bar to the organisation browse surface"
```

**PR 2 opens here** — `feat(crm): filter organisations by product, country, followers and email`.

---

# GROUP C — Identity (PR 3)

### Task 7: Handle-first identity for solo creators

**Files:**
- Modify: `apps/console/lib/db/crm-repo.ts` (`OrganisationListRow`)
- Modify: `apps/console/app/(console)/platform/crm/organisations/organisations-view.tsx`
- Test: `apps/console/lib/db/crm-repo.integration.test.ts`, `apps/console/app/(console)/platform/crm/organisations/page.test.tsx`

**The problem.** All 259 migrated leads are individual Instagram creators: every one has a handle, only 3 have an email, 208 have no location, and each organisation has exactly one contact who *is* the business. The browse list leads with an organisation name that, for these rows, is a fiction derived from the profile. The schema is right — the organisation/opportunity split is what lets one creator be prospected for Mark8ly and later another product independently — but the rendering should say what the row actually is.

This is the "Person Account" shape every CRM hits. **Do not collapse the tables.** Change only what the row leads with.

**Interfaces:**
- Produces: `OrganisationListRow` gains

```typescript
  /** Primary contact's Instagram handle, for handle-first rendering. */
  contactHandle: string | null;
  /** How many contacts this organisation has. */
  contactCount: number;
  websiteUrl: string | null;
```

- [ ] **Step 1: Write the failing repo test**

```typescript
it("returns the primary contact's handle and the contact count", async () => {
  const page = await listOrganisations({ search: "Glebe Flowers" }, 50);
  expect(page.rows[0].contactHandle).toBe("glebeflowers");
  expect(page.rows[0].contactCount).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Write the failing view test**

```typescript
it("leads with the handle for a single-contact organisation with no website", async () => {
  // 201 of 259 production rows are exactly this shape: a solo creator whose
  // organisation name is derived from their profile.
  listOrganisations.mockResolvedValue({ rows: [soloCreatorRow], total: 1, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({}) }));
  const link = screen.getByRole("link", { name: /@glebeflowers/ });
  expect(link).toBeInTheDocument();
});

it("leads with the organisation name when it is a real business", async () => {
  // A row with a website or several contacts is a business, and its name is
  // the thing an operator recognises. 58 of 259 have a website.
  listOrganisations.mockResolvedValue({ rows: [realBusinessRow], total: 1, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole("link", { name: /Newtown Roasters/ })).toBeInTheDocument();
});

it("still shows the organisation name as secondary when leading with a handle", async () => {
  // Never hide it — the operator may have typed that name into search.
  listOrganisations.mockResolvedValue({ rows: [soloCreatorRow], total: 1, nextCursor: null });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("Glebe Flowers")).toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter console exec vitest run "app/(console)/platform/crm/organisations" lib/db/crm-repo.integration.test.ts`
Expected: FAIL — `contactHandle` is not on the row type.

- [ ] **Step 4: Implement**

Add the three fields to the query, following the existing correlated-subquery pattern for the primary contact (`ORDER BY is_primary DESC, created_at ASC LIMIT 1`) — do not introduce a join, which would fan a multi-contact organisation into several rows.

Extract the decision into a named predicate so the rule is stated once and testable:

```typescript
/**
 * A row is a solo creator when it has exactly one contact and no website. For
 * those, the organisation name is derived from the Instagram profile and the
 * handle is the real identity, so the handle leads. Anything else is a
 * business and leads with its name.
 *
 * `location` is deliberately NOT part of this test, though an earlier draft of
 * this plan included it. Measured against production: 201 of 259 organisations
 * have no website, but only 159 of those also have no location — so requiring
 * `!location` would render 42 solo creators name-first purely because
 * Instagram listed a city on their profile. Location is scraped profile
 * metadata; it is no evidence of being a registered business. A website is.
 *
 * `contactCount === 1` is inert today (every one of the 259 has exactly one
 * contact) and is kept for the case it actually guards: a business with
 * several named contacts is a business regardless of its website.
 */
function leadsWithHandle(row: OrganisationListRow): boolean {
  return row.contactCount === 1 && !row.websiteUrl && Boolean(row.contactHandle);
}
```

Render the handle as `@handle` with the organisation name beneath it as secondary text. Never drop the name — an operator may have searched for it.

- [ ] **Step 5: Run tests, then every gate, then commit**

```bash
pnpm --filter console exec vitest run && pnpm --filter console lint && pnpm --filter console exec tsc --noEmit
git add apps/console/lib/db/crm-repo.ts "apps/console/app/(console)/platform/crm/organisations"
git commit -m "feat(crm): lead with the handle for solo-creator organisations"
```

**PR 3 opens here** — `feat(crm): handle-first identity for solo creators`.

---

## Deliberately out of scope

- **Category as a filter.** 65 empty and 32 literally `"None"` — filtering on scrape noise would dignify it. Cleaning it is separate work.
- **Owner and stage filters on this surface.** Both are single-valued today and both already exist on the queue, which is where working a deal happens. Add them here when browse becomes the place people work from.
- **A `country` picker on the manual-add form.** Manual create derives country from the typed location like every other writer; letting an operator set it directly is a different feature and would need a reconciliation rule when the two disagree.
- **Sorting.** The list is newest-first and nothing has asked for another order.
- **Collapsing organisation and contact for solo creators.** Task 5 changes rendering only; the schema split is what makes multi-product prospecting work.
- **Server-side search across activity text.** Search covers organisation name and contact name/email/handle; activity bodies are a bigger index question.
