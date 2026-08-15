# Console Ticket Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The #133 slice the handoff scoped: a ticket detail page at `/platform/tickets/[id]` with the reply thread, a reply form, and a status transition — the console's first two verbs.

**Architecture:** The console server-side calls `apps/web`'s existing admin API, forwarding the operator's cookie so replies are attributed to the human. Writes additionally send `Origin: https://console.tesserix.app` because `evaluateCsrf` in apps/web rejects cookie-bearing mutations with no Origin (the k8s side, `CSRF_ALLOWED_DOMAINS`, is deployed and verified on the company pod). Mutations are Next.js server actions that assert the `respond` capability before calling the transport layer — the standing rule is every verb asserts a capability in the same change that adds it.

**Tech Stack:** Next.js 16 App Router (RSC + server actions), `@tesserix/platform-auth`, `@tesserix/web` kit components, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-platform-console-design.md` (M1 "one support surface"; this plan delivers only the ticket-detail slice — live chat, escalation and analytics-as-a-tab are later slices of #133). Contracts confirmed against `apps/web/app/api/admin/platform-tickets/[id]/route.ts` and `.../replies/route.ts`.

## Global Constraints

- Detail route keys on the ticket **UUID**, not `ticket_number` — the API only supports id lookup, and adding a lookup endpoint to apps/web is ruled out for surfaces awaiting their milestone.
- Every verb asserts a capability. Reply and status transition → `respond`.
- No links into apps/web; the console serves its own paths.
- All five surface states handled (`SurfaceState` in `components/kit/states.tsx`); 501 means instrumentation-unavailable, never error.
- Reject malformed payloads, never coerce (existing parser style in `lib/tickets.ts`).
- Immutability everywhere; no `console.log`; files stay well under 800 lines.
- Single-line conventional commits, no signatures, no multi-line body.
- Verification per task: `npm run test:unit`, and at the end `npm run typecheck && npm run lint` — all run from `apps/console/`.
- apps/web response shapes (snake_case, from `apps/web/lib/db/platform-tickets.ts`):
  - `GET /api/admin/platform-tickets/[id]` → `{ ticket: PlatformTicketRow, replies: PlatformTicketReplyRow[] }`; 404 `{ error: "not_found" }`.
  - `POST /api/admin/platform-tickets/[id]/replies` body `{ content: string (1..10000), newStatus?: "open"|"in_progress"|"resolved"|"closed" }` → 201 `{ reply }`.
  - `PATCH /api/admin/platform-tickets/[id]` body `{ status: "open"|"in_progress"|"resolved"|"closed" }` → `{ ticket }`.
  - `PlatformTicketRow` adds over the listing row: `description: string`, `submitted_by_user_id: string | null`, `resolved_at: string | null`.
  - `PlatformTicketReplyRow`: `{ id, ticket_id, author_type: "merchant"|"platform_admin", author_name, author_email: string|null, author_user_id: string|null, content, created_at }`.

---

### Task 1: Ticket detail domain types + parser

**Files:**
- Modify: `apps/console/lib/tickets.ts`
- Test: `apps/console/lib/tickets.test.ts`

**Interfaces:**
- Consumes: existing `Ticket`, `PlatformApiError`, private helpers `obj`/`str`/`asArray` in the same file.
- Produces (Task 2 and 5 rely on these exact names):
  - `TICKET_STATUSES: readonly ["open","in_progress","resolved","closed"]`, `type TicketStatus`, `isTicketStatus(value: string): value is TicketStatus`
  - `interface TicketReply { id; authorType: "merchant" | "platform_admin"; authorName; authorEmail; content; createdAt }` (all others `string`)
  - `interface TicketDetail { ticket: Ticket & { description: string; resolvedAt: string | null }; replies: readonly TicketReply[] }`
  - `parseTicketDetail(json: unknown): TicketDetail`

- [ ] **Step 1: Write the failing tests**

Append to `apps/console/lib/tickets.test.ts`:

```ts
describe("parseTicketDetail", () => {
  const VALID_DETAIL = {
    ticket: {
      id: "5f0b2c34-0000-0000-0000-000000000000",
      product_id: "mark8ly",
      tenant_id: "9a1e0000-0000-0000-0000-000000000000",
      ticket_number: "M8-1042",
      subject: "Payout missing",
      description: "The Friday payout never arrived.",
      status: "open",
      priority: "urgent",
      submitted_by_name: "Asha Pillai",
      submitted_by_email: "asha@example.com",
      submitted_by_user_id: null,
      resolved_at: null,
      created_at: "2026-08-10T04:00:00.000Z",
      updated_at: "2026-08-11T04:00:00.000Z",
    },
    replies: [
      {
        id: "77770000-0000-0000-0000-000000000000",
        ticket_id: "5f0b2c34-0000-0000-0000-000000000000",
        author_type: "platform_admin",
        author_name: "Mahesh",
        author_email: "mahesh.sangawar@gmail.com",
        author_user_id: "sub-123",
        content: "Looking into it now.",
        created_at: "2026-08-11T04:00:00.000Z",
      },
    ],
  };

  it("parses ticket, description and replies", () => {
    const detail = parseTicketDetail(VALID_DETAIL);
    expect(detail.ticket.subject).toBe("Payout missing");
    expect(detail.ticket.description).toBe("The Friday payout never arrived.");
    expect(detail.ticket.resolvedAt).toBeNull();
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0].authorType).toBe("platform_admin");
    expect(detail.replies[0].content).toBe("Looking into it now.");
  });

  it("tolerates a null author_email by rendering it as empty", () => {
    const detail = parseTicketDetail({
      ...VALID_DETAIL,
      replies: [{ ...VALID_DETAIL.replies[0], author_email: null }],
    });
    expect(detail.replies[0].authorEmail).toBe("");
  });

  it("rejects an unknown author_type rather than coercing it", () => {
    // author_type drives who a message is attributed to in the thread; a
    // wrong guess misattributes a customer's words to an operator.
    expect(() =>
      parseTicketDetail({
        ...VALID_DETAIL,
        replies: [{ ...VALID_DETAIL.replies[0], author_type: "bot" }],
      }),
    ).toThrow(PlatformApiError);
  });

  it("rejects a payload with no ticket object", () => {
    expect(() => parseTicketDetail({ replies: [] })).toThrow(PlatformApiError);
  });
});

describe("isTicketStatus", () => {
  it("accepts the four contract statuses", () => {
    for (const s of ["open", "in_progress", "resolved", "closed"]) {
      expect(isTicketStatus(s)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isTicketStatus("reopened")).toBe(false);
    expect(isTicketStatus("")).toBe(false);
  });
});
```

Add `parseTicketDetail`, `isTicketStatus` to the import list at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/console/`): `npm run test:unit -- lib/tickets.test.ts`
Expected: FAIL — `parseTicketDetail` / `isTicketStatus` are not exported.

- [ ] **Step 3: Implement in `lib/tickets.ts`**

Add below the existing exports (reusing the file's `obj`/`str`/`asArray` helpers and its parser voice):

```ts
export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

export interface TicketReply {
  readonly id: string;
  readonly authorType: "merchant" | "platform_admin";
  readonly authorName: string;
  readonly authorEmail: string;
  readonly content: string;
  readonly createdAt: string;
}

export interface TicketDetail {
  readonly ticket: Ticket & {
    readonly description: string;
    readonly resolvedAt: string | null;
  };
  readonly replies: readonly TicketReply[];
}

/**
 * Parse `GET /api/admin/platform-tickets/[id]` — `{ ticket, replies }`.
 *
 * `author_type` is validated against the two known values rather than carried
 * through as a string: it decides whether a message renders as the customer's
 * or the operator's, and a misattributed message is worse than an error.
 */
export function parseTicketDetail(json: unknown): TicketDetail {
  const root = obj(json, "response");
  const t = obj(root.ticket, "ticket");
  return {
    ticket: {
      id: str(t.id, "ticket.id"),
      productId: str(t.product_id ?? t.productId, "ticket.product_id"),
      tenantId: String(t.tenant_id ?? t.tenantId ?? ""),
      ticketNumber: str(t.ticket_number ?? t.ticketNumber, "ticket.ticket_number"),
      subject: str(t.subject, "ticket.subject"),
      description: str(t.description, "ticket.description"),
      status: str(t.status, "ticket.status"),
      priority: str(t.priority, "ticket.priority"),
      submittedByName: String(t.submitted_by_name ?? t.submittedByName ?? ""),
      submittedByEmail: String(t.submitted_by_email ?? t.submittedByEmail ?? ""),
      resolvedAt: typeof t.resolved_at === "string" ? t.resolved_at : null,
      createdAt: str(t.created_at ?? t.createdAt, "ticket.created_at"),
      updatedAt: String(t.updated_at ?? t.updatedAt ?? ""),
    },
    replies: asArray(root.replies, "replies").map((raw, i) => {
      const r = obj(raw, `replies[${i}]`);
      const authorType = str(r.author_type ?? r.authorType, `replies[${i}].author_type`);
      if (authorType !== "merchant" && authorType !== "platform_admin") {
        throw new PlatformApiError(
          `tickets: replies[${i}].author_type is unknown (${authorType})`,
        );
      }
      return {
        id: str(r.id, `replies[${i}].id`),
        authorType,
        authorName: String(r.author_name ?? r.authorName ?? ""),
        authorEmail: String(r.author_email ?? r.authorEmail ?? ""),
        content: str(r.content, `replies[${i}].content`),
        createdAt: str(r.created_at ?? r.createdAt, `replies[${i}].created_at`),
      };
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- lib/tickets.test.ts`
Expected: PASS (all pre-existing tests in the file still green).

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/tickets.ts apps/console/lib/tickets.test.ts
git commit -m "feat(console): parse ticket detail and reply thread"
```

---

### Task 2: Transport — detail fetch and the two writes with Origin

**Files:**
- Modify: `apps/console/lib/platform-api.ts`
- Test: `apps/console/lib/platform-api.test.ts`

**Interfaces:**
- Consumes: `parseTicketDetail`, `TicketDetail`, `TicketStatus` from Task 1; existing `PlatformApiError`, `WEB_ORIGIN`, `describe()` helper.
- Produces (Task 4 and 5 rely on these exact signatures):
  - `fetchTicketDetail(id: string, cookieHeader: string): Promise<TicketDetail>`
  - `postTicketReply(id: string, input: { content: string; newStatus?: TicketStatus }, cookieHeader: string): Promise<void>`
  - `patchTicketStatus(id: string, status: TicketStatus, cookieHeader: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/console/lib/platform-api.test.ts` (match the file's existing `vi.stubGlobal("fetch", ...)` style):

```ts
import {
  fetchTicketDetail,
  postTicketReply,
  patchTicketStatus,
} from "./platform-api";

const TICKET_ID = "5f0b2c34-0000-0000-0000-000000000000";

describe("postTicketReply", () => {
  it("sends the console origin so apps/web's CSRF gate accepts the write", async () => {
    // evaluateCsrf rejects cookie-bearing mutations with no Origin — which a
    // server-to-server call never has unless we set one deliberately.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reply: {} }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await postTicketReply(TICKET_ID, { content: "On it." }, "tx_session=abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/admin/platform-tickets/${TICKET_ID}/replies`);
    expect(init.method).toBe("POST");
    expect(init.headers.origin).toBe("https://console.tesserix.app");
    expect(init.headers.cookie).toBe("tx_session=abc");
    expect(JSON.parse(init.body)).toEqual({ content: "On it." });
  });

  it("throws a PlatformApiError carrying the status on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      ),
    );
    await expect(
      postTicketReply(TICKET_ID, { content: "x" }, ""),
    ).rejects.toMatchObject({ name: "PlatformApiError", status: 403 });
  });
});

describe("patchTicketStatus", () => {
  it("PATCHes the status with origin and cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ticket: {} }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await patchTicketStatus(TICKET_ID, "resolved", "tx_session=abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/admin/platform-tickets/${TICKET_ID}`);
    expect(init.method).toBe("PATCH");
    expect(init.headers.origin).toBe("https://console.tesserix.app");
    expect(JSON.parse(init.body)).toEqual({ status: "resolved" });
  });
});

describe("fetchTicketDetail", () => {
  it("forwards the cookie and parses the detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ticket: {
            id: TICKET_ID,
            product_id: "mark8ly",
            tenant_id: "",
            ticket_number: "M8-1042",
            subject: "Payout missing",
            description: "Detail",
            status: "open",
            priority: "urgent",
            submitted_by_name: "Asha",
            submitted_by_email: "asha@example.com",
            resolved_at: null,
            created_at: "2026-08-10T04:00:00.000Z",
            updated_at: "2026-08-11T04:00:00.000Z",
          },
          replies: [],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchTicketDetail(TICKET_ID, "tx_session=abc");
    expect(detail.ticket.ticketNumber).toBe("M8-1042");
    expect(fetchMock.mock.calls[0][1].headers.cookie).toBe("tx_session=abc");
  });

  it("carries a 404 status so the page can render not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      ),
    );
    await expect(fetchTicketDetail(TICKET_ID, "")).rejects.toMatchObject({
      status: 404,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- lib/platform-api.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement in `lib/platform-api.ts`**

Add below `fetchTickets` (same transport voice; parsers stay in `lib/tickets.ts`):

```ts
// The origin apps/web's CSRF gate checks writes against. A server-to-server
// fetch carries no Origin of its own, and evaluateCsrf treats "cookie-bearing
// mutation, no Origin" as a forgery — so the console names itself explicitly.
// Must stay in lockstep with CSRF_ALLOWED_DOMAINS in the company chart.
const CONSOLE_ORIGIN =
  process.env.CONSOLE_PUBLIC_ORIGIN ?? "https://console.tesserix.app";

async function readBody(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new PlatformApiError(
      `${label}: response was not JSON (${describe(cause)})`,
      response.status,
      { cause },
    );
  }
}

async function request(
  label: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${WEB_ORIGIN}${path}`, { cache: "no-store", ...init });
  } catch (cause) {
    throw new PlatformApiError(
      `${label}: request failed (${describe(cause)})`,
      undefined,
      { cause },
    );
  }
  if (!response.ok) {
    throw new PlatformApiError(
      `${label}: responded ${response.status}`,
      response.status,
    );
  }
  return response;
}

export async function fetchTicketDetail(
  id: string,
  cookieHeader: string,
): Promise<import("./tickets").TicketDetail> {
  const { parseTicketDetail } = await import("./tickets");
  const response = await request(
    "ticket",
    `/api/admin/platform-tickets/${encodeURIComponent(id)}`,
    { headers: { cookie: cookieHeader } },
  );
  return parseTicketDetail(await readBody(response, "ticket"));
}

export async function postTicketReply(
  id: string,
  input: { content: string; newStatus?: import("./tickets").TicketStatus },
  cookieHeader: string,
): Promise<void> {
  await request(
    "ticket reply",
    `/api/admin/platform-tickets/${encodeURIComponent(id)}/replies`,
    {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        origin: CONSOLE_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function patchTicketStatus(
  id: string,
  status: import("./tickets").TicketStatus,
  cookieHeader: string,
): Promise<void> {
  await request(
    "ticket status",
    `/api/admin/platform-tickets/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        cookie: cookieHeader,
        origin: CONSOLE_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status }),
    },
  );
}
```

Note: `JSON.stringify(input)` drops an `undefined` `newStatus` — no cleanup needed. Do NOT refactor `fetchDashboard`/`fetchTickets` onto `request()` in this task; that churn belongs to a cleanup commit if ever.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- lib/platform-api.test.ts`
Expected: PASS, existing tests untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/platform-api.ts apps/console/lib/platform-api.test.ts
git commit -m "feat(console): ticket detail transport with CSRF origin on writes"
```

---

### Task 3: Capability gate for verbs

**Files:**
- Create: `apps/console/lib/auth/operator.ts`
- Test: `apps/console/lib/auth/operator.test.ts`

**Interfaces:**
- Consumes: `hasCapability`, `CapabilityError`, `type Capability` from `@tesserix/platform-auth`; `requiresCapability` from `@/lib/internal-access`.
- Produces (Task 4 relies on this exact signature):
  - `checkOperatorCapability(session: { roles?: readonly string[] } | null, required: Capability, provider?: string | undefined): void` — throws `CapabilityError` when refused.

The provider gating mirrors `isInternal` in `lib/internal-access.ts` and exists for the same reason: legacy `AUTH_PROVIDER=google` sessions carry no roles at all, and requiring one would break local dev against the legacy provider. Under `zitadel` (production today) the check is unconditional and fails closed.

- [ ] **Step 1: Write the failing tests**

Create `apps/console/lib/auth/operator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CapabilityError } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "./operator";

describe("checkOperatorCapability", () => {
  it("passes when a zitadel session holds the capability", () => {
    expect(() =>
      checkOperatorCapability({ roles: ["read", "respond"] }, "respond", "zitadel"),
    ).not.toThrow();
  });

  it("refuses a zitadel session lacking the capability", () => {
    expect(() =>
      checkOperatorCapability({ roles: ["read"] }, "respond", "zitadel"),
    ).toThrow(CapabilityError);
  });

  it("refuses a missing session regardless of provider", () => {
    // Middleware already gates the route, but a verb must not depend on that:
    // a null session here means fail closed, even under the legacy provider.
    expect(() => checkOperatorCapability(null, "respond", "google")).toThrow(
      CapabilityError,
    );
    expect(() => checkOperatorCapability(null, "respond", "zitadel")).toThrow(
      CapabilityError,
    );
  });

  it("accepts a role-less session under the legacy provider", () => {
    // Legacy google sessions carry no roles at all; requiring one would block
    // every write in local dev. Mirrors isInternal's provider gate.
    expect(() =>
      checkOperatorCapability({}, "respond", "google"),
    ).not.toThrow();
  });

  it("refuses a role-less zitadel session", () => {
    expect(() => checkOperatorCapability({}, "respond", "zitadel")).toThrow(
      CapabilityError,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- lib/auth/operator.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `apps/console/lib/auth/operator.ts`**

```ts
import {
  CapabilityError,
  hasCapability,
  type Capability,
} from "@tesserix/platform-auth";
import { requiresCapability } from "@/lib/internal-access";

/**
 * The console's verb gate: every server action that mutates state calls this
 * before doing anything else.
 *
 * Provider-gated exactly like `isInternal` and for the same reason — legacy
 * google sessions carry no roles claim, so requiring one under that provider
 * would refuse every write in local dev. A missing session is refused
 * unconditionally: middleware already gates the route, but a verb must fail
 * closed on its own rather than inherit safety from routing.
 */
export function checkOperatorCapability(
  session: { roles?: readonly string[] } | null,
  required: Capability,
  provider: string | undefined = process.env.AUTH_PROVIDER,
): void {
  if (!session) {
    throw new CapabilityError(required);
  }
  if (!requiresCapability(provider)) {
    return;
  }
  if (!hasCapability(session.roles, required)) {
    throw new CapabilityError(required);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- lib/auth/operator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/auth/operator.ts apps/console/lib/auth/operator.test.ts
git commit -m "feat(console): capability gate for mutating server actions"
```

---

### Task 4: Server actions — reply and status transition

**Files:**
- Create: `apps/console/app/(console)/platform/tickets/[id]/actions.ts`
- Test: `apps/console/app/(console)/platform/tickets/[id]/actions.test.ts`

**Interfaces:**
- Consumes: `checkOperatorCapability` (Task 3), `postTicketReply` / `patchTicketStatus` (Task 2), `isTicketStatus` (Task 1), `getCurrentSession` from `@tesserix/platform-auth`, `cookies` from `next/headers`, `revalidatePath` from `next/cache`.
- Produces (Task 5's client components call these):
  - `type TicketActionResult = { ok: true } | { ok: false; message: string }`
  - `replyToTicket(ticketId: string, content: string): Promise<TicketActionResult>`
  - `changeTicketStatus(ticketId: string, status: string): Promise<TicketActionResult>`

Actions return a result object rather than throwing: a thrown error in a server action surfaces as Next's opaque digest page, while the reply form needs a message it can show inline.

- [ ] **Step 1: Write the failing tests**

Create `actions.test.ts` next to the action file. Mock the Next server-only modules and the transport; exercise the action logic end to end:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ toString: () => "tx_session=abc" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  postTicketReply: vi.fn(),
  patchTicketStatus: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { postTicketReply, patchTicketStatus } from "@/lib/platform-api";
import { replyToTicket, changeTicketStatus } from "./actions";

const TICKET_ID = "5f0b2c34-0000-0000-0000-000000000000";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "op@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
});

describe("replyToTicket", () => {
  it("posts the reply with the operator's cookie and revalidates", async () => {
    signIn(["read", "respond"]);
    vi.mocked(postTicketReply).mockResolvedValue(undefined);

    const result = await replyToTicket(TICKET_ID, "On it.");

    expect(result).toEqual({ ok: true });
    expect(postTicketReply).toHaveBeenCalledWith(
      TICKET_ID,
      { content: "On it." },
      "tx_session=abc",
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/tickets/${TICKET_ID}`);
  });

  it("refuses without the respond capability, before any transport call", async () => {
    signIn(["read"]);
    const result = await replyToTicket(TICKET_ID, "On it.");
    expect(result.ok).toBe(false);
    expect(postTicketReply).not.toHaveBeenCalled();
  });

  it("rejects an empty reply without calling the API", async () => {
    signIn(["read", "respond"]);
    const result = await replyToTicket(TICKET_ID, "   ");
    expect(result.ok).toBe(false);
    expect(postTicketReply).not.toHaveBeenCalled();
  });

  it("maps a transport failure to an inline message", async () => {
    signIn(["read", "respond"]);
    vi.mocked(postTicketReply).mockRejectedValue(new Error("boom"));
    const result = await replyToTicket(TICKET_ID, "On it.");
    expect(result.ok).toBe(false);
  });
});

describe("changeTicketStatus", () => {
  it("patches a valid status and revalidates", async () => {
    signIn(["read", "respond"]);
    vi.mocked(patchTicketStatus).mockResolvedValue(undefined);

    const result = await changeTicketStatus(TICKET_ID, "resolved");

    expect(result).toEqual({ ok: true });
    expect(patchTicketStatus).toHaveBeenCalledWith(
      TICKET_ID,
      "resolved",
      "tx_session=abc",
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/tickets/${TICKET_ID}`);
  });

  it("rejects a status outside the contract without calling the API", async () => {
    signIn(["read", "respond"]);
    const result = await changeTicketStatus(TICKET_ID, "reopened");
    expect(result.ok).toBe(false);
    expect(patchTicketStatus).not.toHaveBeenCalled();
  });

  it("refuses without the respond capability", async () => {
    signIn(["read"]);
    const result = await changeTicketStatus(TICKET_ID, "resolved");
    expect(result.ok).toBe(false);
    expect(patchTicketStatus).not.toHaveBeenCalled();
  });
});
```

If `vi.stubEnv` conflicts with the suite's env handling, add `vi.unstubAllEnvs()` in an `afterEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- "app/(console)/platform/tickets"`
Expected: FAIL — `./actions` does not exist.

- [ ] **Step 3: Implement `actions.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { postTicketReply, patchTicketStatus } from "@/lib/platform-api";
import { isTicketStatus } from "@/lib/tickets";

export type TicketActionResult = { ok: true } | { ok: false; message: string };

// Matches apps/web's replySchema ceiling; enforced here too so an over-long
// reply fails with a message instead of an opaque 400.
const MAX_REPLY_LENGTH = 10_000;

async function withRespond(
  run: (cookieHeader: string) => Promise<void>,
): Promise<TicketActionResult> {
  try {
    const session = await getCurrentSession();
    checkOperatorCapability(session, "respond");
    await run((await cookies()).toString());
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "The reply was not saved.",
    };
  }
}

export async function replyToTicket(
  ticketId: string,
  content: string,
): Promise<TicketActionResult> {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Write a reply before sending." };
  }
  if (trimmed.length > MAX_REPLY_LENGTH) {
    return { ok: false, message: "Replies are limited to 10,000 characters." };
  }
  const result = await withRespond((cookieHeader) =>
    postTicketReply(ticketId, { content: trimmed }, cookieHeader),
  );
  if (result.ok) {
    revalidatePath(`/platform/tickets/${ticketId}`);
  }
  return result;
}

export async function changeTicketStatus(
  ticketId: string,
  status: string,
): Promise<TicketActionResult> {
  if (!isTicketStatus(status)) {
    return { ok: false, message: `"${status}" is not a ticket status.` };
  }
  const result = await withRespond((cookieHeader) =>
    patchTicketStatus(ticketId, status, cookieHeader),
  );
  if (result.ok) {
    revalidatePath(`/platform/tickets/${ticketId}`);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- "app/(console)/platform/tickets"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/(console)/platform/tickets/[id]/actions.ts" "apps/console/app/(console)/platform/tickets/[id]/actions.test.ts"
git commit -m "feat(console): reply and status-transition server actions gated on respond"
```

---

### Task 5: Detail page, thread, reply form, status control — and the queue href fix

**Files:**
- Create: `apps/console/app/(console)/platform/tickets/[id]/page.tsx`
- Create: `apps/console/app/(console)/platform/tickets/[id]/ticket-thread.tsx`
- Create: `apps/console/app/(console)/platform/tickets/[id]/respond-controls.tsx`
- Modify: `apps/console/app/(console)/platform/tickets/page.tsx:39` (href: ticketNumber → id)
- Test: `apps/console/app/(console)/platform/tickets/[id]/ticket-thread.render.test.tsx`

**Interfaces:**
- Consumes: `fetchTicketDetail` (Task 2), `TicketDetail`/`TicketReply` (Task 1), `replyToTicket`/`changeTicketStatus`/`TicketActionResult` (Task 4), `DetailLayout` and `SurfaceState` from the kit, `triageState` from `@/lib/triage`, `severityOf` from `@/lib/tickets`, `getCurrentSession`/`hasCapability` from `@tesserix/platform-auth`, `requiresCapability` from `@/lib/internal-access`, `notFound` from `next/navigation`.
- Produces: the routed surface `/platform/tickets/[id]`.

- [ ] **Step 1: Write the failing render test for the thread**

Create `ticket-thread.render.test.tsx` (jsdom, same style as the kit's `*.render.test.tsx` files):

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TicketThread } from "./ticket-thread";
import type { TicketDetail } from "@/lib/tickets";

const DETAIL: TicketDetail = {
  ticket: {
    id: "5f0b2c34-0000-0000-0000-000000000000",
    productId: "mark8ly",
    tenantId: "",
    ticketNumber: "M8-1042",
    subject: "Payout missing",
    description: "The Friday payout never arrived.",
    status: "open",
    priority: "urgent",
    submittedByName: "Asha Pillai",
    submittedByEmail: "asha@example.com",
    resolvedAt: null,
    createdAt: "2026-08-10T04:00:00.000Z",
    updatedAt: "2026-08-11T04:00:00.000Z",
  },
  replies: [
    {
      id: "r1",
      authorType: "platform_admin",
      authorName: "Mahesh",
      authorEmail: "mahesh.sangawar@gmail.com",
      content: "Looking into it now.",
      createdAt: "2026-08-11T04:00:00.000Z",
    },
  ],
};

describe("TicketThread", () => {
  it("opens with the ticket description attributed to the submitter", () => {
    render(<TicketThread detail={DETAIL} />);
    expect(
      screen.getByText("The Friday payout never arrived."),
    ).toBeInTheDocument();
    expect(screen.getByText("Asha Pillai")).toBeInTheDocument();
  });

  it("labels operator replies as the platform's, not the customer's", () => {
    render(<TicketThread detail={DETAIL} />);
    expect(screen.getByText("Looking into it now.")).toBeInTheDocument();
    expect(screen.getByText(/platform/i)).toBeInTheDocument();
  });

  it("renders an empty thread as just the description", () => {
    render(<TicketThread detail={{ ...DETAIL, replies: [] }} />);
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- ticket-thread`
Expected: FAIL — `./ticket-thread` does not exist.

- [ ] **Step 3: Implement `ticket-thread.tsx`**

Presentational, no client directive needed (rendered inside the DetailLayout tab). Whitespace is preserved with `whitespace-pre-wrap` — replies are plain text, never HTML:

```tsx
import type { TicketDetail, TicketReply } from "@/lib/tickets";

interface TicketThreadProps {
  detail: TicketDetail;
}

function Message({
  author,
  meta,
  when,
  children,
  operator,
}: {
  author: string;
  meta?: string;
  when: string;
  children: string;
  operator: boolean;
}) {
  return (
    <article
      className={`rounded-md border p-4 ${
        operator ? "border-border bg-muted/40" : "border-border"
      }`}
    >
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium">{author}</span>
        {meta ? (
          <span className="text-xs text-muted-foreground">{meta}</span>
        ) : null}
        <time
          dateTime={when}
          className="ml-auto text-xs text-muted-foreground"
        >
          {new Date(when).toLocaleString()}
        </time>
      </header>
      <p className="whitespace-pre-wrap text-sm">{children}</p>
    </article>
  );
}

/**
 * The conversation, oldest first: the ticket's own description opens the
 * thread (it is the customer's first message, not metadata), then each reply
 * attributed to its author. `author_type` decides the label — a platform
 * reply must never read as the customer's words.
 */
export function TicketThread({ detail }: TicketThreadProps) {
  const { ticket, replies } = detail;
  return (
    <div className="flex flex-col gap-3">
      <Message
        author={ticket.submittedByName || ticket.submittedByEmail}
        meta={ticket.submittedByEmail}
        when={ticket.createdAt}
        operator={false}
      >
        {ticket.description}
      </Message>
      {replies.map((reply: TicketReply) => (
        <Message
          key={reply.id}
          author={reply.authorName || reply.authorEmail}
          meta={reply.authorType === "platform_admin" ? "platform" : undefined}
          when={reply.createdAt}
          operator={reply.authorType === "platform_admin"}
        >
          {reply.content}
        </Message>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- ticket-thread`
Expected: PASS.

- [ ] **Step 5: Implement `respond-controls.tsx` (client)**

The two verbs' UI. Uses the kit's form primitives; errors render inline, success clears the form (the server action already revalidated the page data):

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, CalloutDescription, Textarea } from "@tesserix/web";
import { TICKET_STATUSES, type TicketStatus } from "@/lib/tickets";
import {
  changeTicketStatus,
  replyToTicket,
  type TicketActionResult,
} from "./actions";

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

export function StatusControl({
  ticketId,
  status,
}: {
  ticketId: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="ticket-status" className="sr-only">
        Ticket status
      </label>
      <select
        id="ticket-status"
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        value={TICKET_STATUSES.includes(status as TicketStatus) ? status : ""}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          setError(null);
          startTransition(async () => {
            const result: TicketActionResult = await changeTicketStatus(
              ticketId,
              next,
            );
            if (!result.ok) {
              setError(result.message);
            }
            router.refresh();
          });
        }}
      >
        {!TICKET_STATUSES.includes(status as TicketStatus) ? (
          <option value="" disabled>
            {status}
          </option>
        ) : null}
        {TICKET_STATUSES.map((value) => (
          <option key={value} value={value}>
            {STATUS_LABELS[value]}
          </option>
        ))}
      </select>
      {error ? <span className="text-sm text-destructive">{error}</span> : null}
    </div>
  );
}

export function ReplyForm({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await replyToTicket(ticketId, content);
          if (result.ok) {
            setContent("");
          } else {
            setError(result.message);
          }
          router.refresh();
        });
      }}
    >
      <label htmlFor="ticket-reply" className="text-sm font-medium">
        Reply
      </label>
      <Textarea
        id="ticket-reply"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={4}
        placeholder="Write a reply to the submitter…"
        disabled={pending}
      />
      {error ? (
        <Callout variant="destructive">
          <CalloutDescription>{error}</CalloutDescription>
        </Callout>
      ) : null}
      <div>
        <Button type="submit" disabled={pending || content.trim().length === 0}>
          {pending ? "Sending…" : "Send reply"}
        </Button>
      </div>
    </form>
  );
}
```

Check `@tesserix/web`'s exports before using `Textarea`/`Callout` variants: `grep -o 'Textarea\|Callout[A-Za-z]*' node_modules/@tesserix/web/dist/index.d.ts | sort -u` (from `apps/console/`). If `Textarea` is absent, use a styled `<textarea>` with the same classes as the select above; if `Callout` lacks a `variant` prop, render the plain `Callout` — states.tsx shows both in use.

- [ ] **Step 6: Implement `page.tsx` (server)**

```tsx
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { DetailLayout } from "@/components/kit/detail-layout";
import { type SurfaceState } from "@/components/kit/states";
import { fetchTicketDetail, PlatformApiError } from "@/lib/platform-api";
import { severityOf, type TicketDetail } from "@/lib/tickets";
import { triageState } from "@/lib/triage";
import { requiresCapability } from "@/lib/internal-access";
import { TicketThread } from "./ticket-thread";
import { ReplyForm, StatusControl } from "./respond-controls";

/**
 * One ticket, keyed by UUID — the API supports only id lookup, and a
 * number-lookup endpoint in apps/web is ruled out for surfaces awaiting
 * their milestone.
 *
 * The respond controls render only for operators holding `respond`; the
 * server actions assert it again regardless, because hiding a button is
 * UX, not authorization.
 */
export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieHeader = (await cookies()).toString();

  let detail: TicketDetail | null = null;
  let error: unknown = null;
  try {
    detail = await fetchTicketDetail(id, cookieHeader);
  } catch (caught) {
    if (caught instanceof PlatformApiError && caught.status === 404) {
      notFound();
    }
    error = caught;
  }

  const session = await getCurrentSession();
  const canRespond =
    !requiresCapability() || hasCapability(session?.roles, "respond");

  const state: SurfaceState = triageState(error, null);

  if (!detail) {
    return (
      <DetailLayout
        title="Ticket"
        breadcrumbs={[{ label: "Tickets", href: "/platform/tickets" }]}
        summary={[]}
        tabs={[]}
        state={state}
      />
    );
  }

  const { ticket } = detail;
  return (
    <DetailLayout
      title={`${ticket.ticketNumber} — ${ticket.subject}`}
      breadcrumbs={[{ label: "Tickets", href: "/platform/tickets" }]}
      actions={
        canRespond ? (
          <StatusControl ticketId={ticket.id} status={ticket.status} />
        ) : undefined
      }
      summary={[
        { label: "Product", value: ticket.productId },
        { label: "Status", value: ticket.status },
        {
          label: "Priority",
          value: `${ticket.priority}${
            severityOf(ticket.priority) === "critical" ? " — critical" : ""
          }`,
        },
        {
          label: "Submitted by",
          value: ticket.submittedByName
            ? `${ticket.submittedByName} · ${ticket.submittedByEmail}`
            : ticket.submittedByEmail,
        },
        {
          label: "Opened",
          value: new Date(ticket.createdAt).toLocaleString(),
        },
        ...(ticket.resolvedAt
          ? [
              {
                label: "Resolved",
                value: new Date(ticket.resolvedAt).toLocaleString(),
              },
            ]
          : []),
      ]}
      tabs={[
        {
          id: "conversation",
          label: "Conversation",
          content: (
            <div className="flex flex-col gap-6">
              <TicketThread detail={detail} />
              {canRespond ? <ReplyForm ticketId={ticket.id} /> : null}
            </div>
          ),
        },
      ]}
    />
  );
}
```

Check `Breadcrumbable`'s shape in `components/kit/page-header.tsx` and match it. Verify `DetailLayout` accepts server-rendered children in tab content (it is a client component receiving `ReactNode` — this is the standard RSC-in-client-slot pattern and works).

- [ ] **Step 7: Fix the queue href**

In `apps/console/app/(console)/platform/tickets/page.tsx` line 39, change:

```tsx
    href: `/platform/tickets/${ticket.ticketNumber}`,
```

to:

```tsx
    // The UUID, not the number: the detail API supports only id lookup.
    href: `/platform/tickets/${ticket.id}`,
```

- [ ] **Step 8: Run the whole suite, typecheck and lint**

Run (from `apps/console/`): `npm run test:unit && npm run typecheck && npm run lint`
Expected: all green. Fix any type or lint fallout before committing.

- [ ] **Step 9: Commit**

```bash
git add "apps/console/app/(console)/platform/tickets"
git commit -m "feat(console): ticket detail with reply and status transition"
```

---

### Task 6: Verify in the running app

- [ ] **Step 1: Build the console**

Run (from `apps/console/`): `npm run build`
Expected: clean production build, `/platform/tickets/[id]` in the route list.

- [ ] **Step 2: Manual smoke against local dev**

Start apps/web (`npm run dev` in `apps/web/`, port 3002) and the console (`npm run dev` in `apps/console/`, port 3003) with a valid local session. Open the queue, click a ticket:
- Detail renders thread with the description first.
- Send a reply → it appears in the thread, attributed to your session's name.
- Change status → summary rail updates.
- A bogus UUID path (`/platform/tickets/00000000-0000-0000-0000-000000000000`) renders the not-found page, not an error digest.

If no local DB rows exist, the handoff notes only the error path was provable locally — record whatever could and could not be verified in the PR body rather than claiming a green smoke.

- [ ] **Step 3: Commit any fixes surfaced by the smoke, same single-line style**
