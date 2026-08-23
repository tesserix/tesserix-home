# Console Health Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** the header indicator sits right of Search, carries an icon, and links
to `/platform/health` — a page that absorbs the five dead entries the Health
rail group is deleted from.

**Spec:** extends `docs/superpowers/specs/2026-08-23-console-health-indicator-design.md`,
and REVERSES its decision D1 ("the rail entries stay where they are") at the
user's explicit request. D1's reasoning was that the header must not link to
things that do not exist; building the page removes that objection.

## Global Constraints

- **pnpm, not npm.** `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`,
  `pnpm build`, `pnpm exec vitest run <file>`. Run console commands from
  `apps/console`. Dependencies are installed; do NOT run `pnpm install`.
- **`/platform/health` is gated on `read`, NEVER `platform`.** The header links
  there for every operator; gating on `platform` gives a `crm`-only operator a
  403 on a link they can see. This is the C1 defect, for the third time.
- **`platform.serviceHealth` ALREADY declares `mobile: "/platform/health"`.**
  Reuse that route id — do not invent a parallel one.
- **NEVER delete a test to make the suite green.** Several sidebar tests use the
  Health group only as a convenient fixture for group behaviour (expand,
  collapse, persistence). Those tests are about GROUPS, not about Health.
  Re-point them at another group; deleting them silently drops real coverage.
- Commits: single-line conventional, no signature, no co-author trailer.

---

### Task 1: The health page

**Files:**
- Create: `apps/console/app/(console)/platform/health/page.tsx`
- Create: `apps/console/app/(console)/platform/health/page.render.test.tsx`
- Modify: `packages/console-core/src/routes.ts`
- Modify: `packages/console-core/src/routes.test.ts` (if it asserts on the changed entry)

**Route change.** `platform.serviceHealth` becomes real:

```ts
  // The estate health page, reached from the header indicator. `read`, NOT
  // `platform`: the indicator renders for every operator, and a link that
  // 403s the person who can see it is worse than no link. `pending` is gone
  // because the console surface now exists; the `web` path stays, since
  // apps/web still serves its own.
  "platform.serviceHealth": { web: "/admin/health", mobile: "/platform/health", console: "/platform/health", capability: "read" },
```

Leave `platform.uptime`, `platform.observability`, `platform.databases` and
`platform.customDomains` in ROUTES exactly as they are — they still record
apps/web surfaces. Only their NAV entries go (Task 2).

**The page** reads `readEstateHealth()` itself (it is cached ~15s server-side,
so this is not a second cluster read) and renders three parts:

1. **The state**, using the same three-state vocabulary and the same shapes as
   the indicator — filled circle / diamond / hollow ring. Import the
   presentation from the indicator rather than restating it, or extract it to a
   shared module. Two surfaces disagreeing about what `degraded` looks like is
   the drift this estate keeps paying for.
2. **What was measured:** workload and database counts, and the degraded
   `reason` broken onto its own lines when present. This is the first place the
   reason is legible without a mouse — it currently lives only in a `title`
   attribute.
3. **What is NOT measured yet:** a section naming Uptime, Observability and
   Custom domains as not yet measured, in the same visual language as
   `unmeasured`. These are the concerns whose rail entries are being deleted,
   and the page is where they now live. **Do not render them as "soon" badges** —
   that just moves the placeholder. Say plainly that nothing measures them yet,
   which is the same honesty the third state exists for.

Databases and Service health are NOT in that list: they are measured, and they
are what parts 1 and 2 show.

**Tests** (`page.render.test.tsx`): render each of the three states; assert the
degraded reason appears as text (not only in an attribute); assert the
not-yet-measured section names all three of Uptime, Observability and Custom
domains.

- [ ] Write the failing tests, run them, watch them fail
- [ ] Implement route change + page
- [ ] Run tests, watch them pass
- [ ] **Ablation:** change the route's capability to `"platform"` and confirm a
      test fails. If nothing fails, add the test that would have. Restore.
- [ ] `pnpm typecheck` in BOTH `apps/console` and `packages/console-core`, then
      `pnpm lint`, `pnpm test:unit`
- [ ] Commit

---

### Task 2: Delete the Health rail group

**Files:**
- Modify: `packages/console-core/src/nav.ts`
- Modify: `apps/console/components/nav/sidebar.render.test.tsx`
- Modify: `apps/console/components/nav/command-palette.render.test.tsx` (only if it breaks)

Remove the entire `Health` group from `platformNav` — the group and all five
items. Leave a comment where it was, recording that the group's five entries
were unbuilt placeholders and that estate health now lives at
`/platform/health`, reached from the header. Without that note the deletion
reads as an accident.

**The test work is the substance of this task, not an afterthought.**
`sidebar.render.test.tsx` uses `"Health"` as its fixture in at least six places
— asserting the group renders, that it expands on click, that pending entries
stay visible-but-disabled inside an open group, and that expansion persists to
storage. Those tests are about GROUP BEHAVIOUR. Re-point each at a group that
still exists and still has the property under test (a group with pending items
for the pending assertions). **Do not delete them.** If any test genuinely has
no equivalent left, say so and stop rather than dropping it.

`command-palette.render.test.tsx` uses `platform.customDomains` as its fixture
for "a pending route is disabled". That route stays in ROUTES, so this may not
break at all — check before touching it.

- [ ] Run the suite FIRST and record exactly which tests fail after the nav
      deletion, before changing any test
- [ ] Re-point each failing test, preserving what it asserts
- [ ] Confirm the suite is green with NO test removed — compare `it(` counts
      per file before and after and report both numbers
- [ ] Commit

---

### Task 3: Move the indicator, give it an icon, make it a link

**Files:**
- Modify: `apps/console/components/nav/health-indicator.tsx`
- Modify: `apps/console/components/nav/console-header.tsx`
- Modify: `apps/console/components/nav/health-indicator.render.test.tsx`
- Modify: `apps/console/components/nav/console-header.render.test.tsx`

Order in the header becomes: `ConsoleCommandPalette`, `HealthIndicator`,
`NotificationBell`, `OperatorMenu` — the indicator moves to the RIGHT of Search.

The indicator becomes a `next/link` to the console path for
`platform.serviceHealth` (resolve it through the existing route helper; do not
hardcode the string). It gains an icon — use `activity` or `heart-pulse` from
the existing `./icon` set, matching what the deleted rail group used.

**Preserve every accessibility property already there:** `role="status"`, the
full `aria-label` sentence, the state name in text, and the three distinct
SHAPES. The shapes are load-bearing below the `sm` breakpoint where the label
is hidden; a link wrapper must not quietly drop them.

Note that `role="status"` on a link is unusual — put the status semantics on an
inner element and let the link be a link, so the accessible name still carries
the full sentence and the control is still announced as a link.

- [ ] Write the failing tests: it is a link, it points at the health path, the
      icon renders, and every existing assertion still holds
- [ ] Implement
- [ ] **Ablation:** remove the icon, confirm the icon test fails; restore
- [ ] `pnpm typecheck` both workspaces, `pnpm lint`, `pnpm test:unit`, `pnpm build`
- [ ] Commit
