---
id: 260904-fu1
slug: console-followups
date: 2026-09-04
issue: "#544, #545, #546, #547 — the follow-ups filed from #543's review"
kind: quick
---

# The four follow-ups from #543

All four were filed off the review of #543 (generic `[product]` rail surfaces).
Three are pre-existing defects that branch surfaced; one is the "stays fixed"
gap on the Critical that branch introduced and fixed.

**Re-verified against `main` @ `eef15bd` before planning, and two of my own issue
texts were wrong.** Both corrections are recorded below rather than quietly
worked around — the issues get corrected as part of the work.

## T1 — #544: the console suite's 5s timeouts

### MY ISSUE TEXT IS PARTLY FALSE — correct it before fixing anything

#544 claims `apps/console/lib/platform-api.test.ts`'s `afterEach` "never calls
`vi.unstubAllGlobals()`". There are **two file-scope `afterEach` hooks**:

- **line 40** — `vi.unstubAllGlobals()`
- line 464 — `vi.unstubAllEnvs()`, `vi.resetModules()`, `vi.doUnmock(...)`

Vitest runs both. So globals ARE restored after every test, and the mechanism the
issue asserts does not hold as written. I read the second hook and missed the
first.

### What survives, and is still worth fixing

- The **load-dependent 5s timeouts are real**: five consecutive full runs during
  review gave 3 green, one with 4 timeouts, one with 1 — in *different files each
  time*, durations swinging 46s → 132s.
- `apps/console/vitest.config.ts` genuinely sets **no** `testTimeout`,
  `unstubGlobals` or `restoreMocks`.
- The reviewer DID reproduce a `Body has already been read` cascade — but under
  an artificial `--testTimeout=25`, which is a different regime from a real 5s
  timeout under load. **The cascade is real; the explanation is not established.**

### The task

1. **Investigate the cascade properly** and establish its actual mechanism before
   changing anything. If it turns out the artificial-timeout cascade cannot occur
   at a 5s timeout, say so — that is a finding, not a failure.
2. Fix what the evidence supports. A `testTimeout` floor reflecting the suite's
   real spread is the likeliest genuine fix; `unstubGlobals`/`restoreMocks` in
   the config are cheap defence regardless.
3. **Correct #544** with what was actually found.

Do not implement a fix for the mechanism as the issue currently describes it.

## T2 — #545 + #547 (batched; both are apps/console test-surface work)

### #545 — widen the server-component web-import guard

`apps/console/lib/server-component-web-import.guard.test.ts` walks
`APP_ROOT = <console>/app` and filters `.endsWith(".tsx")`. So `lib/`,
`components/` and every `.ts` file are unguarded.

This guards a bug class that **already caused a production outage** (#539) and
that `next build` does not catch. `lib/` is where the server-side data modules
live, so a `lib/*.ts` pulling in a `"use client"` barrel reintroduces it one hop
upstream, invisibly.

Widen to `lib/` and `components/`, and to `.ts` as well as `.tsx`. **If widening
surfaces an existing violation, that is the finding — report it, do not narrow
the guard back to hide it.**

### #547 — make the encoding bypass hard to reintroduce

DECIDED: **test + comment, inside `apps/console`.** No branded type — that would
change `capabilityForPath`'s signature in `console-core`, which `apps/web` and the
mobile app also consume, and neither has this middleware.

- A test asserting `CONSOLE_PATHNAME_HEADER` has exactly **one writer** (a second
  gate consumer is the reintroduction path).
- Composition rows for encoded paths where they belong.
- A pointer on `capabilityForPath` in `route-access.ts` naming the normalisation
  requirement and `console-pathname.ts`. **Doc comment only — no signature
  change, no behaviour change in console-core.**

## T3 — #546: an unfederated product should read as "not switched on"

### MY ISSUE TEXT OVERSTATED THE WORK — it is console-only

I filed this as needing a `platform-api` Go change. It does not.
`fetchPlatformSources()` (`lib/platform-api.ts`) already returns
`{ endpoints, entities }` — which products declare which endpoint ids and entity
types — and `slugsDeclaring()` (`lib/platform-sources.ts`) reads it.

**There is an established house pattern for exactly this**:
`app/(console)/platform/onboarding/page.tsx` (~line 200) and
`onboarding/sessions/page.tsx` (~line 302) both fetch sources, compute
`declared`, and render "not switched on" rather than firing a request that fails.

### The task

Apply that pattern to the generic surfaces, so a product that this deployment
does not federate renders calmly instead of as an outage:

- `app/(console)/[product]/page.tsx` — before/instead of a `kpis` read that would
  400 on `ErrUnknownSource`
- `app/(console)/[product]/[entity]/page.tsx` — same for `entities`

Follow the onboarding pages' shape rather than inventing a second one.

**Out of scope:** the platform-api half — `{}` from a deviating product still
surfaces as 503, and `ErrUnknownSource` is still a 400 on the wire. Those stay on
#546 for a Go change later; this task stops the console *rendering* them wrongly.
Kora's bespoke pages have the same gap and are also out of scope — they are not
what #543 touched, and widening into them re-opens a decision already made.

## Global constraints

- **Comment accuracy.** This estate's documented recurring defect is comments
  stating a reason that is not the real reason. It appeared in three of #543's
  five tasks, and one fix for it introduced two fresh count errors. Verify every
  mechanism before asserting it; count anything you assert a count about.
- Do not weaken an existing assertion to make something pass.
- Do not touch `apps/web`. Do not change `console-core`'s runtime behaviour.
- **pnpm, not npm.** Rebuild `@tesserix/console-core` before running console tests.
