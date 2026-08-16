# ⌘K Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #135 — ⌘K over the estate: console routes, internal tools and tickets, opening from any console route. Plus the initials avatar in the operator menu, and the sticky header's ancestor breadcrumb trail (Task 6).

**Architecture:** Routes and tools are static data already in the bundle and filter locally; tickets are fetched from a debounced server endpoint. Built on `@tesserix/web`'s `Command*` primitives, which own keyboard navigation and self-filter each item.

**Tech Stack:** Next.js 16 App Router, React 19, `@tesserix/web` command primitives, `pg`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-16-console-command-palette-design.md` — read it; D1–D8 argue every decision.

**Branch:** `feat/console-command-palette`, off `origin/main` (`af112b3`).

## Global Constraints

- Every verb asserts a capability. The search endpoint is a read and asserts **`read`**.
- The palette is **not** an authorization boundary — hiding a result is UX; every destination asserts for itself.
- Pending routes render **disabled**, never navigable (spec D3).
- Every item must carry its matched text in `value`/`keywords`, because `CommandItem` self-filters and has no escape hatch (spec D2).
- Results are typed, not stringly — reuse `RouteId` from `@tesserix/console-core`.
- Ticket fetch requires **2+ characters**; routes and tools filter from the first (spec D6).
- The palette must remain usable when the database is unreachable — degrade to routes and tools (spec D5).
- No `console.log`; explicit types on exports; immutable patterns; files well under 800 lines.
- Single-line conventional commits, no signatures.
- Verification per task from `apps/console/`: `npm run test:unit`; at the end also `npm run typecheck && npm run lint && npm run build`.
- Work in the worktree at `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/.claude/worktrees/m0-foundation` using **absolute paths** — the shell resets its cwd to a stale checkout between commands.

### Verified facts to build on

- `@tesserix/console-core` exports `ROUTES`, `ROUTE_IDS`, `type RouteId`, `consolePath(id)`, `isPending(id)`, `INTERNAL_TOOLS`, `type InternalTool`, `TOOL_GROUPS`, `toolUrl(tool, baseDomain)`, `ESTATE`.
- 22 routes exist; 21 carry `pending: true`. Only `platform.tickets` is navigable today.
- `INTERNAL_TOOLS` has 16 entries shaped `{ name, subdomain, purpose, group, note? }`.
- `@tesserix/web` exports `CommandDialog`, `Command` (props `value`/`defaultValue`/`onValueChange`), `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem` (props extend `React.ComponentProps<"button">` plus `value: string` and `keywords?: string[]`), `CommandShortcut`, `CommandSeparator`.
- `CommandItem` filters itself: `[value, ...keywords].join(" ").toLowerCase().includes(query.toLowerCase().trim())`, returning `null` when it does not match. Disabled items render but are excluded from the visible-item registry.
- `apps/console/lib/db/tesserix.ts` exports `isDatabaseConfigured()` and `tesserixQuery<R>(sql, params)` returning rows.
- `apps/console/lib/auth/operator.ts` exports `checkOperatorCapability(session, required, provider?)`, throwing `CapabilityError`.
- `platform_tickets` columns used here: `id uuid, product_id text, ticket_number varchar(20), subject varchar(300), submitted_by_name varchar(200), submitted_by_email varchar(300), status varchar(20), created_at timestamptz`.
- The header (`apps/console/components/nav/console-header.tsx`) is `sticky top-0 flex h-14 items-center justify-end gap-2 border-b ... px-6 sm:px-8`; its left side is empty and reserved for this trigger.

---

### Task 1: The search domain — typed entries, local filtering, capability gating

**Files:**
- Create: `apps/console/lib/search.ts`
- Test: `apps/console/lib/search.test.ts`

**Interfaces:**
- Consumes: `ROUTE_IDS`, `consolePath`, `isPending`, `type RouteId`, `INTERNAL_TOOLS`, `type InternalTool` from `@tesserix/console-core`.
- Produces (Tasks 2 and 3 rely on these exact names):
  - `type SearchKind = "route" | "tool" | "ticket"`
  - `interface SearchEntry { readonly id: string; readonly kind: SearchKind; readonly label: string; readonly hint: string; readonly href: string; readonly external: boolean; readonly disabled: boolean; readonly keywords: readonly string[]; readonly capability: string }`
  - `routeEntries(): SearchEntry[]`
  - `toolEntries(baseDomain: string): SearchEntry[]`
  - `ticketEntry(row: TicketSearchRow): SearchEntry` and `interface TicketSearchRow { id: string; product_id: string; ticket_number: string; subject: string; submitted_by_name: string; submitted_by_email: string; status: string }`
  - `visibleTo(entries: readonly SearchEntry[], held: readonly string[] | undefined, enforce: boolean): SearchEntry[]`
  - `MIN_TICKET_QUERY = 2`

Route labels come from the route id rather than a new display-name table: ids are already human-legible (`platform.tickets` → "Platform · Tickets"). Inventing a second naming source would let the two drift.

- [ ] **Step 1: Write the failing tests**

`apps/console/lib/search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MIN_TICKET_QUERY,
  routeEntries,
  ticketEntry,
  toolEntries,
  visibleTo,
  type SearchEntry,
} from "./search";

describe("routeEntries", () => {
  it("marks pending routes disabled so they render but cannot be opened", () => {
    // 21 of 22 routes are pending today. Hiding them would leave the palette
    // looking empty; offering them would 404.
    const entries = routeEntries();
    const pending = entries.filter((e) => e.disabled);
    expect(pending.length).toBeGreaterThan(0);
    expect(entries.some((e) => !e.disabled)).toBe(true);
  });

  it("points the built ticket queue at its console path", () => {
    const tickets = routeEntries().find((e) => e.id === "route:platform.tickets");
    expect(tickets).toBeDefined();
    expect(tickets?.disabled).toBe(false);
    expect(tickets?.href).toBe("/platform/tickets");
    expect(tickets?.external).toBe(false);
  });

  it("gives every route a searchable label derived from its id", () => {
    const tickets = routeEntries().find((e) => e.id === "route:platform.tickets");
    expect(tickets?.label.toLowerCase()).toContain("tickets");
    expect(tickets?.keywords.join(" ")).toContain("platform.tickets");
  });
});

describe("toolEntries", () => {
  it("builds an absolute external URL from the base domain", () => {
    const entries = toolEntries("tesserix.app");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.external).toBe(true);
      expect(entry.href.startsWith("https://")).toBe(true);
      expect(entry.disabled).toBe(false);
    }
  });

  it("carries the tool's purpose as the hint, so a name nobody knows is explained", () => {
    const entries = toolEntries("tesserix.app");
    expect(entries.every((e) => e.hint.length > 0)).toBe(true);
  });
});

describe("ticketEntry", () => {
  const ROW = {
    id: "5f0b2c34-0000-0000-0000-000000000000",
    product_id: "mark8ly",
    ticket_number: "M8-1042",
    subject: "Payout missing",
    submitted_by_name: "Asha Pillai",
    submitted_by_email: "asha@example.com",
    status: "open",
  };

  it("links by uuid, never by ticket number", () => {
    expect(ticketEntry(ROW).href).toBe(
      "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000",
    );
  });

  it("carries every server-matched field as a keyword", () => {
    // CommandItem self-filters on value + keywords with no escape hatch, so a
    // ticket the server matched would be hidden client-side unless the text
    // it matched on travels with it.
    const kw = ticketEntry(ROW).keywords.join(" ").toLowerCase();
    expect(kw).toContain("m8-1042");
    expect(kw).toContain("payout missing");
    expect(kw).toContain("asha pillai");
    expect(kw).toContain("asha@example.com");
  });
});

describe("visibleTo", () => {
  const ENTRIES: SearchEntry[] = [
    {
      id: "a",
      kind: "route",
      label: "A",
      hint: "",
      href: "/a",
      external: false,
      disabled: false,
      keywords: [],
      capability: "read",
    },
    {
      id: "b",
      kind: "route",
      label: "B",
      hint: "",
      href: "/b",
      external: false,
      disabled: false,
      keywords: [],
      capability: "hard-delete",
    },
  ];

  it("drops entries whose capability the operator does not hold", () => {
    expect(visibleTo(ENTRIES, ["read"], true).map((e) => e.id)).toEqual(["a"]);
  });

  it("keeps everything when enforcement is off, as under the legacy provider", () => {
    // Legacy sessions carry no roles at all; filtering on an absent claim
    // would empty the palette for everyone.
    expect(visibleTo(ENTRIES, undefined, false)).toHaveLength(2);
  });

  it("drops everything when enforcement is on and no capabilities are held", () => {
    expect(visibleTo(ENTRIES, [], true)).toHaveLength(0);
  });
});

describe("MIN_TICKET_QUERY", () => {
  it("is two, so a single character does not scan the table", () => {
    expect(MIN_TICKET_QUERY).toBe(2);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

From `apps/console/`: `npm run test:unit -- lib/search.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `apps/console/lib/search.ts`**

Write it yourself against the interface above. Requirements:

- `SearchEntry.id` is namespaced by kind (`route:platform.tickets`, `tool:zitadel`, `ticket:<uuid>`) so ids cannot collide across sources in one list.
- Route label: split the `RouteId` on `.`, title-case each half, join with `·`. Keywords must include the raw id and both halves.
- Route `href` is `consolePath(id)`; `disabled` is `isPending(id)`; `capability` is `"read"`.
- Tool `href` is `toolUrl(tool, baseDomain)`; `external: true`; `hint` is the tool's `purpose`; keywords include name, subdomain and group. If a tool has a `note`, append it to the hint — it is the thing a first-time visitor most needs.
- `ticketEntry` builds `label` as `${ticket_number} — ${subject}`, `hint` as the submitter and status, `href` as `/platform/tickets/${id}`, and keywords as number, subject, submitter name, submitter email and product id.
- `visibleTo` returns entries unchanged when `enforce` is false; otherwise keeps only those whose `capability` appears in `held`. Fails closed on `undefined`/empty when enforcing.
- Everything pure and immutable — no module-level mutable state, no `Date.now()`.

- [ ] **Step 4: Run — it must pass**

`npm run test:unit -- lib/search.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/search.ts apps/console/lib/search.test.ts
git commit -m "feat(console): typed search entries for routes, tools and tickets"
```

---

### Task 2: Ticket search endpoint

**Files:**
- Create: `apps/console/lib/db/search-repo.ts`
- Create: `apps/console/app/api/search/route.ts`
- Test: `apps/console/app/api/search/route.test.ts`

**Interfaces:**
- Consumes: `tesserixQuery`, `isDatabaseConfigured` (`@/lib/db/tesserix`), `ticketEntry`, `MIN_TICKET_QUERY`, `type TicketSearchRow` (`@/lib/search`), `checkOperatorCapability` (`@/lib/auth/operator`), `getCurrentSession`, `CapabilityError` (`@tesserix/platform-auth`).
- Produces:
  - `searchTicketRows(query: string, limit: number): Promise<TicketSearchRow[]>`
  - `GET /api/search?q=` → `200 { items: SearchEntry[] }` | `400 { error: "query_too_short" }` | `403 { error: "forbidden" }` | `501 { error: "not_configured" }` | `500 { error: "unavailable" }`

The SQL must match on exactly the fields Task 1 puts into `keywords`, so a server hit is never hidden by the client's own filter (spec D2).

- [ ] **Step 1: Write the failing tests**

`apps/console/app/api/search/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
}));
vi.mock("@/lib/db/search-repo", () => ({ searchTicketRows: vi.fn(async () => []) }));

import { getCurrentSession } from "@tesserix/platform-auth";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { searchTicketRows } from "@/lib/db/search-repo";
import { GET } from "./route";

function request(q: string): Request {
  return new Request(`https://console.tesserix.app/api/search?q=${encodeURIComponent(q)}`);
}

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1", email: "op@tesserix.app", roles, iat: 0, exp: 0,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(searchTicketRows).mockResolvedValue([]);
});

describe("GET /api/search", () => {
  it("returns ticket entries for a matching query", async () => {
    signIn(["read"]);
    vi.mocked(searchTicketRows).mockResolvedValue([
      {
        id: "5f0b2c34-0000-0000-0000-000000000000",
        product_id: "mark8ly",
        ticket_number: "M8-1042",
        subject: "Payout missing",
        submitted_by_name: "Asha Pillai",
        submitted_by_email: "asha@example.com",
        status: "open",
      },
    ] as never);

    const res = await GET(request("payout"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("ticket");
    expect(body.items[0].href).toBe(
      "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000",
    );
  });

  it("refuses a query shorter than the minimum without touching the database", async () => {
    signIn(["read"]);
    const res = await GET(request("p"));
    expect(res.status).toBe(400);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("trims before measuring, so whitespace is not a query", async () => {
    signIn(["read"]);
    const res = await GET(request("   "));
    expect(res.status).toBe(400);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("refuses a session without the read capability", async () => {
    signIn([]);
    const res = await GET(request("payout"));
    expect(res.status).toBe(403);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("refuses a null session", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    const res = await GET(request("payout"));
    expect(res.status).toBe(403);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("answers 501 when the database is not wired up", async () => {
    signIn(["read"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    const res = await GET(request("payout"));
    expect(res.status).toBe(501);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("answers 500 without leaking the driver error", async () => {
    signIn(["read"]);
    vi.mocked(searchTicketRows).mockRejectedValue(
      new Error("password authentication failed for user tesserix_admin"),
    );
    const res = await GET(request("payout"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("password");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

`npm run test:unit -- app/api/search` → FAIL, module missing.

- [ ] **Step 3: Implement `apps/console/lib/db/search-repo.ts`**

```ts
import { tesserixQuery } from "./tesserix";
import type { TicketSearchRow } from "../search";

/**
 * Ticket lookup for the palette.
 *
 * Matches on exactly the fields the palette puts into each item's keywords —
 * number, subject, submitter name and email. CommandItem filters itself with a
 * substring test and offers no way to opt out, so anything this matches on but
 * does not send back as a keyword would be fetched and then silently hidden.
 */
export async function searchTicketRows(
  query: string,
  limit: number,
): Promise<TicketSearchRow[]> {
  const pattern = `%${query}%`;
  return tesserixQuery<TicketSearchRow>(
    `SELECT id::text, product_id, ticket_number, subject,
            submitted_by_name, submitted_by_email, status
       FROM platform_tickets
      WHERE ticket_number ILIKE $1
         OR subject ILIKE $1
         OR submitted_by_name ILIKE $1
         OR submitted_by_email ILIKE $1
      ORDER BY
        CASE WHEN status IN ('open','in_progress') THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT $2`,
    [pattern, limit],
  );
}
```

Note `%` and `_` in the query are ILIKE wildcards. That is acceptable here — the worst case is a broader match on a bounded, capability-gated read — but say so in a comment rather than leaving it to be discovered.

- [ ] **Step 4: Implement `apps/console/app/api/search/route.ts`**

Mirror `apps/console/app/api/notifications/route.ts` exactly for the authorize/501/500 shape — read it first and match it. Specifics:

- `export const dynamic = "force-dynamic";`
- Read `q` from `new URL(request.url).searchParams`, trim it, and 400 with `{ error: "query_too_short" }` when shorter than `MIN_TICKET_QUERY`.
- Cap results at 10 — the palette shows tickets alongside routes and tools, and a long tail pushes them off screen.
- Map rows through `ticketEntry` and return `{ items }`.
- Catch-all returns `{ error: "unavailable" }` with 500 and never interpolates the caught error.

- [ ] **Step 5: Run — it must pass**

`npm run test:unit -- app/api/search` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/db/search-repo.ts apps/console/app/api/search
git commit -m "feat(console): ticket search endpoint asserting read"
```

---

### Task 3: The palette

**Files:**
- Create: `apps/console/components/nav/command-palette.tsx`
- Test: `apps/console/components/nav/command-palette.render.test.tsx`
- Modify: `apps/console/components/nav/console-header.tsx` (add the trigger, pass capabilities through)
- Modify: `apps/console/app/(console)/layout.tsx` if the header needs anything new from the session

**Interfaces:**
- Consumes: everything from Task 1, the endpoint from Task 2, and `@tesserix/web`'s `CommandDialog`, `Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`.
- Produces:
  ```ts
  export interface CommandPaletteProps {
    readonly capabilities: readonly string[];
    readonly enforceCapabilities: boolean;
    readonly toolsBaseDomain: string;
  }
  export function ConsoleCommandPalette(props: CommandPaletteProps): React.JSX.Element
  ```

- [ ] **Step 1: Write the failing render tests**

`apps/console/components/nav/command-palette.render.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleCommandPalette } from "./command-palette";

const PROPS = {
  capabilities: ["read"],
  enforceCapabilities: true,
  toolsBaseDomain: "tesserix.app",
};

function mockSearch(items: unknown[], status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ items }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConsoleCommandPalette", () => {
  it("opens on the keyboard shortcut and closes on Escape", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("opens from the trigger button too, for operators who do not know the chord", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("offers the built ticket queue and does not offer a pending route", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(await screen.findByRole("combobox"), "tickets");
    // platform.tickets is built; platform.liveChat is pending and must render
    // disabled rather than navigable.
    const queue = await screen.findByRole("button", { name: /Platform · Tickets/i });
    expect(queue).not.toBeDisabled();
  });

  it("renders a pending route disabled", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(await screen.findByRole("combobox"), "break");
    const pending = await screen.findByRole("button", { name: /Break Glass/i });
    expect(pending).toBeDisabled();
  });

  it("does not fetch tickets for a one-character query", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(await screen.findByRole("combobox"), "p");
    await new Promise((r) => setTimeout(r, 350));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still shows routes and tools when the ticket search fails", async () => {
    // The palette must not become unusable because the database is unreachable.
    mockSearch([], 500);
    const user = userEvent.setup();
    render(<ConsoleCommandPalette {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.type(await screen.findByRole("combobox"), "tickets");
    expect(
      await screen.findByRole("button", { name: /Platform · Tickets/i }),
    ).toBeInTheDocument();
  });
});
```

If `CommandInput` does not expose `role="combobox"`, find it with `screen.getByPlaceholderText(...)` instead and say so in your report — do not weaken what the test asserts.

- [ ] **Step 2: Run and watch it fail**

`npm run test:unit -- command-palette` → FAIL, module missing.

- [ ] **Step 3: Implement the palette**

Requirements — write it yourself:

- `"use client"`.
- Renders a trigger `<button>` whose accessible name contains "Search", showing the shortcut hint via `CommandShortcut` (`⌘K`). It lives in the header's left slot.
- A `document` `keydown` listener opens on `(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"`, calling `preventDefault()`. It must **not** fire while focus is in an `input`, `textarea` or `[contenteditable]` outside the palette. Remove the listener on unmount.
- `CommandDialog` for the modal, `Command` with `value={query} onValueChange={setQuery}`.
- Local entries: `routeEntries()` and `toolEntries(toolsBaseDomain)`, both passed through `visibleTo(..., capabilities, enforceCapabilities)` and memoised with `useMemo` so they are not rebuilt per keystroke.
- Ticket fetch: debounce ~250ms; skip entirely when the trimmed query is shorter than `MIN_TICKET_QUERY`; abort the in-flight request when the query changes (`AbortController`) so a slow response cannot overwrite a newer one. On any failure, set tickets to `[]` and carry on — never throw, never blank the palette.
- While a fetch is in flight render a single non-selectable "Searching tickets…" row (a `CommandItem` with `disabled`), so the list does not jump.
- Groups in order: Tickets, then Routes, then Tools. Tickets first because they are the thing an operator is usually hunting.
- Each item: `value` is the entry's `label`, `keywords` are `entry.keywords`, `disabled` is `entry.disabled`. Selecting navigates — `router.push(href)` for internal, `window.open(href, "_blank", "noopener,noreferrer")` for external — then closes the palette and clears the query.
- Show the entry's `hint` as secondary text, and a small kind badge so a ticket is distinguishable from a route at a glance.
- `CommandEmpty` copy should name what was searched: "Nothing matching that in routes, tools or tickets."

- [ ] **Step 4: Run — it must pass**

`npm run test:unit -- command-palette` → PASS.

- [ ] **Step 5: Wire the trigger into the header**

`ConsoleHeader` gains `capabilities`/`enforceCapabilities` (it already receives both for the operator menu — reuse, do not duplicate) and a `toolsBaseDomain` prop. Render `<ConsoleCommandPalette />` on the LEFT of the bar: change the header's `justify-end` to `justify-between` and place the palette trigger first, with the bell and operator menu grouped on the right inside their own flex container so their spacing is unchanged.

The base domain: read how `internal-tools.tsx` already resolves it and use the same source rather than inventing a second one.

- [ ] **Step 6: Full gate**

From `apps/console/`: `npm run test:unit && npm run typecheck && npm run lint` — all green. `console-header.render.test.tsx` must still pass; if the layout change breaks an assertion about the bar's structure, update it only where it genuinely describes the old structure, and say so in your report.

- [ ] **Step 7: Commit**

```bash
git add apps/console/components/nav "apps/console/app/(console)/layout.tsx"
git commit -m "feat(console): cmd-k palette over routes, tools and tickets"
```

---

### Task 4: Initials avatar in the operator menu

**Files:**
- Modify: `apps/console/components/nav/operator-menu.tsx`
- Test: `apps/console/components/nav/operator-menu.render.test.tsx`

Spec D8. Initials, not a photo — Zitadel advertises no `picture` claim.

- [ ] **Step 1: Write the failing tests**

Append to the existing render test file:

```tsx
describe("OperatorMenu avatar", () => {
  it("shows initials derived from the name", async () => {
    render(<OperatorMenu {...PROPS} name="Mahesh Sangawar" />);
    expect(screen.getByText("MS")).toBeInTheDocument();
  });

  it("falls back to the email's first letter when there is no name", () => {
    render(<OperatorMenu {...PROPS} name="" email="asha@example.com" />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("hides the initials from screen readers, since the name is already there", () => {
    // The trigger's accessible name already carries the identity; announcing
    // "MS" as well would read the operator's identity out twice.
    render(<OperatorMenu {...PROPS} name="Mahesh Sangawar" />);
    expect(screen.getByText("MS")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the name visible beside the avatar", () => {
    render(<OperatorMenu {...PROPS} name="Mahesh Sangawar" />);
    expect(
      screen.getByRole("button", { name: /Mahesh Sangawar/ }),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

`npm run test:unit -- operator-menu` → FAIL on the new cases.

- [ ] **Step 3: Implement**

- A small circle (roughly `h-6 w-6`, `rounded-full`, `bg-accent`, `text-[11px] font-semibold`) before the name in the trigger.
- Initials: first letters of the first two whitespace-separated words of `name`, uppercased; falling back to the first letter of `email`; falling back to nothing rather than rendering an empty circle with stray characters.
- `aria-hidden="true"` on the initials — the trigger's accessible name already carries identity.
- The name `<span>` gains `hidden sm:inline` so it drops on narrow widths while the avatar remains (spec D8).
- Extract the initials calculation as a small exported pure function with its own tests if it grows past a couple of lines.

- [ ] **Step 4: Run — it must pass**, then commit

```bash
git add apps/console/components/nav/operator-menu.tsx apps/console/components/nav/operator-menu.render.test.tsx
git commit -m "feat(console): initials avatar on the operator menu"
```

---

### Task 5: Build and verify

- [ ] **Step 1: Build**

From `apps/console/`: `npm run build`. Must succeed; `/api/search` must appear in the route table. Paste the relevant lines.

- [ ] **Step 2: Full gate**

`npm run test:unit && npm run typecheck && npm run lint` — all green.

- [ ] **Step 3: Smoke locally, max ~5 minutes**

Start the dev server on :3003. Check `/api/search?q=xx` — unauthenticated the middleware answers first; report exactly what you saw. Kill the server and confirm the port is free.

Record plainly what is **not** verifiable locally: the palette opening over a real page, keyboard navigation in a real browser, ticket results from the real database, and whether the trigger's placement actually balances the bar. Note that jsdom computes no layout — a Critical positioning bug reached review on the previous branch for exactly that reason.

- [ ] **Step 4: Commit any fix the build surfaced**, single-line message. If nothing needed fixing, make no commit.

---

### Task 6: Ancestor breadcrumb trail in the sticky header

Added after Mahesh hit the bug fixed in #186 — on a long ticket thread the page's own breadcrumb scrolls out of sight, so the way back is only reachable by scrolling up.

**Files:**
- Create: `apps/console/lib/trail.ts`
- Test: `apps/console/lib/trail.test.ts`
- Create: `apps/console/components/nav/header-trail.tsx`
- Test: `apps/console/components/nav/header-trail.render.test.tsx`
- Modify: `apps/console/components/nav/console-header.tsx`

**Interfaces:**
- Consumes: `ROUTE_IDS`, `consolePath`, `isPending`, `type RouteId` from `@tesserix/console-core`; `usePathname` from `next/navigation`.
- Produces:
  - `interface TrailCrumb { readonly label: string; readonly href: string }`
  - `ancestorTrail(pathname: string): TrailCrumb[]`
  - `function HeaderTrail(): React.JSX.Element | null`

**The split, and why it is not a duplicate of the page's breadcrumb.** The header renders **ancestors only**; the page keeps rendering its own title as the leaf. The bar never shows the leaf and the page never shows the ancestors, so nothing appears twice. This is also what makes a pathname-derived trail workable at all: the leaf of `/platform/tickets/5f0b2c34-…` is a UUID, and only the page knows it is really `M8-1042`.

**Do not** have pages publish their trail up to the header through a context and an effect. The header is a client component in the layout and pages are server components passed as `children`; that shape gives flicker on navigation, stale crumbs when an effect does not fire, and a coupling that fights RSC. Deriving from the pathname keeps the header self-contained.

- [ ] **Step 1: Write the failing tests for the pure part**

`apps/console/lib/trail.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ancestorTrail } from "./trail";

describe("ancestorTrail", () => {
  it("is empty on a top-level surface, which has no ancestors", () => {
    expect(ancestorTrail("/platform/tickets")).toEqual([]);
  });

  it("is empty at the root", () => {
    expect(ancestorTrail("/")).toEqual([]);
  });

  it("names the parent queue from a ticket detail path", () => {
    // The leaf is a uuid and stays out of the trail — only the page knows it
    // is really M8-1042.
    expect(ancestorTrail("/platform/tickets/5f0b2c34-0000-0000-0000-000000000000")).toEqual([
      { label: "Tickets", href: "/platform/tickets" },
    ]);
  });

  it("tolerates a trailing slash", () => {
    expect(
      ancestorTrail("/platform/tickets/5f0b2c34-0000-0000-0000-000000000000/"),
    ).toHaveLength(1);
  });

  it("omits an ancestor that is not a built route", () => {
    // A crumb pointing at a pending surface would 404. Better absent than
    // broken — the same rule the palette applies to its results.
    expect(ancestorTrail("/platform/break-glass/some-id")).toEqual([]);
  });

  it("returns nothing for a path that matches no known route", () => {
    expect(ancestorTrail("/nonsense/deep/path")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

From `apps/console/`: `npm run test:unit -- lib/trail.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement `apps/console/lib/trail.ts`**

Requirements:

- Build a lookup of `consolePath(id) → id` over `ROUTE_IDS`, skipping ids where `isPending(id)` is true, memoised at module scope as a `const` (it is derived from static data, so this is a pure computation, not mutable state).
- `ancestorTrail(pathname)`: normalise away a trailing slash, then walk the path's prefixes from longest to shortest **excluding the full path itself**, and return a crumb for each prefix that is a known non-pending route. Order them shallowest-first so they read left to right.
- The label comes from the same derivation the palette uses. Import and reuse the route-label logic from `@/lib/search` rather than writing a second one — two naming sources will drift. If it is not exported yet, export it from there and note that in your report.
- Pure; no `Date.now()`; explicit types.

- [ ] **Step 4: Run — it must pass**, then write the component test

`apps/console/components/nav/header-trail.render.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/platform/tickets" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import { HeaderTrail } from "./header-trail";

describe("HeaderTrail", () => {
  it("renders nothing on a top-level surface", () => {
    pathname.current = "/platform/tickets";
    const { container } = render(<HeaderTrail />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links back to the queue from a ticket detail path", () => {
    pathname.current = "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000";
    render(<HeaderTrail />);
    expect(screen.getByRole("link", { name: "Tickets" })).toHaveAttribute(
      "href",
      "/platform/tickets",
    );
  });

  it("does not render the leaf, which the page's own title already carries", () => {
    pathname.current = "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000";
    render(<HeaderTrail />);
    expect(screen.queryByText(/5f0b2c34/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Implement `header-trail.tsx`**

- `"use client"`; `usePathname()`; returns `null` when the trail is empty, so the bar's left side stays clean on top-level surfaces.
- Each crumb is a `next/link` styled as muted text with a trailing separator, sized to sit inside an `h-14` bar without crowding the palette trigger.
- Wrap in `<nav aria-label="Breadcrumb">` so it is announced as navigation rather than as loose links.

- [ ] **Step 6: Place it in the header**

The bar's left side now holds the palette trigger and the trail. Put the trigger first, then the trail, in a `min-w-0 flex items-center gap-3` container so a long trail truncates rather than pushing the right-hand controls off screen. The bell and operator menu keep their own right-hand group. Re-run `console-header.render.test.tsx`.

- [ ] **Step 7: Full gate and commit**

From `apps/console/`: `npm run test:unit && npm run typecheck && npm run lint`.

```bash
git add apps/console/lib/trail.ts apps/console/lib/trail.test.ts apps/console/components/nav
git commit -m "feat(console): ancestor breadcrumb trail in the header"
```
