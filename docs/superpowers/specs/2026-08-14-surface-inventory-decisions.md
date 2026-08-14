# Surface inventory — delete vs port decisions

> **Purpose:** the console redesign's M2 migrates ~70 surfaces and ends by deleting
> `apps/web/app/admin`. That deletion reliably slips, because the residue is always the
> surfaces nobody wants. **This list is the thing that makes the final 10% finite.**
>
> **Status:** Proposed — needs sign-off per row. Issue #103.
> **Counts verified from the codebase 2026-08-14**, post-#97.

## How to read this

- **PORT** — rebuild on the console kit, in the named section.
- **MERGE→X** — the route disappears; its capability moves into X.
- **CUT** — the route AND its capability go. Deleting nothing else.
- **TAB** — becomes a tab on a surface that already exists.

**Established by audit and not up for re-litigation:** nothing in Fe3dr is mocked, stubbed
or dead. Every surface hits a live backend. So *there is no free deletion* — almost every
"cut" below is *cut the route, keep the capability*.

**LOC** is the current `page.tsx` line count. Where a surface is thin, the substance is in
a component (noted).

---

## CUT — route and capability both go (2)

| LOC | Surface | Why | Sign |
|---|---|---|---|
| 6 | `apps/dwellm8` | Overview shell only; the product's real surfaces don't exist yet. Becomes a Launchpad tile. Registry row landed in #97. | ☐ |
| 6 | `apps/devai` | Same shape — Overview plus three links that navigate *out* to platform pages. Its real value (approval_gates, sre_incidents) becomes Inbox sources, not a rail. | ☐ |

---

## Launchpad (4)

| LOC | Surface | Verdict | Sign |
|---|---|---|---|
| 130 | `apps` | **PORT → Launchpad.** Grow into the tile grid; needs the registry columns from ADR-002 (`argocd_app`, `kargo_project`, `kargo_stage`, `image_repo`). | ☐ |
| 6 | `apps/homechef` | MERGE→Launchpad tile + Business. Four KPI tiles' worth of content. | ☐ |
| 6 | `apps/mark8ly` | MERGE→Launchpad tile + Business. **Note:** its tiles come from the dashboard fallback, not `/kpis` — see #97's Critical. | ☐ |
| 6 | `apps/kora` | MERGE→Launchpad tile + Business. | ☐ |

---

## Inbox — things waiting on a human (11)

| LOC | Surface | Verdict | Sign |
|---|---|---|---|
| 403 | `apps/homechef/approvals` | MERGE→Inbox (queue). ~45% is table/filter/bulk chrome. | ☐ |
| 412 | `apps/homechef/approvals/[id]` | **PORT** as the Inbox detail route. ~90 lines are defensive normalisers for a real Go JSON-column bug — keep them. | ☐ |
| 368 | `apps/homechef/fssai` | MERGE→Inbox as **two** queues. The route is a 17-line tab bar; the substance is `fssai-requests.tsx` (389 lines). | ☐ |
| 166 | `apps/homechef/cancellations` | MERGE→Inbox. Pure queue. Works in **paise** — money-unit normalisation needed. | ☐ |
| 150 | `apps/homechef/messaging` | MERGE→Inbox. **Rename to `mediation`** to match the nav label and the mobile route. | ☐ |
| 285 | `apps/homechef/payout-queue` | MERGE→**payouts hub** as a "Holds" tab, AND surface in Inbox. Currently an orphan with zero inbound links doing release/withhold/reverse of real escrow. | ☐ |
| 178 | `apps/homechef/refund-payouts` | MERGE→**cancellations/refunds**, NOT payouts. Opposite money direction, different gateway, different entity. | ☐ |
| 972 | `apps/homechef/support` | **SPLIT 3 ways.** Tickets tab → Inbox; Order-issues and Delivery-failures → Inbox queues. ~270 lines of refund/fault arbitration have no analogue anywhere — must survive. | ☐ |
| 140 | `platform-tickets` | MERGE→Inbox (list). Empty pending mark8ly's filing UI; empty state added in #97. | ☐ |
| 377 | `platform-tickets/[id]` | **PORT** as Inbox detail. Genuine complexity, no table. | ☐ |
| 48 | `support/live-chat` | MERGE→Inbox. Thin wrapper over the Otto widget; prefix verified in #101. | ☐ |
| 232 | `erasure-requests` | MERGE→Inbox (queue) + Governance (history). Hardcoded 14d/30d SLA thresholds. | ☐ |

---

## Business (5)

| LOC | Surface | Verdict | Sign |
|---|---|---|---|
| 57 | `dashboard` | **CUT & REBUILD.** 5 of 6 elements are mark8ly-only; the sole cross-product number counts the app registry itself. BACKLOG A6. | ☐ |
| 6 | `apps/mark8ly/subscriptions` | MERGE→Business. Uses the shared layout (149 lines) already. | ☐ |
| 342 | `analytics/support` | MERGE→Business. Reinvents a local `KpiTile`. | ☐ |
| 182 | `apps/homechef/analytics` | MERGE→Business. **Cleanest page in the estate** (~16% chrome) — use it as the kit's reference implementation. | ☐ |
| — | *(new)* Cost/margin | Build from `lib/metrics/{margin,opencost,cost-proxy}.ts`, which already exist. | ☐ |

---

## Growth (10)

| LOC | Surface | Verdict | Sign |
|---|---|---|---|
| 1437 | `apps/mark8ly/leads` | **PORT + decompose to ~8 files.** ~350–400 lines boilerplate, ~1000 real feature (activity drawer, send-email dialog, CSV importer). Web lacks the `/leads/[id]` route mobile has — add it. | ☐ |
| 203 + 399 | `notifications/lead-templates` (+`[key]`) | MERGE→**one Templates workspace** with a Scope column. | ☐ |
| 155 + 370 | `apps/mark8ly/notifications/templates` (+`[key]`) | MERGE→same workspace. **Data split is genuinely required** (product DB + cache-evict ping); ~70% of the *UI* is duplicated. ~400 of 1,127 lines deletable. | ☐ |
| 720 | `apps/homechef/campaigns` | **PORT → Growth.** Real send lifecycle; shares zero fields with promos. Large from one 289-line uncomponentised form. | ☐ |
| 744 | `apps/homechef/promos` | **PORT → Growth.** ~63% form/table/pagination chrome; create and edit forms restate 7 fields twice. | ☐ |
| 226 | `apps/homechef/winback` | MERGE→**Programs** (one surface, three sections) | ☐ |
| 177 | `apps/homechef/loyalty` | MERGE→Programs. `ConfigCard` is a line-for-line clone of winback's. | ☐ |
| 299 | `apps/homechef/chef-rewards` | MERGE→Programs. Only page declaring its contract inline and hand-rolling its own status pill. **~200 triplicated lines die here.** | ☐ |
| 286 | `apps/mark8ly/onboarding` | **PORT → Growth** (+ stalled sessions → Inbox). Route hardcodes `product !== "mark8ly" → 404`. | ☐ |
| 138 | `platform-announcements` | **PORT → Growth.** Also consumed by `/api/internal/*`. | ☐ |

---

## Operate (7)

| LOC | Surface | Verdict | Sign |
|---|---|---|---|
| 430 | `observability` | **DEMOTE → Launchpad link-out.** Duplicates `obs-ui`, not Grafana. Gated on #100. Genuine complexity if kept. | ☐ |
| 245 | `uptime` | **PORT → Health, tab 1 (External/probes).** The only operational surface working today. | ☐ |
| 257 | `health` | **PORT → Health, tab 2 (Internal/workloads).** Prometheus-backed; blocked while parked (#100). | ☐ |
| 329 | `databases` | **PORT → Operate.** Add backup health (O2) sourced from **chart config + GCS freshness**, not Prometheus. | ☐ |
| 428 | `custom-domains` | **PORT → Operate** + slim. ~half is KPI/filter/table boilerplate. Add cert expiry (#108). | ☐ |
| 271 | `outbox` | **PORT → Operate** (+ stuck rows → Inbox). Normalises two different outbox schemas. | ☐ |
| 316 | `notifications/log` | **PORT → Operate.** Real query, empty in practice pending SendGrid webhook config. | ☐ |
| 195 + 196 | `apps/homechef/delivery` + `delivery-intelligence` | **PORT → Operate**, intelligence as a **TAB**. Unrelated systems sharing a word (3PL vs self-delivery pricing). Link added in #97. | ☐ |

---

## Directory (14)

| LOC | Surface | Verdict | Sign |
|---|---|---|---|
| 256 | `search` | MERGE→Directory. **Coverage gap:** reaches only mark8ly-family sources — a HomeChef or Kora user cannot be found. | ☐ |
| 177 | `users/[email]` | MERGE→Directory detail. Shares the same module as `search`. | ☐ |
| 182 | `apps/mark8ly/tenants` | MERGE→Directory. Add kill-switch reason codes (H2). | ☐ |
| 11 | `apps/mark8ly/tenants/[id]` | **PORT** — the model for `DetailLayout` (326-line shared layout). | ☐ |
| 660 | `apps/homechef/chefs` | **PORT → Directory**, extract `ChefDocuments` (175) + `ChefDetail` (68). Mode-flip flow is real domain logic. | ☐ |
| 170 | `apps/homechef/chefs/[id]/test-sessions` | **TAB** on chef detail. | ☐ |
| 166 | `apps/homechef/users` | MERGE→Directory. 66% boilerplate. | ☐ |
| 187 | `apps/homechef/wallets` | **TAB** on user detail — already deep-linked `?userId=`. Confirm added in #97. | ☐ |
| 162 | `apps/homechef/orders` | MERGE→Directory. 74% boilerplate. | ☐ |
| 226 | `apps/homechef/orders/[id]` | **PORT** as Directory detail. Deliberately no refund button — keep it that way. | ☐ |
| 107 | `apps/homechef/meal-plans` | MERGE→Directory view. **79% boilerplate**, zero mutations — becomes ~25 lines on `ConsoleDataTable`. | ☐ |
| 144 | `apps/homechef/reviews` | MERGE→Directory (moderation). | ☐ |
| 234 / 145 / 26 | `apps/kora/foods` (+`[id]`, `new`) | **PORT → Directory.** Best error discipline in the console; optimistic-concurrency 409 handling. | ☐ |
| 99 / 177 | `apps/kora/users` (+`[id]`) | MERGE→Directory. | ☐ |
| 203 | `apps/kora/feedback` | **PORT → Directory** (or Inbox — see note). Add bulk actions; it's the only bulk candidate in Kora. | ☐ |

---

## Governance (5)

| LOC | Surface | Verdict | Sign |
|---|---|---|---|
| 16 | `apps/mark8ly/audit-logs` | **PORT → unified Audit.** Already proves the shared layout at 16 lines — the canonical one. | ☐ |
| 233 | `apps/homechef/audit-logs` | MERGE→unified Audit. **48% boilerplate, worst ratio in the estate.** ⚠️ Must keep using the *gateway* (flat envelope), NOT `[product]/audit-logs` — that route is now mark8ly-gated (#97). | ☐ |
| 148 | `apps/kora/audit` | MERGE→unified Audit. Third unported copy. | ☐ |
| 209 | `break-glass` | **PORT → Governance.** Two cross-DB queries merged in app code. | ☐ |
| 317 | `apps/homechef/staff` | **PORT → Governance/Directory.** Pagination fixed in #97. | ☐ |

---

## Settings (6)

| LOC | Surface | Verdict | Sign |
|---|---|---|---|
| 696 | `settings` | **PORT + decompose.** 47% is real Stripe CRUD. **CUT the "Platform" tab** (86 lines) — it's a static link list duplicating the nav. | ☐ |
| 458 | `apps/homechef/platform-settings` | **PORT → Settings.** ~105 lines are the same section skeleton ×3. | ☐ |
| 608 | `apps/homechef/tax-rates` | **PORT → Settings**, extract the 255-line pricing simulator to its own file and move 95 lines of types into `homechef-shared`. **Genuine complexity — not boilerplate.** | ☐ |
| 370 | `apps/homechef/payment-gateway` | **PORT → Settings.** Extract one `CredentialSlotCard` shared with `PayoutRailPanel` — **~350 lines absorbed**. | ☐ |
| 420 | `apps/homechef/payouts` | **PORT as the payments hub** with tabs: Statements · Holds · Blocked chefs · Settings. Already a tab container without tabs (6 panels, 1,653 lines of components). | ☐ |
| 190 | `apps/homechef/payout-setup` | MERGE→payouts hub ("Blocked chefs" tab). **Resolve the 4 competing automation switches while merging** — an operator cannot tell which applies. | ☐ |

---

## Totals

| Verdict | Count |
|---|---|
| CUT entirely | 3 (`apps/dwellm8`, `apps/devai`, `dashboard` rebuild) |
| MERGE / TAB (route goes, capability stays) | ~30 |
| PORT | ~25 |
| Product overview shells → Launchpad | 4 |

**Net route reduction: ~70 → ~40.** Roughly 45% fewer routes with **no capability lost**.

## Open question inside this list

`apps/kora/feedback` — Directory or Inbox? It has a status workflow (a human triages
feedback), which argues Inbox; but it is also a browsable record set, which argues
Directory. It matters because it is the only bulk-action candidate in Kora and was
proposed as M0's `QueueList` proof. **Decide when the pilot is chosen (#102).**
