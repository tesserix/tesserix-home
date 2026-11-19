# Marketing site on Tesserix CMS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tesserix.app marketing pages read products, team, principles, beliefs and open-source projects from the central Payload CMS (a new `tesserix` tenant), with the current TypeScript data kept as a frozen fallback, and the three places that hand-copy the product list derive it instead.

**Architecture:** tesserix-cms gains a `tesserix` tenant and five collections under an admin group "Tesserix", built with the same `withApproval` / `slugField` / `hiddenUnlessTenant` helpers the hospital collections use, plus a seed that loads today's site content. tesserix-home's web app gains `lib/cms/` (a copy of yes-hospital's `cms.ts` pattern: tenant-filtered anonymous REST reads, 60 s fetch cache tagged `cms` and `cms:<collection>`, 5 s timeout, `CmsError`) whose every getter falls back to the static data on a `CmsError`, and an `/api/revalidate` webhook route. Server components fetch and pass plain props to the existing client components; lucide icons are stored as names and resolved by one `ProductIcon` component.

**Tech Stack:** Payload 3.93 (Postgres, multi-tenant plugin, GCS media), Next 16 app router, React 19, Vitest, pnpm (home) / npm (cms).

**Spec:** the "Design" section below is the spec; there is no separate document (the user skipped brainstorming).

## Design

### What moves to the CMS and what stays

| Content | Today | After |
|---|---|---|
| Products (copy, status, ETA, CTAs, listings, screenshots) | `app/(marketing)/products/[slug]/products-data.ts` | CMS `products`, fallback `lib/cms/fallback/products.ts` |
| Team | `app/(marketing)/about/team.ts` | CMS `team-members`, fallback `lib/cms/fallback/site.ts` |
| Principles | `app/(marketing)/about/principles.ts` | CMS `principles`, same fallback file |
| Beliefs | `components/marketing/beliefs-section.tsx` module const | CMS `beliefs`, same fallback file |
| Open-source repos | `components/marketing/open-source-strip.tsx` module const | CMS `open-source-projects`, same fallback file |
| Pricing page links | `PRICING_LINKS` in `product-content.tsx` | `pricingUrl` field on products |
| Navbar product list, footer product links, contact "Product" dropdown | three hand-written copies | derived from products |

Stays in code this round: hero and section headlines, careers and contact prose, legal pages, JSON-LD builders, OG image rendering, forms, questionnaire routes, the `Industry` label map in about-content.

### Fallback rule

Every getter is `orFallback(read, staticValue)`. A `CmsError` returns the static value. When `CMS_URL` is unset (local dev, Docker build) the fallback is silent; when it is set, the error is logged once per failed read through `lib/logger.ts` at `error` level. Any other error propagates.

### CMS document shapes (Payload REST, `depth=1`, as the site reads them)

All collections carry `tenant`, `_status`, `updatedAt`, `order: number` (lower first; the site sorts by `order`). `Media` populated at depth 1 is `{ id, url, width, height, alt, sizes: { card: { url, width, height }, profile: { url, width, height } } }`. GCS gives absolute URLs; local disk gives a path starting with `/` which the site prefixes with `CMS_URL`.

- `products`: `slug` (from title), `title`, `tagline`, `description`, `longDescription`, `icon` (one of `ICONS`), `status: 'available' | 'coming-soon'`, `industry: 'commerce' | 'food' | 'rentals' | 'healthcare' | 'nutrition' | 'travel'`, `highlights: string[]`, `eta?`, `features: { icon, title, description }[]`, `benefits: string[]`, `website?`, `pricingUrl?`, `ctaLabel?`, `ctaSubtext?`, `trialLine?`, `operatingSystem?`, `listings: { platform: 'ios' | 'android', url: string }[]` (empty `url` = listed but pending), `vendorListingUrl?`, `siteImage?: Media`, `screenshots?: Media[]`, `previousSlugs`.
- `team-members`: `slug` (from name), `name`, `title`, `bio?`, `linkedIn`, `github`, `photo?: Media`.
- `principles`: `title`, `body`.
- `beliefs`: `label` (today's `num`, e.g. "Specialized > generic"), `title`, `body`.
- `open-source-projects`: `name`, `description`. Link is `https://github.com/tesserix/<name>`.

`ICONS` is the list of the 31 lucide names imported at the top of today's `products-data.ts`. It exists verbatim in both repos: `tesserix-cms/src/collections/tesserix/icons.ts` and `tesserix-home/apps/web/components/marketing/icon.tsx`.

### Site types (what components receive)

`Product` is today's product record type with these changes: `slug: string` added; `icon: string` and `features[].icon: string` (names, not components); `pricingUrl?: string` added. `listings`, `vendorListing` and `media` keep today's shapes, derived at mapping time: `artworkSrc` is `/badges/app-store-badge.svg` for ios and `/badges/google-play-badge.png` for android; `orientation` is `"landscape"` when `width > height`. Site captures and screenshots use the original `url`; team photos use `sizes.profile.url ?? url`.

`TeamMember` gains `photo: string` (fallback value `/team/<slug>.jpg`). `Principle` drops `number` (rendered from index). `Belief = { label, title, body }`. `OpenSourceRepo = { name, description }`.

`getProducts()` returns `Record<string, Product>` keyed by slug in `order`; JS keeps insertion order for non-numeric keys, so `Object.keys` is portfolio order and consumers keep indexing by slug.

### Deployment (handoff, Task 8)

The site runs as the `company` chart in namespace `tesserix`; it reads `CMS_URL=http://tesserix-cms.cms.svc.cluster.local` in-cluster and needs an egress rule to namespace `cms`. The tenant's `revalidateUrl` is `https://tesserix.app/api/revalidate`. The webhook secret lives in OpenBao at `tesserix-cms/app/tesserix-cms-tesserix-webhook-secret` and is read by the site as `CMS_WEBHOOK_SECRET`; the CMS reads it from the tenant document (the seed writes `SEED_WEBHOOK_SECRET` into it).

## Global Constraints

- No AI attribution in any commit, PR or comment (user's global rule).
- The user merges PRs and runs cluster operations; the plan hands those over, never runs them.
- CMS: every new collection is listed in `multiTenantPlugin({ collections })` or it is not tenant-scoped; every schema change ships a migration under `src/migrations` (`npm run migrate:check` fails CI otherwise) and regenerated `payload-types.ts`.
- CMS media: jpeg/png/webp, 5 MB max per file.
- Site: client components (`"use client"`) never import `lib/cms/*` readers or `lib/logger.ts`; they receive data as props. Types and `ICONS` may be imported anywhere.
- Site: `CMS_URL`, `CMS_WEBHOOK_SECRET`, `CMS_TIMEOUT_MS` are runtime-only env vars, never `NEXT_PUBLIC_`.
- Visible copy changes are limited to: the navbar product blurb becomes the product's `tagline` (today's separate hand-written blurbs go away).
- Ponytail: shortest complete change; no new abstractions beyond those named here.

## Review Focus

1. CMS reachable but returning a product with `status: 'coming-soon'` and a `siteImage` set: the detail page must not show the image (today's rule: media only for shipped products). Test in Task 2 (`maps a coming-soon product without media even if the CMS carries one`).
2. `CMS_URL` set but the CMS is down on a cold pod: every page renders from the fallback and the error is logged once per collection per request, not once per consumer. Test in Task 2 (`logs once when two consumers read products during one request`).
3. A product published in the CMS that the fallback does not know (new product): waitlist signups for its slug must be accepted and `generateStaticParams` must not 404 it. Test in Task 3 (waitlist route accepts a slug present only in the CMS response).
4. Webhook with an unknown collection, a slug with a `/`, or a wrong-length secret: 400 / 400 / 401 and nothing revalidated. Test in Task 4.
5. Seed re-run after an approver edited a product in the CMS: the edit must survive (no overwrite without `SEED_FORCE`). Test in Task 6.

---

### Task 1: Fallback data, icon map and pure helpers (tesserix-home)

**Files:**
- Create: `apps/web/components/marketing/icon.tsx`
- Create: `apps/web/lib/cms/types.ts`
- Create: `apps/web/lib/cms/fallback/products.ts` (moved from `app/(marketing)/products/[slug]/products-data.ts`)
- Create: `apps/web/lib/cms/fallback/site.ts` (team, principles, beliefs, open-source repos)
- Create: `apps/web/lib/cms/products.ts` (pure helpers only in this task)
- Move test: `app/(marketing)/products/[slug]/products-data.test.ts` → `apps/web/lib/cms/products.test.ts`
- Delete: `products-data.ts`, `about/team.ts`, `about/principles.ts`; the module consts in `beliefs-section.tsx` and `open-source-strip.tsx`.
- Modify: every importer listed by `grep -rn "products-data\|about/team\|about/principles" apps/web/{app,components,lib}` (17 files) so the build is green again. In this task they import the fallback directly (`import { fallbackProducts } from "@/lib/cms/fallback/products"`); Tasks 2–3 switch them to the async getters.

**Interfaces:**
- Produces `lib/cms/types.ts`: `Industry`, `ProductMediaImage`, `ProductFeature = { icon: string; title: string; description: string }`, `Product` (Design §Site types), `TeamMember`, `Principle`, `Belief`, `OpenSourceRepo`.
- Produces `components/marketing/icon.tsx`: `export const ICONS = [...] as const` (31 names, alphabetical), `export type IconName = (typeof ICONS)[number]`, `export function ProductIcon({ name, className }: { name: string; className?: string })` rendering the lucide component for a known name and `Package` for an unknown one.
- Produces `lib/cms/fallback/products.ts`: `export const fallbackProducts: Record<string, Product>` (today's six products, icons as names, `slug` added, `pricingUrl: "https://mark8ly.com/#pricing"` on mark8ly).
- Produces `lib/cms/fallback/site.ts`: `fallbackTeam: TeamMember[]` (photo `/team/<slug>.jpg`), `fallbackPrinciples: Principle[]`, `fallbackBeliefs: Belief[]`, `fallbackOpenSource: OpenSourceRepo[]`.
- Produces `lib/cms/products.ts` pure helpers, each taking `products: Record<string, Product>` as first argument: `isComingSoon(products, slug)`, `launchedProductSlugs(products)`, `productTitle(products, slug)`, `industryNames(products)`, `industryListPlain(products)`, `industryListExcluding(products, exclude)`, `upcomingIndustryList(products)`, and `countWord(n)` unchanged.

- [ ] **Step 1: Move the test and make it fail**

Move `products-data.test.ts` to `lib/cms/products.test.ts`, rewrite imports to `@/lib/cms/products` and `@/lib/cms/fallback/products`, pass `fallbackProducts` into the helpers, and add:

```ts
it("uses only icon names ProductIcon knows", () => {
  const names = Object.values(fallbackProducts).flatMap((p) => [p.icon, ...p.features.map((f) => f.icon)]);
  for (const n of names) expect(ICONS).toContain(n);
});
it("keeps portfolio order as the key order", () => {
  expect(Object.keys(fallbackProducts)).toEqual(["mark8ly", "fe3dr", "helivanta", "roamie", "dwellm8", "kora"]);
});
```

Run: `cd apps/web && pnpm vitest run lib/cms/products.test.ts` — expected FAIL (modules missing).

- [ ] **Step 2: Create `types.ts`, `icon.tsx`, `fallback/products.ts`, `fallback/site.ts`, `products.ts`**

Copy content verbatim; only the icon fields change from components to their lucide export names.

- [ ] **Step 3: Repoint the 17 importers to the fallback modules and the new helper signatures**

`navbar.tsx` drops its hand-written product list and maps `Object.values(fallbackProducts)` to `{ slug, name: title, description: tagline, icon, comingSoon }`, rendering with `ProductIcon`. `footer.tsx` maps the same source for its product links. `contact/page.tsx` renders its `SelectItem`s from `Object.values(fallbackProducts)` followed by the existing "Other" item. `product-content.tsx` reads `product.pricingUrl` and the `PRICING_LINKS` map is deleted. `beliefs-section.tsx` and `open-source-strip.tsx` import from `fallback/site.ts`. `team-member-card.tsx` uses `member.photo`.

- [ ] **Step 4: Verify**

Run: `cd apps/web && pnpm vitest run && pnpm typecheck && pnpm lint` — expected all PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor(web): marketing data behind lib/cms with icon names and derived product lists"
```

---

### Task 2: CMS client and product reads with fallback (tesserix-home)

**Files:**
- Create: `apps/web/lib/cms/client.ts`
- Modify: `apps/web/lib/cms/products.ts` (add async getters)
- Create: `apps/web/lib/cms/site.ts`
- Create: `apps/web/lib/cms/__fixtures__/products.json`, `team-members.json`, `principles.json`, `beliefs.json`, `open-source-projects.json` (hand-written in the Design §CMS shapes, one or two docs each; the products fixture carries mark8ly with a `siteImage` and roamie with three `screenshots`, plus a coming-soon doc that wrongly carries a `siteImage`)
- Test: `apps/web/lib/cms/cms.test.ts`

**Interfaces:**
- Consumes Task 1 types and fallbacks.
- Produces `client.ts`: `class CmsError extends Error`, `TENANT = "tesserix"`, `find(collection: string): Promise<unknown[]>` wrapped in React `cache()` fetching `${CMS_URL}/api/${collection}?where[tenant.slug][equals]=tesserix&depth=1&limit=0&sort=order` with `next: { revalidate: 60, tags: ["cms", \`cms:${collection}\`] }` and `AbortSignal.timeout(Number(process.env.CMS_TIMEOUT_MS) || 5000)`; `mediaUrl(m: Media | number | null | undefined, size?: "card" | "profile"): string | undefined`; `orFallback<T>(read: Promise<T>, fallback: T, collection: string): Promise<T>` implementing Design §Fallback rule (the "once per request" log goes through a `cache()`d marker keyed by collection).
- Produces `products.ts`: `getProducts(): Promise<Record<string, Product>>`, `getProduct(slug: string): Promise<Product | undefined>`.
- Produces `site.ts`: `getTeam(): Promise<TeamMember[]>`, `getPrinciples(): Promise<Principle[]>`, `getBeliefs(): Promise<Belief[]>`, `getOpenSource(): Promise<OpenSourceRepo[]>`.

- [ ] **Step 1: Write the failing tests** (fetch mocked as in yes-hospital's `cms.test.ts`: `vi.stubGlobal("fetch", …)` serving the fixtures by collection name; `vi.stubEnv("CMS_URL", "http://cms.test")`)

```ts
it("maps the mark8ly doc to today's Product shape", async () => {
  const p = (await getProducts()).mark8ly;
  expect(p.media?.site).toEqual({ src: "https://storage.googleapis.com/b/tesserix/mark8ly-storefront.jpg", alt: "…", width: 1568, height: 682, orientation: "landscape" });
  expect(p.listings).toEqual({ ios: { url: "", artworkSrc: "/badges/app-store-badge.svg" }, android: { url: "https://play.google.com/store/apps/details?id=com.mark8ly.admin", artworkSrc: "/badges/google-play-badge.png" } });
  expect(p.pricingUrl).toBe("https://mark8ly.com/#pricing");
});
it("keys products by slug in `order`", …)   // Object.keys equals the fixture's order
it("maps a coming-soon product without media even if the CMS carries one", …)   // media undefined
it("prefixes CMS_URL onto relative media paths", …)
it("falls back to the static products on HTTP 500 and logs once", …)   // logger.error called once after two getProducts() calls
it("falls back silently when CMS_URL is unset", …)   // logger.error not called
it("rethrows errors that are not CmsError", …)   // fixture product with `features: null` makes the mapper throw a TypeError; getProducts() rejects with it
it("maps team photos to the profile size and falls back to /team/<slug>.jpg", …)
it("maps beliefs, principles and open-source projects in order", …)
```

- [ ] **Step 2: Run** `pnpm vitest run lib/cms/cms.test.ts` — expected FAIL.
- [ ] **Step 3: Implement `client.ts`, the getters in `products.ts`, and `site.ts`** per Interfaces. `getProduct` is `(await getProducts())[slug]`.
- [ ] **Step 4: Run** the file again — expected PASS. Then `pnpm vitest run && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(web): read marketing content from Tesserix CMS with static fallback`

---

### Task 3: Server pages fetch, client components take props (tesserix-home)

**Files (modify):**
- `apps/web/app/layout.tsx`: `metadata` → `export async function generateMetadata()` using `industryListPlain(await getProducts())`; `organizationSchema` built inside the component from `await getTeam()`.
- `apps/web/app/(marketing)/layout.tsx`: becomes async; passes `products` to `<Navbar>` and `<Footer>` (`NavProduct[] = { slug, name, description, icon, comingSoon }[]` and `{ slug, title }[]` + `industries: string`).
- `apps/web/components/common/navbar.tsx`, `footer.tsx`: accept those props; no data imports.
- `apps/web/app/(marketing)/page.tsx`: fetches products, beliefs, open-source and passes `products` to `ProductsGrid`, `beliefs` to `BeliefsSection`, `repos` to `OpenSourceStrip`, industry strings to `AboutTeaser` and `Hero` if they call helpers (hero does: `industryListPlain`).
- `apps/web/app/(marketing)/products/page.tsx`: split into a server `page.tsx` (fetch, build `ProductEntry[]` and `portfolioSize`) and client `products-index.tsx` (today's JSX).
- `apps/web/app/(marketing)/products/[slug]/page.tsx`, `opengraph-image.tsx`, `app/opengraph-image.tsx`, `app/sitemap.ts`, `app/llms.txt/route.ts`: `await getProducts()`.
- `apps/web/app/(marketing)/products/[slug]/product-content.tsx`: prop becomes `{ product: Product }`; `notFound()` moves to `page.tsx` only.
- `apps/web/app/(marketing)/about/page.tsx` + `about-content.tsx`: page fetches `team`, `principles`, `products`; content takes them as props.
- `apps/web/app/(marketing)/careers/page.tsx` + `careers-content.tsx`: `principles` prop.
- `apps/web/app/(marketing)/contact/page.tsx`: split into server `page.tsx` (fetch products) and client `contact-form.tsx` with a `products: { slug: string; title: string }[]` prop.
- `apps/web/app/api/waitlist/route.ts`: validate against `Object.keys(await getProducts())`.
- `apps/web/lib/waitlist/announce.ts`: `const products = await getProducts()` once at the top of `announcePendingLaunches`, pass to `launchedProductSlugs` and `productTitle`.
- Test (create, neither exists today): `apps/web/app/api/waitlist/route.test.ts` with `@/lib/db/product-waitlist` and `@/lib/cms/products` mocked via `vi.mock`. `announce.ts` gets no new test; its only change is where the slug list comes from.

**Interfaces:** consumes Task 2 getters and Task 1 helpers; produces no new modules.

- [ ] **Step 1: Write the failing test for Review Focus 3**

In the waitlist route test, mock `@/lib/cms/products` so `getProducts` resolves to `{ ...fallbackProducts, newthing: { ...fallbackProducts.kora, slug: "newthing" } }` and assert a POST with `productSlug: "newthing"` returns 200.

- [ ] **Step 2: Run** it — expected FAIL (slug rejected).
- [ ] **Step 3: Convert the files above.** Rule of thumb: a `"use client"` file keeps its JSX and loses its data import; its nearest server ancestor awaits the getter and passes the value down.
- [ ] **Step 4: Verify** `pnpm vitest run && pnpm typecheck && pnpm lint`, then `pnpm build` (no `CMS_URL`: whole site renders from fallback), then `pnpm dev` and open `/`, `/products`, `/products/mark8ly`, `/about`, `/careers`, `/contact` — identical to before apart from the navbar blurbs.
- [ ] **Step 5: Run** `pnpm test:e2e tests/homepage.spec.ts` — expected PASS.
- [ ] **Step 6: Commit** `feat(web): marketing pages fetch content server-side and pass it to client components`

---

### Task 4: Revalidate webhook (tesserix-home)

**Files:**
- Create: `apps/web/app/api/revalidate/route.ts` (copy of yes-hospital's, without `clearSlugCache`)
- Test: `apps/web/app/api/revalidate/route.test.ts` (copy of yes-hospital's `revalidate.test.ts`, collections renamed)

**Interfaces:** `pages = { products: "/products/", "team-members": null, principles: null, beliefs: null, "open-source-projects": null }`; header `x-cms-secret` compared constant-time against `CMS_WEBHOOK_SECRET`; body `{ collection, slug?, previousSlug? }`; on success `revalidateTag` for `cms:<collection>` and `cms` with `{ expire: 0 }`, and `revalidatePath` for each slug under the prefix.

- [ ] **Step 1: Write the tests**: 401 without/with wrong secret (including a longer one), 400 for unknown collection and for slug `a/b`, 200 revalidating `["cms:products", "cms"]` and `/products/roamie` plus `/products/old-roamie` when `previousSlug` is sent, and no secret configured → 401.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): CMS publish webhook revalidates marketing pages`

---

### Task 5: Tesserix collections (tesserix-cms)

**Files:**
- Create: `src/collections/tesserix/admin.ts` (`tesserixAdmin = { group: 'Tesserix', hidden: hiddenUnlessTenant('tesserix') }`), `icons.ts` (`ICONS`, identical to the site's list), `Products.ts`, `TeamMembers.ts`, `Principles.ts`, `Beliefs.ts`, `OpenSourceProjects.ts`
- Modify: `src/payload.config.ts` (import, `collections`, `multiTenantPlugin.collections` adds `products: {}`, `'team-members': {}`, `principles: {}`, `beliefs: {}`, `'open-source-projects': {}`)
- Create: `src/migrations/<timestamp>_tesserix_collections.{ts,json}`, update `src/migrations/index.ts`; regenerate `payload-types.ts`
- Test: `test/tesserix-model.test.ts`

**Interfaces:** field names and types exactly as Design §CMS document shapes. `Products` uses `withApproval`, `slugField('title')`, `indexes: [{ fields: ['tenant', 'slug'], unique: true }]`, `admin: { ...tesserixAdmin, useAsTitle: 'title', defaultColumns: ['title', 'status', 'order'] }`; `icon` and `features[].icon` are `select` over `ICONS`; `status` and `industry` are `select`s with the Design values; `listings` is an `array` with `platform` select and `url` text (not required); `siteImage` is `upload` → `media`; `screenshots` is `upload` → `media` with `hasMany: true`; `order` is `number`, required, `admin.position: 'sidebar'`. `TeamMembers` uses `slugField('name')`, `photo` upload. The other three are `withApproval` with their text/textarea fields and `order`.

- [ ] **Step 1: Start the test database** if `pg_isready -h localhost -p 54329` says no: `docker run -d --name cms-pg -e POSTGRES_USER=cms -e POSTGRES_PASSWORD=cms -e POSTGRES_DB=cms_test -p 54329:5432 postgres:16`, then `docker exec cms-pg createdb -U cms cms`.
- [ ] **Step 2: Write the failing test**

```ts
// test/tesserix-model.test.ts — same beforeEach shape as hospital-model.test.ts with tenant slug 'tesserix'
test('an editor saves a product as a draft; the approver publishes; anonymous sees it sorted by order with siteImage populated', …)
test('products of another tenant are not returned by the tesserix site query', …)
test('a product icon outside ICONS fails validation', …)
test('the Tesserix group is hidden from a yes-hospital-only user and shown to a tesserix user', () => { expect(hiddenUnlessTenant('tesserix')({ user: yhUser })).toBe(true); … })
```

- [ ] **Step 3: Run** `npm test -- test/tesserix-model.test.ts` — FAIL (unknown collection).
- [ ] **Step 4: Implement the collections and register them.**
- [ ] **Step 5: Create the migration**: `npx payload migrate` against `DATABASE_URL_TEST` to bring it current, then `npm run migrate:create tesserix_collections`, then `npm run generate:types`. Confirm `npm run migrate:check` passes.
- [ ] **Step 6: Run** `npm test` — all PASS (the whole suite, because `globalSetup` rebuilds from migrations).
- [ ] **Step 7: Commit** `feat: Tesserix tenant collections (products, team, principles, beliefs, open source)`

---

### Task 6: Seed from today's site content (tesserix-cms)

**Files:**
- Create: `seed/tesserix/data.ts` (the fallback data from tesserix-home Task 1, copied; media referenced by file name), `seed/tesserix/media/` (copies of `apps/web/public/screens/*` and `public/team/*`; every file < 5 MB, the largest is 993 KB), `seed/tesserix/seed.ts`, `scripts/seed-tesserix.ts`
- Modify: `package.json` scripts add `"seed:tesserix": "payload run scripts/seed-tesserix.ts"`
- Test: `test/tesserix-seed.test.ts`

**Interfaces:** `seedTesserix(payload: Payload): Promise<{ tenant: number; skipped: boolean }>` with the same contract as `seedYesHospital` (first-run bootstrap; resume when partial; `SEED_FORCE=true` overwrites; `overrideAccess`, `context.skipNotifications`; tenant `{ name: 'Tesserix', slug: 'tesserix', siteUrl: 'https://tesserix.app' }` plus `SEED_REVALIDATE_URL` / `SEED_WEBHOOK_SECRET`). Media matched by `alt`; docs matched by slug (products, team) or by `title`/`name` (the rest). "Finished" marker: the tenant exists and `open-source-projects` count ≥ `data.openSource.length` (the seed's last write).

- [ ] **Step 1: Write the failing test** (mirror `seed.test.ts`): counts after a run equal `data.*` lengths (6 products, 2 team, 4 principles, 3 beliefs, 4 repos, 11 media); a second run is `skipped: true`; an approver's edit to mark8ly's tagline survives a second run (Review Focus 5); the anonymous site query `/products?where[tenant.slug][equals]=tesserix&depth=1&limit=0&sort=order` returns 200 with 6 docs, mark8ly's `siteImage.url` ending in `.jpg` and roamie's `screenshots` length 3.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat: seed the Tesserix tenant from the marketing site's current content`

---

### Task 7: Editor guide and site docs

**Files:**
- Modify: `tesserix-cms/docs/cms-editor-guide.md` — a short "Tesserix website" section: which collections, that `order` controls position, that a product's `status` flip is what launches it (and triggers the waitlist announcement in tesserix-home).
- Create: `tesserix-home/docs/cms.md` — how the site reads the CMS, the env vars, the fallback rule, the webhook, and the Task 8 handoff list.

- [ ] **Step 1: Write both.** **Step 2: Commit** in each repo: `docs: Tesserix website content in the CMS`.

---

### Task 8: Cluster handoff (user runs; the local tesserix-k8s checkout is on an October branch, so write this against the paths in yes-hospital's `docs/cms-handover.md`)

Produce the list below in `tesserix-home/docs/cms.md` and in the final message. Nothing here is executed by the implementer.

1. OpenBao: create `tesserix-cms/app/tesserix-cms-tesserix-webhook-secret` (random hex is fine here).
2. tesserix-k8s PR: `charts/apps/company` ExternalSecret adds `CMS_WEBHOOK_SECRET` from that path; values add `env.CMS_URL: http://tesserix-cms.cms.svc.cluster.local`; `allow-company-egress` adds a `to` rule for `kubernetes.io/metadata.name: cms` on the CMS service port. Add the `cms` namespace to the CMS chart's ingress allow-list if it has one (yes-hospital's entry is the model).
3. tesserix-k8s PR: tesserix-cms chart gains `jobs.seedTesserix` mirroring `seedYesHospital`, with env `SEED_REVALIDATE_URL=https://tesserix.app/api/revalidate` and `SEED_WEBHOOK_SECRET` from the same OpenBao path; enable in one PR, disable in a follow-up after the Job completes.
4. Build and pin the new tesserix-cms image (CI billing caveat in the handover doc), then the tesserix-home image.
5. Verify: `/api/revalidate` without the secret → 401; edit a product tagline in the admin, publish, see it on tesserix.app within a minute; revert.
6. Create the first Tesserix approver account (the owner is already super-admin).
