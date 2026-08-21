# A session with no token row should offer re-auth, not report failure

**Issue:** #300
**Status:** draft — one decision taken below and argued; everything else follows from it.

## The condition, stated precisely

`getPlatformApiToken()` returns null for a session that is otherwise **completely
valid**: the cookie verifies, `middleware.ts` admits it, the operator holds every
capability. There is simply no usable row in `operator_api_tokens`.

`lib/platform-api.ts` then throws:

```
tickets: this session carries no platform API access token (ADR-003 D8)
```

which reaches the operator as a surface error. It is accurate, and useless: it
names an ADR and a missing token, and never says that signing in again fixes it
in ten seconds.

**Reproduced live on 2026-08-21.** An operator hit exactly this on the tickets
surface. The store was healthy throughout — key present, database reachable, no
error in any log — because nothing had failed. The session was simply orphaned.
Signing out and back in fixed it immediately.

## Why this is worth doing now rather than later

The number of ways in keeps growing, and every platform-API migration adds more:

1. A session minted by `apps/web` — valid at the console by design, never carries a `sid`.
2. The callback's 2s write deadline lost its race, or Postgres blipped.
3. `OPERATOR_TOKEN_ENCRYPT_KEY` absent at mint time.
4. A session that outlived a deploy whose row was pruned or deleted.
5. #304's state before the refresh grant existed — a stored token that could not be renewed.
6. #306's sign-out that left the IdP session alive, so a "fresh" login silently reused the old identity.
7. A mobile session, which never went through the OIDC callback at all.

All seven land on the same screen. **One remedy covers all seven**, because the
condition to test is "no usable token row", not any particular cause.

And the blast radius grew today: the CRM queues joined tickets on the platform-API
path, so an orphaned session now loses the operator's main work queue, not just
one surface.

## DECISION — an inline prompt, not an automatic redirect

#300 proposes "a redirect (or an inline prompt) into `/auth/login?returnTo=…`".
**Take the inline prompt. Do not redirect automatically.**

The argument is not preference, it is this estate's own history.

An automatic redirect needs a loop guard, because `/auth/login` → Zitadel →
callback → still no row → redirect again is infinite. #296 already built that
guard for a different case, and its module comment records what it cost to learn:

> A new callback talking to an OLD login pod gets a two-segment `state` back with
> no retry flag, so the guard reads "not yet retried" on every trip and the retry
> stops being one-shot. Zitadel already has a session by then, so the bounce is
> instant and the browser spins — the ERR_TOO_MANY_REDIRECTS this whole
> investigation started from.

That guard is default-OFF to this day, and its documented precondition for
enabling is a **live-system state** — every pod behind `deploy/console` running
the image that contains the writer — not "the PR merged". The console has already
been down for a day with `ERR_TOO_MANY_REDIRECTS`.

An inline prompt cannot loop. It has no rolling-update ordering hazard, needs no
master switch, no `state` plumbing, and no precondition ceremony to turn on. It
costs the operator one click, and it keeps them in context: they can see WHICH
surface failed rather than being thrown to a login page with no explanation.

There is a second reason, particular to this console. The failure can strike
several calls in ONE render — the CRM page composes two queues plus a handoff
list under `Promise.allSettled`, deliberately so one failure does not blank the
others. A redirect fired from inside one of several concurrent server-component
renders is a race; a prompt is just a state the page can render once.

**Rejected: auto-redirect after a countdown.** That is a loop with extra steps
and a worse failure mode — it takes the decision away from the operator at
exactly the moment the system has proved it cannot be trusted to persist things.

## What must be built

### 1. A machine-readable signal, not a message match

Today the only evidence is the string `"this session carries no platform API
access token"`. Matching on prose is how the console's error layers already
became brittle. The seam must raise something a caller can test — a distinct
error class or a code on `PlatformApiError` — so the page can distinguish:

| condition | operator sees |
|---|---|
| **no usable token row** | the re-auth prompt |
| API returned 401/403 | a permissions error — signing in again will not help |
| API unreachable / 5xx | a genuine failure — "try again" is honest here |
| origin not configured | a deployment error, not the operator's problem |

Conflating these is the current bug in a new costume. Each must remain
distinguishable, and the re-auth prompt must appear **only** for the first.

### 2. A `SurfaceState` for it

`components/kit/surface-state.ts` already carries a vocabulary — `ready`,
`loading`, `empty`, `filtered-empty`, `error`, `instrumentation-unavailable`.
Add one kind for this condition rather than overloading `error`.
`instrumentation-unavailable` is the precedent: a state that is not an error and
must not read as one.

### 3. The prompt itself

- Says plainly that the session cannot reach the platform API and that signing in
  again will restore it. No ADR references, no token vocabulary.
- Links to `/auth/login?returnTo=<current path and query>` so the operator lands
  back where they were, not on the console root.
- Renders **once per page**, even when several calls fail together.

### 4. Rendered where the failure happens

Tickets and the CRM queues both. It must not become a middleware-level
redirect — see the decision above.

## Explicitly out of scope

- **Fixing any of the seven causes.** This is the remedy, not the cure. #306's
  sign-out fix and #304's refresh grant addressed two causes on their own merits;
  the others remain, and this prompt is what makes any of them survivable.
- **Writing a token row on the fly.** The console cannot mint one without a fresh
  OIDC exchange, which is what signing in again is.
- **Changing `middleware.ts`.** It is zero-I/O on every request by design and must
  stay that way; it cannot know whether a row exists without a database read.

## How this is verified

The condition is reproducible without waiting for a natural orphan: delete the
row for a live session (`DELETE FROM operator_api_tokens WHERE sid = …`) and load
a platform-API surface. That is exactly the state an operator hit today.

- with a row: surfaces render normally, no prompt
- row deleted: the prompt appears, naming the surface, with a working `returnTo`
- after signing in again: the row is rewritten and the surface renders
- a 401 from the API still shows a permissions error, NOT the prompt
- a 5xx from the API still shows a failure, NOT the prompt

The last two are the ones worth writing tests for first: they are how this fix
turns into a different silent-wrong-answer.
