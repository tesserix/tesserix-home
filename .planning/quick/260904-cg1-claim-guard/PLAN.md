---
id: 260904-cg1
slug: claim-guard
date: 2026-09-04
issue: "none — process defect found across #543 and #552"
kind: quick
---

# A comment that asserts a countable fact should be checkable

## The defect this fixes

Across #543 and #552, **six comment claims were wrong, and every one was caught
by a reviewer rather than the author** — twice after the author had been warned
explicitly in the same session. In all six the *code was correct*; only the
sentence describing it was false.

| Claim | Truth | Verifiable by |
|---|---|---|
| "Kora's two pages were its only callers" | three | counting importers |
| "The two `import type`s below" | three | counting in the same file |
| "24 `mockResolvedValue(new Response(...))` sites" | 23 syntactic / 24 hazard | counting a pattern |
| "the `afterEach` at :464 never calls `unstubAllGlobals`" | a second `afterEach` at :40 does | counting `afterEach` |
| "`afterEach` in `describe(...)`" | file-scope, column 0 | checking scope |
| "a value import would close a runtime cycle" | `nav.ts` imports type-only; no cycle | checking import direction |

Each is one command the author did not run. Reviewers caught them because
reviewers check mechanism against code; authors verify behaviour and then
*assert* mechanism, and nothing checks the assertion.

## What was measured and rejected first

- **A stale `file:line` guard is not worth building.** Of 42 `file:line` refs in
  comments: 17 resolvable, **0 stale**, 6 ambiguous basenames, 18 pointing at
  other repos. It would catch nothing today.
- **Banning bare count claims** was rejected: a grep for them returns 242 hits of
  which nearly all are prose ("one product's rows"), so the false-positive rate
  would be intolerable in a codebase whose comments are deliberately long.

Recording both so nobody re-proposes them.

## The design

`apps/console/lib/claims.guard.test.ts` — an **opt-in** registry. A comment
asserting a countable or structural fact may register a check beside it. Prose
comments are untouched; only claims someone chose to pin carry any ceremony.

```ts
claim({
  file: "components/kit/entity-page.ts",
  says: "three Kora pages",        // substring that must still appear in `file`
  check: () => importersOf("kit/entity-page", "app/(console)/kora").length === 3,
});
```

### ANCHOR ON THE COMMENT TEXT, NOT A LINE NUMBER

`file:line` anchors rot on the first edit above them, and this repo has 42 such
refs already. `says` is a **substring that must still appear in `file`**, so:

- if the claim's sentence is rewritten or deleted, the guard fails and whoever
  changed it must update or drop the registration — the registry cannot silently
  outlive the comment it describes;
- if the underlying fact changes, `check` fails.

Both directions must fail loudly. A registry entry that passes when its comment
is gone is the same decorative-guard failure this exists to prevent.

## Tasks

### T1 — the harness and its helpers

- `claim({ file, says, check })`, driving one test per registration, named for
  the file and the claim so a failure says which sentence is wrong.
- The anchor assertion (`says` still present in `file`) is **separate** from
  `check`, so a failure distinguishes "the comment moved" from "the fact
  changed".
- Small, honest helpers — `importersOf(module, dir)`, `occurrencesOf(pattern,
  file)`, `linesMatching(pattern, file)`. Read from disk relative to the console
  root. **No dynamic `import()` of the module under inspection** — these are
  textual facts about source, and importing would run it.
- A vacuity assertion: the registry is non-empty and every entry's `file`
  exists.

### T2 — seed it with the real claims, at their corrected values

Register the claims from the table above **that still exist in shipped
comments**, using their corrected values. Anything whose comment was reworded
out of existence is not a seed — do not invent a comment to register.

**Each seed must be mutation-proved in both directions**: break the fact → the
`check` row reds; change the comment text → the anchor row reds. Record both
outputs.

## Global constraints

- **Comment accuracy** — the defect this very change addresses. Verify every
  mechanism before asserting it, and count anything you assert a count about,
  then re-count. A false claim inside the claim guard would be self-refuting.
- Do not weaken any existing assertion.
- Do not touch `apps/web`. Do not change `console-core` runtime behaviour.
- Do not modify the comments being registered except where a seed's value is
  genuinely wrong today.
- **pnpm, not npm.** Rebuild `@tesserix/console-core` before running console tests.
- The guard must be cheap: it reads source files, so keep it well under a second.
