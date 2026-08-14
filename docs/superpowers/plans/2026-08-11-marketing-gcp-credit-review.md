# Plan: Marketing site update for Google for Startups Cloud credit review

## Context

Tesserix has applied for Google for Startups Cloud Program credits. Google's review
requires a credible public website with an about/team page, real company identity,
and accurate product information. A review of `apps/web` found broken legal links,
no team or entity details, and several factual contradictions between the site and
the live products.

This plan covers the tracks agreed with the user. **Phase 2 (team bios) is
deliberately out of scope** — bio/photo content has not been supplied yet. The
company addresses HAVE been supplied and ARE in scope.

## Verified facts (use these verbatim — do not invent alternatives)

### Legal entities
- **Tesserix Pty Ltd** — ACN 694 070 865, ABN 59 694 070 865, registered in
  New South Wales, Australia. Registered address:
  `5 Tagu Place, Kings Park NSW 2148, Australia`
- **Zivana Innovations LLP** — Indian operating entity for Fe3dr. Address:
  `Flat No-103, Block-C, Northern Heights Apartment, Kalarahanga Road, Kalarahanga, Bhubaneswar, Odisha 751024, India`
- Relationship, per fe3dr.com: "Powered by Zivana Innovations LLP, part of
  Tesserix Pty Ltd".

### Live Android apps (verified against Play Store listing names)
| Package ID | Listing name | Product |
|---|---|---|
| `com.tesserix.homechef.customer` | Fe3dr: Homemade Food | Fe3dr |
| `com.tesserix.homechef.vendor` | Fe3dr Vendor: Sell Food | Fe3dr |
| `com.mark8ly.admin` | Mark8ly Admin | Mark8ly |

iOS apps are under App Store review — **no iOS URLs exist yet**.

URL form: `https://play.google.com/store/apps/details?id=<PACKAGE_ID>`

### Mark8ly pricing (from mark8ly.com, annual-billed, **AUD**)
- Starter **A$23/mo** (A$278/yr) — up to 2 stores
- Studio **A$60/mo** (A$719/yr) — up to 5 stores
- Pro **A$149/mo** (A$1,788/yr) — up to 10 stores
- 90 days free, no card. Monthly billing "from $29 a month".
- "Prices shown in AUD. Plus 10% GST for Australian businesses."
- 0% transaction fees from Mark8ly. Pro has an optional white-label mobile app
  add-on at $199/mo + $2,000 one-time setup (billed USD).

### Fe3dr positioning (from fe3dr.com)
- Tagline: "Real home-cooked food from kitchens near you" / "Ghar ka khana, delivered."
- Verified home cooks, cooked-to-order, collect or delivery. Currently **Pune only**
  ("1 City to start — Pune").
- Consumer marketplace — it has **no published SaaS pricing tiers**.
- Support email: `support@fe3dr.com`

### Product truth table (target state)
| Slug | Title | Status | Notes |
|---|---|---|---|
| `mark8ly` | Mark8ly | available | mark8ly.com |
| `fe3dr` | Fe3dr | available | fe3dr.com, was `homechef` |
| `dwellm8` | Dwellm8 | **coming-soon** | dwellm8.com — revised down in Task 7 |
| `medicare` | MediCare | coming-soon | |
| `kora` | Kora | coming-soon | added in Task 7, no public site yet |
| `fanzone` | — | **REMOVED** | discontinued |

Live products are therefore **Mark8ly and Fe3dr only** (2).

## Global Constraints

1. **Rename scope is the marketing surface ONLY.** Change `homechef` → `fe3dr`
   in `app/(marketing)/**`, `components/marketing/**`, `components/common/**`.
   **Do NOT touch** `app/admin/**`, `components/admin/**`, `app/api/**`,
   `lib/**`, or the `@tesserix/homechef-shared` package. Android package IDs
   legitimately remain `com.tesserix.homechef.*` — do not "fix" them.
2. **Never invent facts.** Company details, prices, URLs and statuses come from
   the verified-facts section above. If something is not listed there, omit it
   rather than guessing. This is for a due-diligence review — a fabricated
   detail is worse than an absent one.
3. **Do not import Mark8ly's design tokens.** The paper/ink/moss system in
   CLAUDE.md is Mark8ly's. tesserix.app has its own language: mono uppercase
   eyebrow labels with `tracking-[0.2em]`, hairline `border-t` section rules,
   `text-muted-foreground` secondary text, per-product accent classes
   (`text-chart-5`, `text-warning`, `text-primary`, `text-info`). Match what is
   already there.
4. **`products-data.ts` is the single source of launch truth.** Its existing
   doc comment says so. Any surface that restates status, product lists or
   counts must derive from it, not duplicate it.
5. Use `@tesserix/web` primitives (`Button`, `AnimateOnScroll`, `Section`, …)
   rather than hand-rolling equivalents.
6. Accessibility: WCAG 2.1 AA. Semantic headings, visible focus rings,
   `prefers-reduced-motion` honoured (the codebase uses `useReducedMotion`).
7. Every task ends green on `pnpm --filter web typecheck` and
   `pnpm --filter web lint`.

---

## Task 1 — Legal pages (`/privacy`, `/terms`, `/cookies`)

**Why:** `components/common/footer.tsx:24-26` links to all three; none exist.
A reviewer clicking "Privacy Policy" currently gets a 404.

**Create:**
- `app/(marketing)/legal/legal-page.tsx` — shared presentational component:
  page title, "Last updated" date, prose styling, consistent with the marketing
  language (mono eyebrow, hairline rules, `max-w-3xl` measure).
- `app/(marketing)/privacy/page.tsx`
- `app/(marketing)/terms/page.tsx`
- `app/(marketing)/cookies/page.tsx`

Each page exports `metadata` (title + description) like the other marketing pages.

**Privacy Policy** — follow the section structure Fe3dr's own policy uses, since
it already satisfies both Australian Privacy Principles and India's DPDP Act:
1. Who we are — name Tesserix Pty Ltd, ACN/ABN, NSW registered address; note
   Zivana Innovations LLP as the Indian operating entity with its address.
2. What we collect — account details, usage/analytics, support correspondence,
   billing details (note payment card data is handled by the processor, never
   stored by Tesserix).
3. Why we collect it — provide the service, billing, support, security,
   product improvement. No sale of personal data.
4. Who we share it with — name the real subprocessors: Google Cloud Platform
   (hosting, Cloud SQL, Cloud Storage, Secret Manager), Cloudflare (DNS, CDN,
   DDoS), Stripe and Cashfree Payments (payments), SendGrid (transactional
   email), and product analytics providers.
5. Where it is stored — GCP `asia-south1`, with cross-border transfer note.
6. How long we keep it — retention plus deletion-on-request.
7. Your rights — access, correction, deletion, export, complaint. Mention
   GDPR/APP/DPDP rights generically.
8. Security — encryption in transit and at rest, least-privilege access.
9. Children — service not directed at under-18s.
10. Grievance Officer — required by DPDP; give the contact email.
11. Changes and contact.

**Terms of Service** — parties and entity, acceptance, description of service,
accounts and eligibility, acceptable use, fees/billing/refunds/taxes (note AUD
+ 10% GST for Australian businesses), intellectual property, customer data
ownership and export, third-party services, warranty disclaimer, limitation of
liability, indemnity, suspension and termination, changes to terms, governing
law (New South Wales, Australia), contact.

**Cookie Policy** — what cookies are, the categories actually used (strictly
necessary/session, preference, analytics), that auth uses encrypted session
cookies, how to control them in-browser, and a change/contact section.

**Constraints:**
- Set a single shared `LAST_UPDATED` date constant; do not use `new Date()`
  (it would render a misleading always-today date and break static output).
- Add a visible note that these are general terms and that specific products
  (Mark8ly, Fe3dr) may have their own policies, linking out to fe3dr.com's.
- Plain, readable English matching the site's voice. No lorem, no
  `[COMPANY NAME]` placeholders.

**Verify:** all three routes render; footer links resolve; typecheck + lint pass.

---

## Task 2 — Careers page (`/careers`)

**Why:** `footer.tsx:17` links to `/careers`; it 404s.

**Create** `app/(marketing)/careers/page.tsx`.

No roles have been supplied, so build an honest "no open roles right now" page:
what Tesserix is, how the team works (reuse the four principles already in
`about-content.tsx` — import or extract them rather than copy-pasting the
strings), what they look for, and an invitation to write in with the contact
email. Include `metadata`.

Do **not** invent job listings, headcount, salary bands or benefits.

**Verify:** route renders; footer link resolves; typecheck + lint pass.

---

## Task 3 — Fe3dr rename, FanZone removal, and factual corrections

**Why:** the site currently contradicts itself and the live products in five
separate places.

### 3a. `app/(marketing)/products/[slug]/products-data.ts`
- Rename the `homechef` key to `fe3dr`; `title: "Fe3dr"`.
- `tagline`: "Ghar ka khana, delivered."
- Rewrite `description`/`longDescription` around fe3dr.com's real positioning:
  verified home cooks, cooked-to-order meals, collection or delivery, currently
  live in Pune. Keep it factual.
- Add `website: "https://fe3dr.com"`.
- Keep `status: "available"`.
- **Delete the entire `fanzone` entry** (discontinued).
- **Remove `pricing` from EVERY product and drop the field from the type.**
  Decision from the user: Mark8ly's pricing is location-based, so no single
  static figure on tesserix.app can be correct for a given visitor, and the
  duplicated numbers have already drifted (site claimed `$19/$49/$119` USD
  against a real `A$23/A$60/A$149` AUD). Fe3dr's tiers were invented outright.
  Pricing lives on each product's own site, which is the only place it can
  stay accurate.
  - Remove the `pricing` field from the product type and every entry.
  - Remove the pricing UI from `app/(marketing)/products/[slug]/` that renders it.
  - Replace it with a link out to the product's own pricing page — for Mark8ly,
    `https://mark8ly.com/#pricing`. Where a product has no public pricing page
    (Fe3dr, MediCare), render nothing.
  - Remove the "90 days free, then from $19/mo" highlight from the Mark8ly card
    in `products-grid.tsx`; "0% transaction fees" is verified and may stay.

### 3b. `components/marketing/products-grid.tsx`
- Update the Fe3dr card: slug, title, `website: "fe3dr.com"`, tagline and
  description matching 3a.
- Change the highlights to real ones (verified home cooks, cooked to order,
  collection or delivery, live in Pune) — not the current generic SaaS bullets.
- Remove the `fanzone` card.
- Fix the Mark8ly highlight "90 days free, then from $19/mo" → the verified
  AUD figure.

### 3c. `app/(marketing)/about/about-content.tsx`
- In `focus`: `HomeChef` → `Fe3dr`, and status `In development` → **`Live`**
  (it contradicts `products-data.ts` today).
- Remove the FanZone row.
- Add the Dwellm8 row — it is live and absent from this list entirely.

### 3d. `components/common/footer.tsx`
- `HomeChef` → `Fe3dr`, href → `/products/fe3dr`.
- Remove the FanZone entry; add Dwellm8.

### 3e. `components/marketing/hero.tsx`
- `stats` and `marqueeItems` are hardcoded and now wrong: it claims
  **"02 Live in production"** when three products are live, and the marquee
  still lists "FanZone Battle Ground" and "HomeChef".
- Derive both from `products-data.ts` (per Global Constraint 4) so they cannot
  drift again. Keep the zero-padded `NN` display format.

### 3f. `next.config.ts`
- Add a `redirects()` entry: `/products/homechef` → `/products/fe3dr`,
  permanent. Add `/products/fanzone` → `/products`, permanent.
- The file has no `redirects()` today — add it without disturbing existing config.

### 3g. `app/sitemap.ts`
- Currently lists only `mark8ly` and `dwellm8`. Generate product entries from
  `getAllProductSlugs()` (or equivalent existing export) rather than hand-listing,
  so removed products drop out and new ones appear automatically.

**Verify:** `grep -ri "homechef\|fanzone" app/\(marketing\) components/marketing components/common`
returns nothing. `grep -r "homechef" app/admin lib app/api` still returns the
original matches (proving scope was respected). Typecheck + lint pass.

---

## Task 4 — App store badges

**Why:** three Android apps are live and the site links to none of them.
`@tesserix/web@1.8.1` (already installed) exports `AppStoreBadges` for exactly this.

### 4a. Artwork
Download the official assets into `apps/web/public/badges/`:
- Google: `https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png`
  → `google-play-badge.png` (646×250)
- Apple: `https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/en-us`
  → `app-store-badge.svg` (119.66×40)

Both verified reachable and matching the component's `OFFICIAL_BADGE_METRICS`.
Do not redraw, recolour, crop or reproportion either asset.

### 4b. Data
Extend the product type in `products-data.ts` with an optional field:

```ts
listings?: Partial<Record<"ios" | "android", { url: string; artworkSrc: string }>>
```

Populate:
- `fe3dr` — android `com.tesserix.homechef.customer` (the customer app).
  Include an ios entry with `url: ""`.
- `mark8ly` — android `com.mark8ly.admin`. Include an ios entry with `url: ""`.

The Fe3dr **vendor** app (`com.tesserix.homechef.vendor`) is a second audience;
surface it on the Fe3dr product page alongside the customer app with a clear
label ("For diners" / "For home cooks"), not in the footer.

### 4c. Rendering
Render `AppStoreBadges` with `placeholder="coming-soon"` (so the pending iOS
listing shows the inert plate rather than a dead "Download on the App Store"
link) at:
- the Fe3dr and Mark8ly product detail page heroes,
- the corresponding homepage product cards in `products-grid.tsx`,
- a badge row in `footer.tsx`.

Pass a real `appName` for correct alt text. Use `compact` only in the footer if
space genuinely demands it.

**Constraints:**
- Apple's badge must come first where both appear — the component already
  enforces this; do not fight it.
- Do not commit the badge artwork to `@tesserix/web`; it is self-hosted here by
  design, as the component's doc comment explains.

**Verify:** badges render at ≥40px ink height; iOS shows the coming-soon plate;
Android links open the correct listings; typecheck + lint pass.

---

## Task 5 — Design pass

**Why:** the user asked for UI improvements informed by Apple's design approach.

**First, invoke the `apple-design` skill** and apply its guidance. Then review
the marketing surface — `hero.tsx`, `products-grid.tsx`, `about-content.tsx`,
`contact/page.tsx`, the new legal and careers pages — and improve it.

**Scope this pass to refinement, not redesign.** The site's editorial direction
is established and good; the goal is polish. Priorities:
- Typographic rhythm and hierarchy: heading scale consistency across the new
  pages and the existing ones, measure (line length) on long-form legal text,
  consistent eyebrow-label treatment.
- Spacing rhythm: section padding is currently `py-16 sm:py-24` in most places —
  confirm it is consistent and that the new pages match.
- Motion: the codebase uses Framer Motion with an Apple-style ease
  (`[0.22, 1, 0.36, 1]`). Ensure new content animates consistently and that
  `useReducedMotion` is honoured everywhere. Do not add motion for its own sake.
- The legal and careers pages must not read as bolted-on — they should look
  like the same site.

**Constraints:**
- Do NOT restructure information architecture or rewrite copy that Tasks 1-4
  established as factually correct.
- Do NOT introduce a new colour, radius, shadow or font. Use existing tokens.
- No glassmorphism, no hover-lift bounce, no decorative gradients.
- Report anything you judge a genuine improvement but out of scope, rather
  than doing it.

**Verify:** typecheck, lint, and `pnpm --filter web build` all pass. Marketing
routes render correctly at 375px, 768px and 1440px.

---

## Task 6 — Team section on `/about`

**Why:** Google's review explicitly looks for "about us / team". `/about` today
has no humans on it at all — no names, no roles, no links. This is the single
most-cited gap for the credit application.

**Edit** `app/(marketing)/about/about-content.tsx` — add a "Who we are" section.
Place it after "Why we exist" and before "How we work", so the reader meets the
people before the operating principles.

**Team data (verbatim — do not embellish):**

| Name | Title | LinkedIn | GitHub |
|---|---|---|---|
| Mahesh Sangawar | Co-founder | `https://www.linkedin.com/in/mahesh-sangawar-985a3214/` | `https://github.com/mahesh-sangawar` |
| Samyak R | Co-founder | `https://www.linkedin.com/in/samyak-r-96551a21/` | `https://github.com/sam123ben` |

- Both carry the title **"Co-founder"**. No CEO/CTO split — do not invent one.
- Extract the team array to its own module (as Task 2 did for `principles`)
  rather than inlining it, so it is editable without touching layout.

**Bios:** attempt to fetch each public LinkedIn and GitHub profile and draft a
ONE-LINE bio per person from what is actually published there. LinkedIn commonly
blocks automated fetches — if a profile cannot be read, **write no bio for that
person** and note it in your report so the user can supply one. Never infer a
career history, employer, university or specialism that you did not read.

**Photos:** the user will supply images later. Build the layout with an image
slot per person pointing at `/team/<slug>.jpg` under `apps/web/public/team/`.
Handle the missing-image case gracefully **now** — a monogram/initials fallback
in the same square, not a broken image icon or a layout that collapses. The
page must look finished before any photo exists.

**Constraints:**
- Match the existing marketing language (Global Constraint 3). Links get the
  same treatment as other inline links; add `rel="noopener noreferrer"` and
  `target="_blank"` on the external profile links, with accessible labels
  (e.g. "Mahesh Sangawar on LinkedIn") — icon-only links need names.
- Two people should not render as a lonely two-column grid on desktop; use a
  layout that reads deliberately at this size.
- Also add the registered company identity to the page or footer per Task 1's
  verified facts if it is not already surfaced outside the legal pages.

**Verify:** `/about` renders with both people, working profile links, and the
initials fallback visible where photos are absent; typecheck + lint pass.

---

## Task 7 — Revised launch state: Dwellm8 down, Kora in, `/launch` retired

**Why:** three corrections from the user after Task 3 landed.

### 7a. Dwellm8 → `coming-soon`
Change its `status` in `products-data.ts` from `available` to `coming-soon`.
Everything downstream derives from that field (Task 3 made hero stats, the
marquee, the sitemap and `isComingSoon` all read from it), so verify the
change propagates and **do not** hand-edit any of those surfaces. In
`about-content.tsx` the `focus` list shows a literal status string — that one
must be updated to match ("In development").

After this change the live products are **Mark8ly and Fe3dr only**. The hero's
"Live in production" stat must compute to `02`.

### 7b. Add Kora as `coming-soon`
New entry in `products-data.ts`, and a card in `products-grid.tsx`.

Verified facts, from `../kora/docs/PRODUCT_SPEC.md` (a sibling repo — read it,
do not guess):
- **Kora** — AI-powered nutrition tracking for iOS and Android.
- Explicitly *not* another calorie tracker; the goal is the easiest nutrition
  tracking experience ever built, and it should feel conversational rather
  than like data entry.
- Logging methods: food photos, natural-language chat, voice, barcode
  scanning, manual editing.
- Nutrition data comes from USDA / OpenFoodFacts / Australian food databases —
  the spec is emphatic that it must never hallucinate nutrition values.

Constraints:
- `status: "coming-soon"`. **No `website` field** — there is no public site yet
  (confirmed with the user). No store badges.
- Industry is nutrition/health. Pick a `lucide-react` icon already available in
  the project and an accent class from the existing palette
  (`text-chart-5` / `text-warning` / `text-primary` / `text-info` / `text-success`);
  `text-success` is now free since FanZone was removed. Do not add a new colour.
- Add it to the footer product list and anywhere else products are enumerated,
  by deriving where a derived list already exists.

### 7c. Retire `/launch`
The launch countdown targets `2026-08-01T04:00:00.000Z` — in the past — for two
products that have already shipped, and it is the sitemap's highest-priority
entry. The user's decision is to remove it.

- Delete `app/(marketing)/launch/` (the index page, `[slug]` page, and any
  OG-image route or client countdown components under it) and
  `app/(marketing)/launch/launch-config.ts`.
- Remove the launch entries from `app/sitemap.ts` — including the
  `getLaunchReleases()` import and the `launchEntries` block at its top.
- Add a permanent redirect `/launch` → `/products` in `next.config.ts`,
  alongside the two added in Task 3. Also redirect `/launch/:slug` → `/products`.
- Remove any navbar or footer link to `/launch` if one exists.
- Grep for remaining importers of `launch-config` before deleting, and remove
  every reference — a dangling import fails the build.

**Verify:** `pnpm --filter web typecheck`, `lint` and `build` all pass;
`/launch` and `/launch/fe3dr` redirect to `/products`; the hero reads `02` live;
Kora appears as coming-soon with no outbound link; Dwellm8 shows as
coming-soon everywhere; no dangling `launch-config` references remain.

---

## Task 8 — SEO, metadata, structured data and AI crawler policy

**Why:** the site's root metadata still describes an abandoned positioning, four
surfaces carry factually wrong copy about the product lineup, and there is no
structured data for a reviewer or crawler to verify the company against.

### 8a. Fix the stale lineup copy — all FOUR instances
The phrase "one industry at a time. Commerce, sports, healthcare, food" is wrong
on two counts: "sports" was FanZone (removed), and the list omits rentals and
nutrition. The live lineup is **commerce, food, rentals, healthcare, nutrition**.
Fix in:
- `components/marketing/hero.tsx`
- `components/common/footer.tsx`
- `app/(marketing)/about/page.tsx:7` (metadata description)
- `components/marketing/about-teaser.tsx:16` ("healthcare, food, and sport")

Derive the industry list from `products-data.ts` if an `industry` field exists or
can be cleanly added; otherwise define it in ONE shared constant and import it
into all four. Do not leave four independent copies of the same sentence.

### 8b. Root metadata
`app/layout.tsx` currently titles the site
**"Tesserix - Commerce Infrastructure for Growing Businesses"** (lines 19-23, and
repeated in the `openGraph` block at 48 and `twitter` at 57). That positioning is
dead — Tesserix is a product studio building specialised SaaS, one industry at a
time. Rewrite the root title, description, OG and Twitter entries to match the
positioning already used on `/about`, keeping the `title.template` pattern so
child pages keep rendering `Page | Tesserix`.

### 8c. Per-page metadata and canonicals
- Every marketing route exports `metadata` with a distinct, accurate title and
  description. Audit them; several are thin or duplicated.
- Add `alternates.canonical` per page. `metadataBase` is already set to
  `https://tesserix.app` in `app/layout.tsx:39` — build canonicals off it.
- Product detail pages generate metadata per product from `products-data.ts`.

### 8d. OpenGraph / Twitter images
`app/opengraph-image.tsx` exists at the root. Verify it still renders correctly
after the lineup changes and does not reference FanZone or the deleted launch
feature. Add per-product OG images generated from `products-data.ts` if the
existing pattern makes that cheap; otherwise ensure every page falls back to the
root image cleanly. No broken image references.

### 8e. JSON-LD structured data
Add JSON-LD via a `<script type="application/ld+json">` in the appropriate
layouts. Use ONLY facts verified in this plan:
- **Organization** on the root: legal name Tesserix Pty Ltd, url, logo,
  `address` as a PostalAddress using the Kings Park NSW address, and
  `identifier` entries for ACN 694 070 865 and ABN 59 694 070 865. Add
  `sameAs` for the real product domains and the founders' public profiles.
- **WebSite** with the site name.
- **SoftwareApplication** per product on each product detail page, generated
  from `products-data.ts`. Do NOT emit `offers`/price — pricing was removed
  deliberately and inventing a price in structured data is worse than in copy.
  Do NOT emit `aggregateRating` — there are no verified ratings.
- **BreadcrumbList** on product detail pages.

Validate the emitted JSON parses and contains no `undefined` values.

### 8f. `robots.ts` and AI crawler policy
`app/robots.ts` exists — audit and extend it.
- Keep `/admin`, `/login`, `/api`, `/auth` disallowed; verify they already are.
- Ensure the sitemap URL is declared.
- **AI crawler policy — the user asked for an explicit decision here.** Add named
  rules for `GPTBot`, `ChatGPT-User`, `OAI-SearchBot`, `ClaudeBot`,
  `Claude-User`, `anthropic-ai`, `PerplexityBot`, `Google-Extended`,
  `CCBot`, `Applebot-Extended`, `Bytespider` and `meta-externalagent`.
  **Default to ALLOW** for this site: it is a marketing site whose entire purpose
  is discoverability, and being absent from AI answer engines costs more than
  training exposure on public marketing copy. Implement it as an explicit,
  commented allow-list so the decision is visible and trivially reversible —
  not as silent omission.

### 8g. `llms.txt`
Add a `/llms.txt` route (a `route.ts` returning `text/plain`) following the
llms.txt convention: a short H1 of the company, a blockquote summary, then
linked sections for the products and key pages with one-line descriptions.
Generate the product list from `products-data.ts` so it cannot drift.

### 8h. Sitemap
Already generated from `productSlugs` (Task 3) with launch entries removed
(Task 7). Verify: every public route is present — including `/privacy`,
`/terms`, `/cookies`, `/careers` which were added after the sitemap was last
touched and are probably missing. Set sane `priority` and `changeFrequency`
(legal pages low, home/products high). No route may 404 or redirect.

**Verify:** `pnpm --filter web typecheck`, `lint`, `build` pass. `/robots.txt`,
`/sitemap.xml` and `/llms.txt` all return 200 with correct content types. Every
URL in the sitemap returns 200 (script it — no redirects, no 404s). JSON-LD
parses. `grep -rn "sports" app components` finds no stale lineup copy.

---

## Task 9 — Product imagery and corrected social links

### 9a. Fix the footer social links (correctness bug)
`components/common/footer.tsx` lines 142, 153 and 164 point at URLs that are
wrong. Verified-correct values (all return 200):

| Current (wrong) | Correct |
|---|---|
| `https://twitter.com/tesserix` | `https://x.com/tesserix_app` |
| `https://linkedin.com/company/tesserix` | `https://au.linkedin.com/company/tesserix-pty-ltd` |
| `https://github.com/tesserix` | `https://github.com/tesserix` — already correct, leave it |

Strip the `?trk=...` tracking parameter from the LinkedIn URL. Keep the existing
X/Twitter glyph (it is already the X mark, not the old bird). Ensure each link
keeps its `aria-label`, `target="_blank"` and `rel="noopener noreferrer"`.

### 9b. Product imagery
**Only the two live products get imagery. MediCare, Dwellm8 and Kora get none** —
a mockup for unshipped software is exactly what erodes trust in a due-diligence
read. This is a hard rule, not a preference.

Assets already in the repo, captured from the live sites:
- `apps/web/public/screens/mark8ly-storefront.jpg` (1568×682)
- `apps/web/public/screens/fe3dr-web.jpg` (1568×682)

Real app store screenshots — **copy the ones you use into
`apps/web/public/screens/`**, do not reference the sibling repo by relative path:
- `../Home-Chef-App/apps/mobile-customer/store-assets/screenshots/android-phone/`
  → `01-browse`, `02-chef-menu`, `03-weekly-tiffin`, `04-orders`, `05-saved`
- `../Home-Chef-App/apps/mobile-vendor/store-assets/screenshots/android-phone/`
  → `01-dashboard`, `02-orders`, `03-menu`, `04-earnings`, `05-more`

Add an optional `media` field to the product type in `products-data.ts`
(image path + alt text + orientation), populated for `mark8ly` and `fe3dr` only,
and render it on the product detail pages. Phone screenshots are portrait and
must not be stretched to a landscape frame — give them an appropriate aspect
ratio, and prefer showing two or three phone shots as a row over one giant one.

Use `next/image` with explicit `width`/`height`, meaningful `alt` text
describing what the screen shows (not "screenshot"), and `loading="lazy"` below
the fold. Optimise: the two site captures are JPEG; convert or serve responsibly
so the page does not regress on weight.

### 9c. Correct a founder's name
`app/(marketing)/about/team.ts` currently has **"Samyak R"**. His name is
**"Samyak Rout"** — correct it. Keep the `slug` as `samyak-r` unless nothing
references it, in which case `samyak-rout` is fine; if you do change the slug,
the photo path becomes `/team/samyak-rout.jpg` and the initials fallback must
still resolve to "SR". Getting a founder's name wrong on a due-diligence page is
not a cosmetic issue — verify it renders correctly afterwards.

### 9d. Founder photo
The user is supplying `apps/web/public/team/mahesh-sangawar.jpg` directly. The
initials fallback built in Task 6 already handles its absence, so **do nothing
here** — just confirm the photo renders correctly if the file is present when
you run, and that the fallback still works for `samyak-r.jpg` which is absent.

**Verify:** all three footer social links resolve to the corrected URLs; the two
live products show real imagery; the three coming-soon products show none;
typecheck, lint and build pass; no layout shift or stretched phone screenshots at
375px, 768px and 1440px.

---

## Task 10 — Asset crispness and hygiene

**Why:** the user reports the logo looks soft. Investigation shows the source is
fine and the rendering is wrong.

### 10a. The logo is being distorted — fix the aspect ratio
`apps/web/public/logo.png` is **1606×389**, a true ratio of **4.129:1**. It is
rendered at ratios that do not match, squashing it ~22% vertically:

| File | Current | Ratio | Correct for that width |
|---|---|---|---|
| `components/common/navbar.tsx:109` | `width={108} height={32}` | 3.375 | **108×26** |
| `components/common/navbar.tsx:244` | `width={108} height={32}` | 3.375 | **108×26** |
| `components/common/footer.tsx:39` | `width={94} height={28}` | 3.357 | **94×23** |

Fix by correcting the height to preserve 4.129:1 — or, if the current *height*
is the intended visual size, widen instead (32px tall → 132×32; 28px tall →
116×28). Pick whichever keeps the header and footer visually balanced, apply it
consistently, and state which you chose and why in your report.

Add `quality` and appropriate `sizes` handling if it measurably helps, but the
distortion is the actual bug — do not paper over it with sharpening.

### 10b. `kora-icon.png` is too small
It is **64×64**, against 512×512 for `icon.png` and 1024×1024 for the others.
If it is rendered anywhere above 64px it will be visibly soft. Find every usage.
If it is used large, either source a bigger asset or stop using it at that size —
**do not upscale a 64px raster**, which will look worse. Report what you find
rather than inventing a replacement.

### 10c. Hygiene
- `apps/web/public/.DS_Store` is committed and served publicly. Delete it and add
  `.DS_Store` to `.gitignore` if not already present.
- `homechef-icon.png` / `homechef-icon-mono.png` are named for the old brand.
  Rename to `fe3dr-*` **only if** they are referenced from marketing code you can
  update in the same change; if they are referenced from out-of-scope code
  (`app/admin/**` etc.), leave them and note it.

**Constraints:** do not regenerate, redraw or AI-generate any brand asset — the
logo must stay pixel-identical to the one on the live Play Store listings,
mark8ly.com and fe3dr.com. This task is about rendering existing assets
correctly, not making new ones.

**Verify:** logo renders undistorted at 375px, 768px and 1440px in both navbar
and footer; `/`.DS_Store` no longer served; typecheck, lint and build pass.

---

## Task 11 — Use the mark, and give the tab a crisp icon

**Why:** the project already has two logo variations and only uses one. The
browser-tab icon is a 32×32/16×16 `.ico`, which is soft on modern displays and
is part of what the user perceives as "not crisp".

Existing assets — **use these, do not create or regenerate any**:
- `apps/web/public/logo.png` — 1606×389, mark + TESSERIX wordmark
- `apps/web/public/icon.png` — 512×512, the standalone mark
- `apps/web/public/apple-touch-icon.png` — 180×180
- `apps/web/app/favicon.ico` — 32×32 and 16×16 only

### 11a. Modern app icons
Next.js App Router generates the right `<link rel="icon">` tags from file
conventions in `app/`. Add:
- `app/icon.png` — the 512×512 mark (copy `public/icon.png`), giving browsers a
  high-resolution source instead of the 32px `.ico`.
- `app/apple-icon.png` — the 180×180 apple-touch-icon.

Keep `favicon.ico` for legacy browsers; App Router serves both happily. Verify
the generated `<head>` actually references the new icons and that the tab icon
is sharp on a 2x display.

### 11b. Use the mark where the wordmark is cramped
The mobile navbar renders the full wordmark. Evaluate whether the standalone
mark reads better at small widths, and if so use `icon.png` below the `sm`
breakpoint and the wordmark above it. **This is a judgement call — if the
wordmark is comfortable at 375px, change nothing and say so.** Do not swap it
just because you can; an inconsistent brand across breakpoints is worse than a
slightly smaller wordmark.

**Constraints:** no regenerating, redrawing, recolouring or AI-generating brand
assets. Preserve every aspect ratio (the mark is square, the wordmark is
4.129:1 — Task 10 fixed that distortion; do not undo it).

**Verify:** tab icon crisp at 2x; `/icon.png` and `/apple-icon.png` resolve;
no distortion at 375px, 768px, 1440px; typecheck, lint, build pass.

---

## Task 12 — Three real bugs the design pass surfaced but could not fix in scope

### 12a. Horizontal scrollbar on every page at mobile widths
The closed mobile nav drawer sits off-screen but still extends the document, so
every page scrolls sideways at mobile widths. Task 5 fixed the accessibility
half (its links were tabbable when closed) with `invisible`, but
`visibility: hidden` still counts toward `scrollWidth`.

Fix with `overflow-x: clip` on `html` — in `app/globals.css` or the root layout.
**Use `clip`, not `hidden`:** `overflow-x: hidden` creates a scroll container
that breaks the sticky-positioned product cards on the homepage. Verify the
sticky cards still stick after the change.

Confirm the bug before and after by measuring at 375px:
`document.documentElement.scrollWidth > document.documentElement.clientWidth`.

### 12b. The footer newsletter form silently discards emails
`components/common/footer.tsx` has a bare `<form>` with no `action` and no
submit handler. Pressing Subscribe reloads the page and throws the address away.
A credit reviewer may well test it.

**Reuse what already exists — do not invent a new mechanism.**
`components/marketing/waitlist-form.tsx` already posts to `/api/waitlist` and
handles client-side validation, `submitting`/`done` states and error display.
`app/api/waitlist/` exists and is the real endpoint.

Either extract the shared submit logic from `WaitlistForm` into something both
can use, or give the footer its own small client component following the same
pattern. Post to `/api/waitlist` with a source identifying it as the newsletter
signup rather than a product waitlist. Read the API route first and match its
expected payload exactly — do not guess the shape.

Requirements: real success and error states (never a silent failure), a labelled
input, disabled state while submitting, and `aria-live` on the status message.

### 12c. Deduplicate the principles grid
`/about` and `/careers` each render the same ~25-line principles grid over the
shared `principles` array. Extract the grid itself into one component both
import. Keep both pages rendering identically to now — this is a pure
refactor, verify by diffing the rendered output before and after.

**Constraints:** same scope and design rules as every prior task —
`app/(marketing)/**`, `components/marketing/**`, `components/common/**`, plus
`app/globals.css` for 12a only. No `app/admin/**`, `app/api/**` (read only),
`lib/**`, or `@tesserix/homechef-shared`. No new design tokens. Do not disturb
the footer's identity block, social links, badge row, or the logo's 116×28
dimensions.

**Verify:** no horizontal scroll at 375px/768px/1440px; sticky product cards
still work; the newsletter form actually persists an email and shows a real
confirmation; `/about` and `/careers` render identically to before; typecheck,
lint and build pass.

---

## Task 13 — Fix the final review's Critical findings

The whole-branch review returned **DO NOT MERGE** with seven Critical findings.
Every one is the same failure this branch exists to eliminate: a claim the site
cannot back up. Fix all of them.

### ROOT CAUSE — fix this first, it causes C3 and C6
Product marketing copy exists in **three independent hardcoded copies**:
`products-data.ts`, `app/(marketing)/products/page.tsx` (~lines 30-100), and
`components/marketing/products-grid.tsx` (~lines 53-119). Only names and
statuses were wired to the single source of truth; descriptions, taglines and
highlights still drift. Mark8ly alone has three different descriptions.
**Consolidate: `products-data.ts` owns all product copy; the other two derive.**

### C1. Fabricated "14-day free trial" on both live products
`product-content.tsx:123` renders `No credit card required · 14-day free trial`
for every `available` product; CTAs at `:102`, `:377`, `:382` say "Start free
trial".
- Mark8ly's real offer is **"Free for ninety days. No card required."**
- **Fe3dr has no trial at all** — it is a consumer food marketplace; you buy meals.
Remove the generic trial line. Any trial wording must come per-product from
`products-data.ts`, and Fe3dr must have none. Fe3dr's CTA should reflect what it
actually is (e.g. order food / visit fe3dr.com), not "Start free trial".

### C2. Same-page contradiction on /products/mark8ly
Hero says "14-day free trial"; benefits list ~15 lines below
(`products-data.ts:135`) says "Free for ninety days". Resolve to **ninety days**.

### C3. Mark8ly product cap is contradicted by mark8ly.com
`products-data.ts:118-123` and `products/page.tsx:34` claim "Up to 100 products
on Starter" / "Studio and Pro are unlimited". mark8ly.com's live pricing says
Starter is **"Unlimited products & orders"**. The real differentiators are
stores (2/5/10) and images per product. Remove the invented cap.

### C4. Fabricated healthcare metric
`products-data.ts:362` — "Reduce administrative overhead by 60%" for a product
that does not exist and has no customers. **Delete it.** Do not replace it with
another number.

### C5. Unqualified HIPAA claim
`products-data.ts:363` — "HIPAA compliant data security" asserted flatly for an
unbuilt product; `products-grid.tsx` hedges the same claim as "HIPAA-aligned".
Use the hedged form consistently, or drop it.

### C6. MediCare has two taglines and two descriptions
"Hospital management without the bloat" (`products/page.tsx:76`,
`products-grid.tsx:100`) vs "Complete Hospital Management System"
(`products-data.ts`). Feature names diverge too. MediCare is also the only
product still in generic vendor voice ("comprehensive", "digitizes every
aspect") — it was missed by the earlier rewrite. Give it one voice matching the
others, sourced from `products-data.ts`.

### C7. "0% — Transaction fees, ever" is false portfolio-wide
`components/marketing/hero.tsx:57`, hardcoded beside three derived stats.
**Fe3dr charges fees** — verified in its own source:
`Home-Chef-App/apps/api/models/order.go:173-177` (`PlatformFee`,
`PlatformFeePercent`), `:208-212` (`CommissionRate`),
`models/statement.go:35` (`PlatformCommission`).
This is a Mark8ly claim promoted to a company claim. Either scope it to Mark8ly
or replace the stat with something true and derived.

### Also fix — verified externally, cheap, same credibility class
- **Dead Resources links.** `footer.tsx:25-26`: `docs.tesserix.app` and
  `ui.tesserix.app` both return **503**. `https://blog.tesserix.app/` returns
  **200** — use it. Remove or replace the two dead links; do not ship a
  Resources column where every link errors.
- **`dwellm8.com` does not resolve** (connection fails outright). Remove it as
  Dwellm8's `website` in `products-data.ts` AND from `sameAs` in
  `app/seo/structured-data.ts`, where it is asserted on every page. Dwellm8 is
  coming-soon and needs no link.
- **White-label app** (`products-data.ts:139`) reads as a Pro inclusion; it is a
  paid add-on ($199/mo + $2,000 setup, USD). Say so or drop the line.
- **"Start free trial" → `/contact`** (`product-content.tsx:100-105`, `:381`):
  label promises self-serve, delivers a lead form. Make the label honest.
- **Kora's "never hallucinated"** — the spec states this as a design directive,
  not a shipped guarantee. Use the hedged "built to never hallucinate a value"
  form everywhere.
- **JSON-LD `operatingSystem: "Web"`** for all five products; Kora and Fe3dr are
  iOS/Android. Set it per product from `products-data.ts`, or omit it.
- **"Zivana Innovations LLP, part of Tesserix Pty Ltd"** (`/privacy` §01,
  `/terms` §01) asserts a group structure a reviewer checking ACN 694 070 865
  will not find. Soften to the factual relationship (e.g. "operated in India by
  Zivana Innovations LLP") unless the structure is documented.
- **GST** (`/terms` §06) asserts a flat 10% GST on Australian customers.
  Soften to "plus GST where applicable" — charging GST requires registration.
- **Fe3dr vendor app** is only on `/products/fe3dr`. Three live Android apps is
  a strong credibility signal; surface the vendor app in the footer too.

**Constraints:** no invented replacement facts — when a claim cannot be
verified, DELETE it rather than substituting another. Scope stays
`app/(marketing)/**`, `components/marketing/**`, `components/common/**`,
`app/seo/**`. No new design tokens. Do not disturb company identity values,
founder data, store URLs, the logo dimensions (132×32 / 116×28), or reintroduce
any pricing figure.

**Verify:** no "14-day", no "100 products", no "60%", no unhedged "HIPAA
compliant", no "0% transaction fees" as a portfolio stat, no `dwellm8.com`
anywhere, no 503 links in the footer. Mark8ly and MediCare each read with ONE
description and ONE tagline sitewide. typecheck, lint, build pass.

---

## Out of scope
- Any change to `app/admin/**`, `app/api/**`, `lib/**`, or
  `@tesserix/homechef-shared`.
- fe3dr.com's own stale "Coming soon to Google Play" copy (different repo —
  flagged to the user separately).
