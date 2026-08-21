# Re-auth Prompt for a Session With No Token Row — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a valid console session has no usable `operator_api_tokens` row, show the operator a prompt that signing in again will fix it — instead of a generic failure message they cannot act on.

**Architecture:** A structural marker on the thrown error travels to the existing `SurfaceState` machinery, which gains one new kind. No redirect, no loop guard, no middleware change. Four small layers: the error carries a marker, `surface-state.ts` reads it, `states.tsx` renders it, the pages pass a `returnTo`.

**Tech Stack:** Next.js 16, TypeScript, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-21-no-token-row-reauth.md`

## Global Constraints

- **The signal is STRUCTURAL, never a message match.** `toSurfaceError` is deliberately structural rather than `instanceof` — `surface-state.ts` must stay free of `lib/` imports, and `instanceof` can fail silently across a bundler boundary. Matching on prose is how this console's error layers already became brittle.
- **The prompt appears ONLY for "no usable token row".** A 401/403 must still read as a permissions problem, a 5xx as a real failure, a 501 as `instrumentation-unavailable`, and a missing origin as a deployment error. Conflating any of these is the original bug in a new costume — and it is the way this fix turns into a new silent-wrong-answer.
- **No automatic redirect.** Decided in the spec: an auto-redirect needs a loop guard, and this console has already been down for a day with `ERR_TOO_MANY_REDIRECTS`. #296's guard for the analogous case is default-OFF to this day.
- **`platform-api-error.ts` must keep ZERO imports.** Its header explains why: it is a class used as a value, and a client component importing it from `lib/platform-api.ts` once dragged `pg` into the browser bundle. Do not add an import to it, and do not declare a second copy of the class anywhere.
- **`middleware.ts` stays zero-I/O.** It cannot know whether a row exists without a database read.
- Comments explain WHY, not what. Single-line conventional commits, no signature or co-author trailers.
- Before merging, run `npx next build` in `apps/console` — `tsc` resolves modules but does not bundle them.

---

### Task 1: The error carries a structural marker

**Files:**
- Modify: `apps/console/lib/platform-api-error.ts`
- Modify: `apps/console/lib/platform-api.ts` (the null-token throw, ~line 216)
- Test: `apps/console/lib/platform-api.test.ts`

**Interfaces:**
- Produces: `PlatformApiError` with a `readonly noOperatorToken: boolean` property, defaulting to `false`, settable through the existing options argument. Consumed by Task 2.

**Why a boolean marker and not a code string:** the codebase already has this exact pattern — `MalformedCursorError` carries `malformedCursor = true` and `dbReadError` keys on it. One established spelling for "a marker a structural reader can test" is worth more than a second vocabulary.

- [ ] **Step 1: Write the failing test**

Append to `apps/console/lib/platform-api.test.ts`:

```ts
describe("the no-operator-token signal", () => {
  it("marks the error when the session has no token row", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withToken(null);
    const { platformRequestWithMeta, PlatformApiError } = await import("./platform-api");
    const caught = await platformRequestWithMeta("tickets", "/v1/tickets").catch((e) => e);
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect(caught.noOperatorToken).toBe(true);
  });

  it("does NOT mark an ordinary API failure", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withToken("access-token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "nope" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { platformRequestWithMeta } = await import("./platform-api");
    const caught = await platformRequestWithMeta("tickets", "/v1/tickets").catch((e) => e);
    expect(caught.status).toBe(403);
    expect(caught.noOperatorToken).toBe(false);
  });

  it("does NOT mark a missing origin", async () => {
    delete process.env.PLATFORM_API_ORIGIN;
    const { platformRequestWithMeta } = await import("./platform-api");
    const caught = await platformRequestWithMeta("tickets", "/v1/tickets").catch((e) => e);
    expect(caught.noOperatorToken).toBe(false);
  });
});
```

`withToken` is the existing helper in that file for stubbing `getPlatformApiToken`. Use it exactly as the surrounding tests do; if it does not accept `null`, extend it minimally rather than inventing a second helper.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/console && npx vitest run lib/platform-api.test.ts -t "no-operator-token"`
Expected: FAIL — `noOperatorToken` is `undefined`, not `true`/`false`.

- [ ] **Step 3: Add the marker to the error class**

In `apps/console/lib/platform-api-error.ts`, extend the class. **Do not add any import.**

```ts
/** Options a thrower may attach beyond the standard `cause`. */
export interface PlatformApiErrorOptions extends ErrorOptions {
  /**
   * True ONLY for "this session has no usable operator token row" — a valid
   * session that simply cannot authenticate to the platform API, which signing
   * in again fixes.
   *
   * A marker rather than a code string, matching `MalformedCursorError`'s
   * `malformedCursor` — one spelling for "a structural reader can test this",
   * not two. It is read structurally (see `toSurfaceError`), never with
   * `instanceof`, because the reader must stay free of `lib/` imports and an
   * `instanceof` across a bundler boundary can fail silently.
   *
   * It must NOT be set for a 401, a 403, a 5xx, or an unconfigured origin.
   * Those are different problems with different remedies, and collapsing them
   * into "sign in again" is the same unactionable answer this marker exists to
   * replace.
   */
  noOperatorToken?: boolean;
}

export class PlatformApiError extends Error {
  readonly status?: number;
  readonly noOperatorToken: boolean;

  constructor(message: string, status?: number, options?: PlatformApiErrorOptions) {
    super(message, options);
    this.name = "PlatformApiError";
    this.status = status;
    this.noOperatorToken = options?.noOperatorToken === true;
  }
}
```

- [ ] **Step 4: Set it at the one place it is true**

In `apps/console/lib/platform-api.ts`, find the throw for the null token (message contains `this session carries no platform API access token`) and add the marker:

```ts
  if (!token) {
    throw new PlatformApiError(
      `${label}: this session carries no platform API access token (ADR-003 D8)`,
      undefined,
      { noOperatorToken: true },
    );
  }
```

Change nothing else. In particular do NOT set it on the missing-origin throw above it — that is a deployment error, not something signing in again fixes.

- [ ] **Step 5: Run the whole file**

Run: `cd apps/console && npx vitest run lib/platform-api.test.ts`
Expected: PASS, including every pre-existing test. A pre-existing failure means the constructor change broke a caller — fix the change, not the test.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/platform-api-error.ts apps/console/lib/platform-api.ts apps/console/lib/platform-api.test.ts
git commit -m "feat(console): mark the error a session with no operator token row raises"
```

---

### Task 2: `surface-state` learns the condition

**Files:**
- Modify: `apps/console/components/kit/surface-state.ts`
- Test: `apps/console/components/kit/surface-state.test.ts` — **this file already exists**; APPEND the new describe block, leave every existing test untouched

**Interfaces:**
- Consumes: the `noOperatorToken` marker from Task 1, read structurally.
- Produces: `SurfaceError.reauthRequired?: boolean`, and a new `SurfaceState` member `{ kind: "reauth-required" }`. Consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveState, toSurfaceError, NOT_IMPLEMENTED } from "./surface-state";

describe("the reauth-required state", () => {
  it("reads the marker structurally off a thrown error", () => {
    const err = toSurfaceError({ message: "no token", noOperatorToken: true });
    expect(err?.reauthRequired).toBe(true);
  });

  it("does not set it for an ordinary error", () => {
    expect(toSurfaceError({ message: "boom", status: 500 })?.reauthRequired).toBeFalsy();
  });

  it("resolves to reauth-required", () => {
    expect(
      resolveState({ isLoading: false, error: { reauthRequired: true }, rows: [], filtered: false }),
    ).toEqual({ kind: "reauth-required" });
  });

  it("prefers reauth-required over the generic error state", () => {
    const state = resolveState({
      isLoading: false,
      error: { reauthRequired: true, message: "this session carries no platform API access token" },
      rows: [],
      filtered: false,
    });
    expect(state.kind).toBe("reauth-required");
  });

  it("leaves 501 as instrumentation-unavailable, not reauth", () => {
    const state = resolveState({
      isLoading: false,
      error: { status: NOT_IMPLEMENTED },
      rows: [],
      filtered: false,
    });
    expect(state.kind).toBe("instrumentation-unavailable");
  });

  it("leaves 403 as an error, not reauth", () => {
    const state = resolveState({
      isLoading: false,
      error: { status: 403, message: "forbidden" },
      rows: [],
      filtered: false,
    });
    expect(state.kind).toBe("error");
  });

  it("still shows loading before anything else", () => {
    const state = resolveState({
      isLoading: true,
      error: { reauthRequired: true },
      rows: [],
      filtered: false,
    });
    expect(state.kind).toBe("loading");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/console && npx vitest run components/kit/surface-state.test.ts`
Expected: FAIL — `reauthRequired` is not a property and `"reauth-required"` is not a kind.

- [ ] **Step 3: Implement**

In `apps/console/components/kit/surface-state.ts`:

Add to the `SurfaceState` union, beside `instrumentation-unavailable`:

```ts
  /**
   * A valid session that cannot authenticate to the platform API, because it
   * has no usable row in `operator_api_tokens`.
   *
   * Its own kind rather than an `error`, for the same reason
   * `instrumentation-unavailable` is: this is not a failure and must not read
   * as one. Nothing is broken, nothing needs retrying, and the remedy is a
   * ten-second one the operator can perform — which the generic error copy
   * never mentions. See #300.
   */
  | { kind: "reauth-required" }
```

Add to `SurfaceError`:

```ts
  /**
   * Set when the producer signalled "this session has no usable operator token
   * row". Read STRUCTURALLY off the caught value — never `instanceof` — for the
   * reason given on `toSurfaceError`.
   */
  reauthRequired?: boolean;
```

In `toSurfaceError`'s object branch, read the marker alongside `status` and `message`:

```ts
    const candidate = caught as {
      status?: unknown;
      message?: unknown;
      noOperatorToken?: unknown;
    };
    return {
      status: typeof candidate.status === "number" ? candidate.status : undefined,
      // Strict `=== true`: a truthy non-boolean must not promote an ordinary
      // failure into "sign in again", which would send the operator to do
      // something that cannot help.
      reauthRequired: candidate.noOperatorToken === true,
      message:
        typeof candidate.message === "string" ? candidate.message : FALLBACK_ERROR_MESSAGE,
    };
```

In `resolveState`, test it **first inside the error branch**, before the 501 check:

```ts
  if (input.error) {
    // Before the 501 check and before the generic error: this condition carries
    // no status of its own, and the operator's remedy is different from every
    // other failure's. Ordering it first also means a future error that somehow
    // carried both signals resolves to the one with an action attached.
    if (input.error.reauthRequired) {
      return { kind: "reauth-required" };
    }
    if (input.error.status === NOT_IMPLEMENTED) {
```

- [ ] **Step 4: Run and watch pass**

Run: `cd apps/console && npx vitest run components/kit/surface-state.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run every consumer's tests**

Run: `cd apps/console && npx vitest run components/kit/`
Expected: PASS. The union gained a member, so any exhaustive `switch` without a `default` will fail to typecheck — that is Task 3's job, but a runtime test failure here means something else broke.

- [ ] **Step 6: Commit**

```bash
git add apps/console/components/kit/surface-state.ts apps/console/components/kit/surface-state.test.ts
git commit -m "feat(console): resolve a session with no operator token row to its own surface state"
```

---

### Task 3: Render the prompt

**Files:**
- Modify: `apps/console/components/kit/states.tsx`
- Test: `apps/console/components/kit/states.render.test.tsx` — **this file already exists**; APPEND the new describe block, leave every existing test untouched

**Interfaces:**
- Consumes: `{ kind: "reauth-required" }` from Task 2.
- Produces: `SurfaceStateViewProps.reauthReturnTo?: string`. Consumed by Task 4.

**Shape:** a `Callout`, like `instrumentation-unavailable` — deliberately neither `EmptyState` nor `ErrorState`. Nothing is broken and nothing is empty; the operator simply needs to sign in again.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SurfaceStateView } from "./states";

describe("SurfaceStateView — reauth-required", () => {
  it("tells the operator that signing in again restores the surface", () => {
    render(<SurfaceStateView state={{ kind: "reauth-required" }} emptyMessage="no tickets" />);
    expect(screen.getByRole("link", { name: /sign in again/i })).toBeInTheDocument();
  });

  it("returns the operator to where they were", () => {
    render(
      <SurfaceStateView
        state={{ kind: "reauth-required" }}
        emptyMessage="no tickets"
        reauthReturnTo="/platform/crm?stage=new"
      />,
    );
    expect(screen.getByRole("link", { name: /sign in again/i })).toHaveAttribute(
      "href",
      "/auth/login?returnTo=%2Fplatform%2Fcrm%3Fstage%3Dnew",
    );
  });

  it("falls back to a bare login link when no returnTo is given", () => {
    render(<SurfaceStateView state={{ kind: "reauth-required" }} emptyMessage="no tickets" />);
    expect(screen.getByRole("link", { name: /sign in again/i })).toHaveAttribute(
      "href",
      "/auth/login",
    );
  });

  it("does not name a token, an ADR, or a database row", () => {
    const { container } = render(
      <SurfaceStateView state={{ kind: "reauth-required" }} emptyMessage="no tickets" />,
    );
    expect(container.textContent).not.toMatch(/token|ADR-003|operator_api_tokens/i);
  });

  it("is not an error state — it offers no retry", () => {
    render(
      <SurfaceStateView
        state={{ kind: "reauth-required" }}
        emptyMessage="no tickets"
        onRetry={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /retry|try again/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/console && npx vitest run components/kit/states.render.test.tsx`
Expected: FAIL — no such link; the switch has no case for the kind.

- [ ] **Step 3: Implement**

Add `reauthReturnTo?: string` to `SurfaceStateViewProps` with a comment saying the page supplies it because only the page knows its own path.

Add the case to the switch, after `instrumentation-unavailable`:

```tsx
    case "reauth-required":
      // A Callout, like instrumentation-unavailable and for the same reason:
      // this is not a failure. Nothing is broken and a retry cannot help — the
      // session is valid but holds no credential for the platform API, and only
      // a fresh sign-in mints one. An ErrorState would offer a retry button
      // that does nothing, which is worse than the generic message this
      // replaces.
      return (
        <Callout variant="warning" role="status">
          <div className="flex items-start gap-2">
            <LogIn className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <CalloutTitle>Sign in again to load this</CalloutTitle>
              <CalloutDescription>
                {/* No token vocabulary, no ADR number: the operator cannot act
                    on either, and naming them is what made the old message
                    useless. */}
                This session can no longer reach the platform. Signing in again
                restores it — nothing is lost.{" "}
                <Link
                  href={
                    reauthReturnTo
                      ? `/auth/login?returnTo=${encodeURIComponent(reauthReturnTo)}`
                      : "/auth/login"
                  }
                  className="underline underline-offset-4"
                >
                  Sign in again
                </Link>
              </CalloutDescription>
            </div>
          </div>
        </Callout>
      );
```

Import `LogIn` from `lucide-react` beside the existing icon imports, and `Link` from `next/link`. Use whatever `CalloutTitle`/`CalloutDescription` spelling the `instrumentation-unavailable` case already uses in this file — match it exactly rather than introducing a variant.

- [ ] **Step 4: Run and watch pass**

Run: `cd apps/console && npx vitest run components/kit/states.render.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/components/kit/states.tsx apps/console/components/kit/states.render.test.tsx
git commit -m "feat(console): offer a sign-in prompt when the session cannot reach the platform API"
```

---

### Task 4: Wire the surfaces that can hit it

**Files:**
- Modify: `apps/console/app/(console)/platform/tickets/page.tsx`
- Modify: `apps/console/app/(console)/platform/crm/queue-view.tsx`
- Modify: `apps/console/app/(console)/platform/crm/page.tsx`
- Test: the existing page tests for both surfaces.

**Interfaces:**
- Consumes: `reauthReturnTo` from Task 3.

**The composition requirement:** the CRM page renders two queues plus a handoff list under `Promise.allSettled`. When the session has no token row, ALL of them fail with the same condition. The prompt must appear **once**, not three times. Pass `reauthReturnTo` to each `SurfaceStateView`, but ensure the page does not stack three identical callouts — if the existing layout would, render the prompt once above the groups and suppress the per-group state for this kind specifically.

- [ ] **Step 1: Write the failing test for the CRM page**

Add to `apps/console/app/(console)/platform/crm/page.test.tsx`, matching the file's existing mock style:

```tsx
it("shows one sign-in prompt, not three, when the session has no platform token", async () => {
  const noToken = Object.assign(new Error("no token"), { noOperatorToken: true });
  const { fetchDueQueue, fetchDriftingQueue } = await import("@/lib/crm-queues");
  vi.mocked(fetchDueQueue).mockRejectedValue(noToken);
  vi.mocked(fetchDriftingQueue).mockRejectedValue(noToken);

  render(await CrmPage({ searchParams: Promise.resolve({}) }));

  expect(screen.getAllByRole("link", { name: /sign in again/i })).toHaveLength(1);
});
```

Adapt the render call to however this test file already invokes the page — do not change its existing harness.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/console && npx vitest run "app/(console)/platform/crm/page.test.tsx" -t "sign-in prompt"`
Expected: FAIL — either no link at all, or three.

- [ ] **Step 3: Implement**

Pass `reauthReturnTo` from each page. The path comes from what the page already knows about its own route and search params; build it as the pathname plus the serialised query so a filtered view returns filtered.

Handle the once-only requirement explicitly. The simplest correct shape: compute whether any group resolved to `reauth-required`, render the prompt once above them if so, and render the remaining groups' non-reauth states as normal.

- [ ] **Step 4: Run both surfaces' tests**

Run:
```bash
cd apps/console && npx vitest run "app/(console)/platform/crm/page.test.tsx" "app/(console)/platform/tickets/page.test.tsx"
```
Expected: PASS, including every pre-existing test unchanged.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/(console)/platform/tickets/page.tsx" "apps/console/app/(console)/platform/crm/queue-view.tsx" "apps/console/app/(console)/platform/crm/page.tsx" "apps/console/app/(console)/platform/crm/page.test.tsx"
git commit -m "feat(console): show the sign-in prompt on the surfaces that need a platform token"
```

---

### Task 5: The gates

**Files:** none created.

- [ ] **Step 1: Full suite**

Run: `cd apps/console && npx vitest run`
Expected: PASS. Note the count; it must be at least the 1555 that passed before this work, plus the new tests.

- [ ] **Step 2: Typecheck**

Run: `cd apps/console && npx tsc --noEmit`
Expected: clean. A non-exhaustive `switch` over `SurfaceState` shows up here — the union gained a member.

- [ ] **Step 3: Lint**

Run: `cd apps/console && npx eslint .`
Expected: zero problems. CI runs `--max-warnings 0`, so a warning fails the build.

- [ ] **Step 4: Build**

Run: `cd apps/console && npx next build`
Expected: succeeds. `states.tsx` is `"use client"` and now imports `next/link`; the build is what proves nothing server-only was dragged across.

- [ ] **Step 5: Confirm the distinctions still hold**

Run: `cd apps/console && npx vitest run components/kit/surface-state.test.ts --reporter verbose`
Expected: the "leaves 501 as instrumentation-unavailable", "leaves 403 as an error" and "does not set it for an ordinary error" tests all listed as passing. These are the ones that prove this fix did not become a new silent-wrong-answer.

---

## Post-merge verification (against the live console)

The condition is reproducible without waiting for a natural orphan:

1. Sign in. Confirm `/platform/crm` and `/platform/tickets` render.
2. `DELETE FROM operator_api_tokens WHERE sid = '<your sid>';`
3. Reload `/platform/crm`. Expect **one** sign-in prompt, not three, with a `returnTo` carrying the current filters.
4. Follow it. Expect to land back on the same filtered view, working.
5. Confirm a genuinely broken platform API (scale it to zero briefly) still shows a failure, NOT the prompt.

Step 5 is the one worth doing: it is the difference between this fix and a new way to mislead an operator.
