# T1 — #544: the console suite's 5s timeouts

Worktree `th-wt-fu`, branch `fix/console-followups-544-547`.
Machine: 14-core darwin, `pnpm`, `@tesserix/console-core` rebuilt before every run.

## Headline

Two things in #544 are wrong and one thing nobody had is now established.

- **Wrong (mine):** the claim that `lib/platform-api.test.ts`'s `afterEach`
  "never calls `vi.unstubAllGlobals()`". It does, at line 40. There are two
  file-scope `afterEach` hooks and Vitest runs both.
- **Wrong (the suggested fix):** `vi.unstubAllGlobals()` would not have fixed
  the cascade even if it had been missing. Proven with a minimal reproduction
  that carried that exact hook and cascaded anyway.
- **New:** the cascade is real **at a realistic timeout**, and its realistic
  signature is *not* `Body has already been read`. Under load it surfaced as a
  wrong-URL `AssertionError` in the neighbouring test. Same root mechanism,
  different symptom, and the symptom the reviewer reproduced only appears at
  artificially small timeouts.

## Hypotheses and how each was tested

### H1 — "the timeouts are load-induced, not a slow-test defect"

**Confirmed.** A full green run, per-test durations from the JSON reporter:

```
$ pnpm vitest run --reporter=json --outputFile=run1.json
real 79.63   4133 tests, 0 failed
p50 0.37ms   p90 24ms   p99 497ms   p999 1292ms   max 2011ms
over 500ms: 41    over 1000ms: 9    over 2000ms: 2
```

Slowest five:

| ms | test |
|---|---|
| 2011 | `app/auth/callback/route.test.ts` — writing the platform API tokens to the store |
| 2002 | `app/auth/logout/route.test.ts` — revoking platform API access on sign-out |
| 1541 | `lib/billing/bootstrap.test.ts` — planBootstrap 3 products / 42 prices |
| 1463 | `lib/db/promo-codes.integration.test.ts` — re-runnability |
| 1337 | `app/(console)/platform/crm/[organisation]/actions.contact-activity.integration.test.ts` |

The three files #544 names as victims each have exactly **one** slow test and
nothing else near it:

```
lib/platform-api.test.ts                                 66 tests  max 1073  next 415,142,120,84
lib/redirect-origin.guard.test.ts                         2 tests  max  587  next 41
lib/db/plan-catalog-parity-runs-source.integration.test.ts 17 tests max  843  next 6,5,3,2
```

That is the explanation for "the victim file differs every run": there are 41
candidates over 500ms, and whichever one is executing when the machine is busiest
is the one that crosses 5000ms. No single test is defective.

### H2 — "a real 5000ms timeout is reachable on this suite"

**Confirmed by direct reproduction.** Ran the three named victim files against 14
concurrent busy loops on a 14-core machine, at the stock 5000ms:

```
$ for i in $(seq 1 14); do (busy loop) & done
$ pnpm vitest run --reporter=json lib/redirect-origin.guard.test.ts \
    lib/platform-api.test.ts lib/db/plan-catalog-parity-runs-source.integration.test.ts
real 233.39   82 passed / 3 failed — all three "Test timed out in 5000ms"

  9818ms  lib/redirect-origin.guard.test.ts   > finds no unguarded uses outside the helper   (587ms unloaded, 16.7x)
  7541ms  lib/platform-api.test.ts            > does not narrow the summary when the listing is filtered
  7207ms  lib/platform-api.test.ts            > composes the queue from two resources when it is set
```

Note which tests in `platform-api.test.ts` are slow enough to time out: both are
in `describe("the platform API switch")`, which does `vi.resetModules()` in its
`afterEach` and then `await import("./platform-api")`. That re-transform is the
macrotask that stalls under contention — not the fetch.

### H3 — "the `Body has already been read` cascade is an artefact of the 25ms timeout"

**Confirmed, then superseded.** Timeout sweep on `lib/platform-api.test.ts`,
counting occurrences of the string in the JSON report:

| `--testTimeout` | failed tests | `Body has already been read` |
|---|---|---|
| 25ms | 27 | **2** |
| 50ms | 10 | 0 |
| 100ms | 4 | 0 |
| 200ms | 5 | 0 |
| 400ms | 3 | 0 |
| 800ms | 0 | 0 |
| 1600ms | 0 | 0 |

Zero at 50ms and above, and **zero in the loaded 5000ms run above** despite three
genuine timeouts. So the reviewer's exact signature does not occur at a realistic
timeout — it needs the abandoned test's neighbour to be one of the 24
`mockResolvedValue(new Response(...))` sites, which hands the *same* `Response`
instance to every caller.

### H4 — "the cascade mechanism is a leaked pre-fetch continuation"

**Proven** with a minimal reproduction (`lib/zz-repro.test.ts`, since deleted).
It deliberately carried the `afterEach(() => vi.unstubAllGlobals())` that #544
says is missing:

```ts
afterEach(() => { vi.unstubAllGlobals(); });

async function call(label: string) {
  await preFetchAwait();                       // stands in for the token read / await import()
  const res = await globalThis.fetch(label);
  return res.json();
}

it("A: cut off while awaiting BEFORE its fetch", async () => {
  stall = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  await call("A");
}, 20);

it("B: the victim", async () => {
  const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), {...}));
  vi.stubGlobal("fetch", mock);
  await new Promise((r) => setTimeout(r, 150));
  expect(await call("B")).toEqual({ ok: 1 });
});
```

Result:

```
FAIL  A: cut off while awaiting BEFORE its fetch — Test timed out in 20ms.
FAIL  B: the victim — TypeError: Body is unusable: Body has already been read
```

**Mechanism, established:** a test abandoned *before* it reaches `fetch` leaves a
live continuation. When that continuation resumes it reads `globalThis.fetch`,
which by then is the **next** test's stub. It consumes that test's response.
`vi.unstubAllGlobals()` cannot prevent this — the continuation resumes after the
next test has installed its own stub, so there is nothing to unstub at the moment
that matters.

### H5 — "so at 5000ms the cascade cannot happen"

**Refuted — and this is the finding.** Re-running the loaded victim files after
raising the timeout to 15000ms produced:

```
 18028ms  lib/platform-api.test.ts > composes the queue from two resources when it is set
          Error: Test timed out                                      (line 493)
  7020ms  lib/platform-api.test.ts > does not narrow the summary when the listing is filtered
          AssertionError: expected 'http://platform-api.platform.svc.clus…' to contain 'status=open'
                                                                     (line 545)
 34344ms  lib/redirect-origin.guard.test.ts > finds no unguarded uses outside the helper
          Error: Test timed out
```

The middle failure took **7020ms against a 15000ms budget** — it did not time
out. It failed because the test immediately above it timed out and its leaked
continuation pushed a URL into *this* test's `seen[]` array, so `seen[0]` was the
previous test's request.

That is the same mechanism as H4, at a realistic timeout, producing a second
failure that names an innocent test — exactly the cost #544 was filed about. The
signature is a **wrong-URL AssertionError**, not `Body has already been read`,
because the tests that actually stall long enough are the `await import()` ones,
whose neighbours build a fresh `Response` per call and capture into `seen[]`.

The same shape at 25ms is visible in the sweep output:

```
FAIL the AI usage reads > sends the window and parses the totals
AssertionError: expected 'http://platform-api…/v1/audit?limit=200&since_hours=720'
                to contain '/v1/ai/usage/summary?window=7d'
```

### H6 — "`restoreMocks: true` is free defence"

**Refuted.** With `restoreMocks: true` the full suite goes 4130 passed / **3
failed**, in `lib/crm-queues.test.ts` and
`app/(console)/platform/billing/catalog/authoring-panel.render.test.tsx`. Not
added. Reverted.

## What changed

### `apps/console/vitest.config.ts`

- **`testTimeout: 15_000`.** Justified from the measured spread: slowest unloaded
  test 2011ms, so the 5000ms default gives 2.5x headroom against a suite whose
  wall time is on record swinging 46s → 132s (2.9x). 2011 × 2.9 = 5832ms — the
  default sits *below* the spread the suite already shows. 15000ms is 7.5x the
  slowest unloaded test. The comment states plainly that this is **not** a
  load-proof number and that no finite one is — the saturation runs stretched one
  test to 9818ms on one attempt and 34344ms on the next, which is what
  established the timeouts are load-induced, not what fixes the number.
- **`unstubGlobals: true`.** Green, no measurable cost. Its comment says
  explicitly that it is defence against a *different* bug class and does **not**
  fix the #544 cascade, and records why (verified with the H4 reproduction).

### `apps/console/lib/platform-api.test.ts`

A doc comment on the line-40 `afterEach` recording that it restores globals but
does not isolate tests, naming the leaked-continuation mechanism and the fact
that the real fix is a cancellation path through `platformCall`. **No behaviour
change** — no assertion touched, no hook added or removed.

## What was deliberately NOT done

- **No fix for the cascade itself.** Closing it properly needs an `AbortSignal`
  threaded through `platformCall` so a test can cancel its own in-flight request,
  or per-test module isolation. Both are substantial changes to production code
  and to ~40 stub sites in a 1450-line test file, out of proportion to this task.
  Raising the timeout makes the trigger rarer; it does not remove it. Recorded on
  #544.
- **No change to the 24 `mockResolvedValue(new Response(...))` sites.** They are
  the victim-side precondition for the `Body has already been read` variant only,
  which does not occur at a realistic timeout.
- `restoreMocks` — see H6.

## Verification

```
$ pnpm -r --filter "./packages/**" build      # console-core dist rebuilt
$ pnpm vitest run   (apps/console)
real 65.45   4133 passed / 0 failed
$ npx tsc --noEmit                            # clean
```

Baseline before the change was 4133 / 0 in 79.63s; after, 4133 / 0 in 65.45s.
The variation is machine load, not the change — a timeout budget is only spent by
a failing test.

## Residual doubt

Why a test in `describe("fetchProductKpis")` — which has no dynamic import and
whose only pre-fetch await is a mocked, microtask-resolving `readTokenRecord()` —
timed out at 25ms is not fully explained. It is plausibly first-touch transform
work, but I did not instrument it, and I am not asserting it. It does not affect
the conclusions: the 25ms regime is not one this suite runs in, and the realistic
regime (H5) was reproduced directly.
