# Managing the internal tools directory from the console

**Status:** approved — no open decisions.
**Follows:** #318 Phase 1, shipped as `8c266db`.
**Goal:** an operator holding `platform` can add, edit, remove and reorder
internal tools and their groups from the console, without a deploy and without
reaching for `curl`.

## Why now, and what this is really for

#318 Phase 1 already removed the pain it set out to remove: the directory lives
in `platform_tools`, and adding a tool is an API call rather than a code change
and a deploy. **This surface does not unlock that. It makes it usable, and it
retires a risk we knowingly took.**

Phase 1 shipped six write endpoints with no caller. The recorded cost of that
decision was that "write paths with no real caller tend to be wrong in ways
tests don't catch", and the final review proved it twice over: `PATCH
{"note": ""}` silently kept the old note, and `PATCH {}` wrote an audit row
claiming an update that never happened. Both were found by reading, not by
running. A real caller is what stops the next one being found in production.

## Decisions

### D1. Its own surface, not controls on the home cards

`/platform/tools`, reached from the rail, gated on `platform`.

The home cards are readable by every operator — Phase 1's final review moved
the two GET routes to `read` precisely so a `crm`-only operator would stop
seeing a false "Live directory unavailable" banner. Putting write affordances
on that same component would mean one component obeying two capability rules,
which is the exact drift that produced that defect. One surface owns the
writes; the directory stays a directory.

### D2. Tools AND groups, with the empty-group divergence made explicit

The management page renders **every** group, including empty ones, with a
"No tools in this group yet" row. The home page keeps skipping empty groups.

The two surfaces deliberately render the same data differently. The directory
is for reading, and a heading over nothing reads as a loading failure — that is
why `internal-tools.tsx` skips it, and the reason predates this work. The
management page is for editing, and a group you just created must be visible or
creating it appears to have silently failed. Both components carry a comment
saying so, because an undocumented divergence reads as a bug to whoever finds
it next.

### D3. Reordering is up/down, and the swap is not atomic

`sort_order` is changed by swapping with the neighbouring row: two PATCHes.

No drag-and-drop. The console has no `dnd-kit` today, a keyboard-accessible
fallback would be required anyway for the WCAG 2.1 AA baseline, and the list
changes a handful of times a year.

**The non-atomicity is accepted and stated rather than hidden.** If the second
PATCH fails, two rows share a `sort_order`. The API orders by
`g.sort_order, t.sort_order, t.name`, so the tie breaks by name and the page
still renders deterministically; the operator retries. A dedicated reorder
endpoint would make it atomic, and that is Go work outside this scope.

### D4. The surface is hidden when the platform API is switched off

`PLATFORM_API_ORIGIN` unset means the console serves the built-in literal and
there is nothing to write to. The route is absent from the rail, and a direct
visit renders a short explanation.

This keeps the rollback story honest: unsetting the variable returns the
console to its pre-#318 behaviour, in which this surface did not exist. Nothing
offers an action it cannot perform.

`source === "degraded"` — origin set, API unreachable — renders the same shape
with a different sentence. The two states are already distinguished by
`DirectorySource`, and conflating them here would repeat the defect that
three-valued `source` was introduced to fix.

## What this must not do

### It must not audit

`lib/crm-write.ts`'s `withCrmWrite` wraps `auditedOperation` because CRM writes
reach Postgres directly and nothing else records them. **Tools writes do not.**
The Go module records the audit row inside `write.Perform`'s transaction, bound
to the row change and the idempotency record. A console-side audit would put
**two rows in `console_audit_log` for one edit**, and the second would be the
less trustworthy of the pair — written outside the transaction that did the
work, and therefore able to survive a rollback.

So the write seam is a sibling of `withCrmWrite`, not a caller of it: session
check, capability check, API call, error mapping. No audit.

### It must not validate the subdomain client-side

The rule already exists twice — `domain.SubdomainPattern` in Go and the CHECK
constraint in migration 0031 — with `TestTheApiAndTheDatabaseRefuseTheSame
Subdomains` binding them together. A third copy in TypeScript would need its
own drift test and would rot the first time someone edited one of the other
two.

The form validates presence only. The API's 422 is the authority, and its
message renders under the field. The cost is a round trip before the operator
learns the subdomain is malformed; the benefit is one rule with one owner.

### It must not introduce a status field

`tools.ts` has refused to carry status since it was written, and the Go module
repeats the reasoning: whether a tool is *up* belongs to the health strip, and
several of these expose no status endpoint at all, so the field would be honest
for some rows and a lie for the rest. An editing form is where that pressure
will be felt. The answer is still no.

## Architecture

| Path | Responsibility |
|---|---|
| `packages/console-core/src/routes.ts` | `platform.tools`, `console: "/platform/tools"`, `capability: "platform"` |
| `apps/console/app/(console)/platform/tools/page.tsx` | Server component: three gates, then the grouped view |
| `apps/console/app/(console)/platform/tools/actions.ts` | Eight server actions, one per write |
| `apps/console/lib/tools-write.ts` | The write seam — session, capability, API call, error mapping |
| `apps/console/components/tools-admin/` | Group section, tool row, tool form, group form, delete confirmation |

Reads reuse `readToolsDirectory()` unchanged. There is no second loader.

**Gating**, following `tickets/[id]/page.tsx:79`: `requiresCapability()` is an
`AUTH_PROVIDER === "zitadel"` toggle, and the page renders controls only when
`!requiresCapability() || hasCapability(session?.roles, "platform")`. The API
is still the authority — it answers 403 regardless — but the page must not
offer a control that will refuse.

**Actions** return a discriminated result, `{ ok: true }` or
`{ ok: false, message, field? }`, so a form can put the message where it
belongs rather than rendering a surface-level error for a field-level problem.

**Error mapping at the seam:** 422 → the API's message under the offending
field; 409 → "a tool with this subdomain already exists"; 404 → "it may have
been removed — reload"; 400 → a generic refusal. These are form errors, so
neither `lib/db-read-error.ts` nor `components/kit/surface-state.ts` is
extended — per the rule at the top of `crm-queues.ts`, this is a translation at
the seam, not a new condition in the console's vocabulary.

**After every write**, `revalidatePath("/platform/tools")` and
`revalidatePath("/")` — the home cards read the same data and would otherwise
serve a stale directory from the router cache.

`Idempotency-Key` comes from `platform-api.ts`'s existing per-write
`idempotencyKey()`.

## Layout

Grouped sections, a small table per group, in display order. Each group header
carries its label, a rename control, up/down, and delete. Each tool row shows
name, subdomain, purpose and note, with edit, delete and up/down.

Rejected: a flat table of all fifteen with a group column — better filtering,
but reordering *within* a group becomes confusing and the structure the page
exists to manage is the thing it hides. Also rejected: master-detail, which is
too much apparatus for fifteen rows.

## Testing

- The seam: both branches and each of the four error mappings.
- The actions: against a mocked seam, including that revalidation fires — a
  write that succeeds and leaves the home page stale is the failure that would
  otherwise be found by hand.
- Render: a populated group, an empty group, the no-capability state, the
  origin-unset state and the degraded state.
- `npx next build` before merge. `tsc` cannot see a `server-only` module
  reaching a client component, and this surface adds client components beside a
  server-only loader.

## Definition of done

1. An operator with `platform` can add, edit, delete and reorder a tool, and
   see the change on the home page without a deploy.
2. An operator without `platform` sees no rail entry and no controls.
3. With `PLATFORM_API_ORIGIN` unset the surface is absent and the console is
   byte-for-byte its pre-#318 self.
4. One audit row per edit, not two.
5. A group created through the surface is visible on that surface immediately,
   and absent from the home page until it holds a tool.

## Not in this phase

Bulk import, drag-and-drop, a dedicated atomic reorder endpoint, and any
history or undo of directory edits — `console_audit_log` already records who
changed what, and a second reader for it is its own piece of work.
