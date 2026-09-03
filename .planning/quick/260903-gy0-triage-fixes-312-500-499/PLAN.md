---
id: 260903-gy0
slug: triage-fixes-312-500-499
date: 2026-09-03
kind: quick
---

# Three verified small fixes from the open-issue triage

Filed together because each is independently small and independently verified;
kept as separate commits because they share nothing but their size.

`/gsd:quick` could not run its own workflow here — `gsd-sdk query init.quick`
reports `roadmap_exists: false`, and this repo has neither `ROADMAP.md` nor
`STATE.md`. The local convention (every prior `.planning/quick/` entry) is a
PLAN.md and atomic commits, which is what this is.

## Task 1 — #312: the runbook's role-check claim is wrong

`docs/RUNBOOK-ZITADEL-IDENTITY.md:46` asserts the `platform-console` project has
"Only authorized users can authenticate" ON. The live project carries only
`projectRoleAssertion: true`; `projectRoleCheck` is absent, which in proto3 is
false. A role-less operator authenticates at Zitadel perfectly well and is
refused later, by the console.

The removal procedure at line ~57 depends on the wrong claim — it says removing
the role assignment is sufficient "with the setting above".

Two further stale statements in the same file, fixed in the same commit because
they are the same procedure:

- Line ~155 repeats the "Only authorized users can authenticate" check as the
  reason a login succeeded.
- The revocation note says roles live 7 days "until #285 lands". #285 landed
  (PR #458): `CAPABILITY_REVALIDATE_SECONDS = 300`, so a revoked grant now
  takes effect in ~5 minutes.

**Done when:** the file describes where refusal actually happens (`isInternal`
in `packages/platform-auth/src/zitadel.ts` at `/auth/callback`, and
`CONSOLE_ENTRY_CAPABILITY` in `apps/console/lib/internal-access.ts` via
`middleware.ts`), and the removal procedure states the real revocation window.

## Task 2 — #500: 602 prefetching links on the secrets inventory

`secrets-table.tsx` renders one `<Link>` per row with no `prefetch` prop, at a
fully dynamic route that fans out to three `secrets-api` calls per render.

The precedent and the argument already exist in this repo at
`apps/console/app/(console)/platform/crm/page.tsx:552-556`.

**Done when:** the row link carries `prefetch={false}` with a comment naming the
fan-out it avoids, and a render test pins it so the prop cannot be dropped.

## Task 3 — #499: the tools directory's third copy is unguarded

`packages/console-core/src/tools.ts` is the console's fallback directory,
maintained by hand. `tools.test.ts` asserts its internal shape only — no full
URLs, no duplicate subdomains — and nothing compares it to the migrations that
are the source of truth (`0031` seeds, `0042` deletes).

**Done when:** a test derives the expected set from the migration SQL and fails
on drift in either direction.
