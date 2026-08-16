# ⌘K over the estate — design

Issue #135. Fills the header slot left empty when #185 built the bar, and folds in the initials avatar agreed alongside it.

## What it searches, and what it deliberately does not

The issue names five sources: tenants, tickets, users, services and workloads, and console routes. Only three of those can land somewhere a human can open today, and a palette result that navigates nowhere is worse than no result.

| Source | This slice | Why |
|---|---|---|
| **Console routes** | Yes | Route identity is already data in `packages/console-core/src/routes.ts`. 22 routes, of which **21 are `pending`** — so route search alone would offer exactly one destination. It is included because it grows for free as surfaces land, not because it is useful yet. |
| **Internal tools** | Yes | 16 entries in `console-core/src/tools.ts`, each a real external system (Zitadel, Grafana, ArgoCD…). This is what makes the palette worth opening on day one. |
| **Tickets** | Yes | The console now reads `platform_tickets` directly (#183), and `/platform/tickets/[id]` exists to land on (#181). Searchable by number, subject and submitter. |
| Tenants | No | There is no tenant surface in the console to navigate to. The result would be a dead end. |
| Users | No | The issue itself scopes this "subject to the staff-scoping rules in the identity-lookup issue" — #134, which is not built and whose rules are not decided. |
| Services and workloads | No | Same reason as tenants: `platform.serviceHealth` and `platform.observability` are both `pending`. |

## Decisions

### D1 — Build on `@tesserix/web`'s command primitives, not a hand-rolled palette

The design system ships `CommandDialog`, `Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut` and `CommandSeparator`. It also ships a ready-made `CommandPalette`, which is **not** used: its props expose no query value, and server-side ticket search needs the typed string. The lower-level `Command` takes `value`/`onValueChange`, so the query is ours.

This is the "trust the system" principle actually applying — unlike the bell and operator menu, which were hand-rolled only after confirming no primitive existed.

### D2 — Every item carries its matched text, because `CommandItem` filters itself

`CommandItem` computes `[value, ...keywords].join(" ").toLowerCase().includes(query.toLowerCase().trim())` and returns `null` when it does not match. There is no `shouldFilter` escape hatch.

So a server-matched ticket whose label does not literally contain the query would be fetched and then silently hidden. Every ticket item therefore carries its number, subject, submitter name and email in `keywords`, and the server matches on **exactly those fields** with `ILIKE '%q%'`. Client and server matching stay in parity by construction rather than by luck.

### D3 — Pending routes are shown and disabled, not hidden

The acceptance criterion allows either. Disabled is better: it tells an operator the surface is coming rather than leaving them wondering whether they mistyped. `CommandItem` extends button props, so `disabled` is native — and the component excludes disabled items from its visible-item registry, so they are not keyboard-navigable. Shown, greyed, unreachable: exactly what the criterion asks for.

### D4 — Capability is a property of the source, checked against the session

Every entry declares the capability its destination requires, and the palette drops entries the operator does not hold. Today every console surface requires only `read`, the entry capability, so nothing is filtered in practice — but the mechanism exists rather than being retrofitted the first time a surface needs `respond` or `rotate-credentials`.

The palette is not an authorization boundary and must never be treated as one: hiding a result is UX, the destination asserts for itself. Same rule as the reply form in #181.

### D5 — Routes and tools are local; tickets are fetched

Routes and tools are static data already in the bundle, so they filter instantly with no round trip. Tickets need the database, so the palette debounces the query and fetches. The two are merged into one list under separate groups.

While a ticket fetch is in flight the palette shows a non-selectable "Searching tickets…" row rather than a spinner, so the list does not jump. A failed fetch degrades to routes and tools only, with a quiet note — the palette must never become unusable because the database is unreachable.

### D6 — Minimum query length for the ticket fetch

Two characters. A single character would match most of the table and return noise, and the server work is wasted. Routes and tools still filter from the first character, since they are local.

### D7 — Where it opens from

⌘K on macOS, Ctrl+K elsewhere, from any console route. Escape closes. The header gains a trigger on its left side — the slot deliberately left empty in #185 — showing "Search" and the shortcut, so the feature is discoverable without knowing the chord.

The shortcut binds on `document` and must not fire while the operator is typing in an input or textarea, except the palette's own.

### D8 — Initials avatar in the operator menu

Folded in here rather than shipped separately, because both touch the header and the avatar is what makes room for this trigger.

Initials, not a photo. Zitadel's discovery document advertises no `picture` claim — the claims it will issue are `sub, name, given_name, family_name, preferred_username, email, email_verified, locale, phone_number` plus protocol claims — so a Google photo is not available through this login path without work that may not be possible at all. A photo would also mean an external request to googleusercontent on every console page load.

The name stays beside the avatar at normal widths and drops below `sm`. "Which account am I signed in as?" is why the header exists, and a monogram answers it worse than a name; the avatar earns its place by anchoring the control, not by replacing the answer.

## Not in scope

- Tenants, users, services — see the table above.
- Recent or frequent destinations. Ranking needs usage data nobody is collecting, and inventing a score would be decoration.
- Actions in the palette ("resolve this ticket"). This slice navigates; verbs stay on the surfaces that own them.
