# Tools Management Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an operator holding `platform` can add, edit, remove and reorder internal tools and their groups from `/platform/tools`, with no deploy and no `curl`.

**Architecture:** a new console route rendering a grouped management view over the existing `readToolsDirectory()` loader; writes go through one new seam (`lib/tools-write.ts`) that checks capability and calls the `/v1/platform/tools` API — and deliberately does NOT audit, because the Go module already writes the audit row inside `write.Perform`'s transaction.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Vitest, `@tesserix/web` (`button`, `dialog`, `input`, `label`, `select` — all verified present), `@tesserix/platform-auth`.

**Spec:** `docs/superpowers/specs/2026-08-22-console-tools-management-surface-design.md`

## Global Constraints

- **The seam must not audit.** `write.Perform` in the Go module already records the audit row. A console-side `auditedOperation` would put TWO rows in `console_audit_log` for one edit, the second written outside the transaction that did the work.
- **No client-side subdomain validation.** The rule exists twice already (Go `domain.SubdomainPattern`, migration 0031's CHECK) with a drift test binding them. Forms validate presence only; the API's 422 is the authority.
- **No status field.** Whether a tool is up belongs to the health strip. Refused since `tools.ts` was written; the Go module repeats it.
- **Capability:** `platform` for every write; controls render only when `!requiresCapability() || hasCapability(session?.roles, "platform")`.
- **The surface is absent when `PLATFORM_API_ORIGIN` is unset.**
- **Never derive `sort_order` from a render index.** See Task 6.
- CI lints at `--max-warnings 0`. `tsc` is not a build — run `npm run build`.
- Single-line conventional commits, no signatures, no co-author trailers.

**Commands, from `apps/console` unless stated:**
```
npm run test:unit -- <path>     # one file
npm run test:unit               # all
npm run lint                    # --max-warnings 0
npm run build                   # the only check that catches a server-only leak
```

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `apps/console/lib/tools-write.ts` | Write seam: session + capability + API call + error mapping. No audit. |
| `apps/console/lib/tools-write.test.ts` | Seam branches and every error mapping |
| `apps/console/app/(console)/platform/tools/page.tsx` | Server component: three gates, then the grouped view |
| `apps/console/app/(console)/platform/tools/page.render.test.tsx` | The four render states |
| `apps/console/app/(console)/platform/tools/actions.ts` | Eight server actions |
| `apps/console/app/(console)/platform/tools/actions.test.ts` | Actions against a mocked seam, incl. revalidation |
| `apps/console/components/tools-admin/tools-manager.tsx` | Client: the grouped view and its controls |
| `apps/console/components/tools-admin/tool-form.tsx` | Client: add/edit dialog for a tool |
| `apps/console/components/tools-admin/group-form.tsx` | Client: add/rename dialog for a group |
| `apps/console/components/tools-admin/tools-manager.render.test.tsx` | Render tests incl. the empty-group case |

**Modify:**

| Path | Change |
|---|---|
| `packages/console-core/src/routes.ts` | Add `platform.tools` |
| `packages/console-core/src/routes.test.ts` | Cover the new entry |
| `apps/console/lib/tools-directory.ts` | Carry `sortOrder` (Task 6) |
| `apps/console/lib/tools-directory.test.ts` | Cover it |
| `apps/console/components/internal-tools.tsx` | Comment only: state the empty-group divergence |

---

## Task 1: The route and the three gates

**Files:**
- Modify: `packages/console-core/src/routes.ts`
- Modify: `packages/console-core/src/routes.test.ts`
- Create: `apps/console/app/(console)/platform/tools/page.tsx`
- Create: `apps/console/components/tools-admin/tools-manager.tsx` (read-only for now)
- Test: `apps/console/app/(console)/platform/tools/page.render.test.tsx`

**Interfaces:**
- Consumes: `readToolsDirectory()` from `@/lib/tools-directory` returning `{ groups, tools, source }`, `source: "platform-api" | "builtin" | "degraded"`.
- Produces: route id `platform.tools`; `<ToolsManager directory={ToolsDirectory} />`.

- [ ] **Step 1: Add the route**

In `packages/console-core/src/routes.ts`, after `platform.dashboard` (line 132):

```ts
  // Managing the internal tools directory (#318 follow-up). `platform`
  // because every write on /v1/platform/tools requires it — the two READS
  // moved to `read` so the home page's directory renders for everyone, and
  // this surface is the other half of that split: one place where the write
  // affordances live, so the UI's gate and the API's cannot drift.
  "platform.tools": { console: "/platform/tools", capability: "platform" },
```

No `web` or `mobile` path: this surface exists only in the console. That is
expressible — `web?: string` is optional (`routes.ts:28`) and
`platform.auditLog` (`routes.ts:250`) already omits it. Verified, not assumed.

- [ ] **Step 2: Cover it in the route table's test**

The table is exported as `ROUTES` (`ROUTE_IDS` is derived from it at
`routes.ts:341`). Verified. Add to `packages/console-core/src/routes.test.ts`:

```ts
it("declares the tools surface on the console only, gated on platform", () => {
  const route = ROUTES["platform.tools"];
  expect(route.console).toBe("/platform/tools");
  expect(route.capability).toBe("platform");
  // Deliberately console-only: apps/web has no directory management and is
  // being retired. A `web` path here would put a link in a rail that leads
  // nowhere.
  expect(route.web).toBeUndefined();
});
```

- [ ] **Step 3: Run console-core's tests and rebuild its dist**

```
cd packages/console-core && npx vitest run src/routes.test.ts && npm run build
```
Expected: PASS. The rebuild matters — `dist/` is gitignored and the console's
type-checker reads it, so a new route id is invisible until it is rebuilt.

- [ ] **Step 4: Write the failing page render test**

Create `apps/console/app/(console)/platform/tools/page.render.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tools-directory", () => ({ readToolsDirectory: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: vi.fn(),
  hasCapability: vi.fn(),
}));
vi.mock("@/lib/internal-access", () => ({ requiresCapability: vi.fn() }));

import { readToolsDirectory } from "@/lib/tools-directory";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { requiresCapability } from "@/lib/internal-access";
import ToolsPage from "./page";

const DIRECTORY = {
  source: "platform-api" as const,
  groups: [{ key: "identity", label: "Identity and secrets", sortOrder: 1 }],
  tools: [
    {
      id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity.",
      note: null, groupKey: "identity", sortOrder: 1,
    },
  ],
};

afterEach(() => vi.resetAllMocks());

function allow() {
  vi.mocked(requiresCapability).mockReturnValue(true);
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "op-1", email: "op@t.test", roles: ["platform"],
  } as never);
  vi.mocked(hasCapability).mockReturnValue(true);
}

describe("the tools management page", () => {
  it("renders the directory for an operator holding platform", async () => {
    allow();
    vi.mocked(readToolsDirectory).mockResolvedValue(DIRECTORY);

    render(await ToolsPage());

    expect(screen.getByText("Zitadel")).toBeInTheDocument();
    expect(screen.getByText("Identity and secrets")).toBeInTheDocument();
  });

  it("refuses an operator without platform, and shows no directory", async () => {
    vi.mocked(requiresCapability).mockReturnValue(true);
    vi.mocked(getCurrentSession).mockResolvedValue({
      sub: "op-2", email: "op2@t.test", roles: ["crm"],
    } as never);
    vi.mocked(hasCapability).mockReturnValue(false);
    vi.mocked(readToolsDirectory).mockResolvedValue(DIRECTORY);

    render(await ToolsPage());

    // Not merely "controls hidden" — the surface itself is refused. Rendering
    // the directory here leaks nothing, but it tells an operator this page is
    // theirs when none of it works.
    expect(screen.queryByText("Zitadel")).not.toBeInTheDocument();
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
  });

  it("explains itself when the platform API is switched off", async () => {
    allow();
    vi.mocked(readToolsDirectory).mockResolvedValue({ ...DIRECTORY, source: "builtin" });

    render(await ToolsPage());

    expect(screen.getByText(/switched off/i)).toBeInTheDocument();
    expect(screen.queryByText("Zitadel")).not.toBeInTheDocument();
  });

  it("distinguishes an unreachable API from a switched-off one", async () => {
    allow();
    vi.mocked(readToolsDirectory).mockResolvedValue({ ...DIRECTORY, source: "degraded" });

    render(await ToolsPage());

    // Two different problems with two different remedies. Collapsing them is
    // the defect three-valued `source` was introduced to fix.
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
    expect(screen.queryByText(/switched off/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

```
npm run test:unit -- "app/(console)/platform/tools/page.render.test.tsx"
```
Expected: cannot resolve `./page`.

- [ ] **Step 6: Write the page**

Create `apps/console/app/(console)/platform/tools/page.tsx`:

```tsx
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { requiresCapability } from "@/lib/internal-access";
import { readToolsDirectory } from "@/lib/tools-directory";
import { ToolsManager } from "@/components/tools-admin/tools-manager";

/**
 * Managing the internal tools directory.
 *
 * Three gates before anything is editable, answering three different
 * questions with three different remedies:
 *
 *   - `platform` capability — may you.
 *   - PLATFORM_API_ORIGIN unset — the console is serving the built-in literal
 *     and there is nothing to write to. Switched off; the remedy is
 *     configuration, not retrying.
 *   - source === "degraded" — the origin IS set and the API could not be
 *     reached. The remedy is to find out why, and retrying may work.
 *
 * Collapsing the last two into one message is the exact defect that
 * three-valued `DirectorySource` was introduced to fix, one layer up.
 */
export default async function ToolsPage() {
  const session = await getCurrentSession();
  const mayManage = !requiresCapability() || hasCapability(session?.roles, "platform");

  if (!mayManage) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          You do not have permission to manage the tools directory. It needs the
          platform capability.
        </p>
      </Shell>
    );
  }

  const directory = await readToolsDirectory();

  if (directory.source === "builtin") {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          Directory management is switched off. The console is serving the
          built-in list because PLATFORM_API_ORIGIN is not set, so there is
          nothing to edit.
        </p>
      </Shell>
    );
  }

  if (directory.source === "degraded") {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          The platform API could not be reached, so the directory cannot be
          edited right now. The home page is showing the built-in list.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ToolsManager directory={directory} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Tools directory"
        description="What the console links to, and how it is grouped."
      />
      {children}
    </div>
  );
}
```

`ConsolePageHeader`'s `title`/`description` props are the ones the console
home page already passes (`app/(console)/page.tsx`), so they are right.

- [ ] **Step 7: Write the read-only manager**

Create `apps/console/components/tools-admin/tools-manager.tsx`:

```tsx
"use client";

import type { ToolsDirectory } from "@/lib/tools-directory";

/**
 * The grouped management view. Task 1 renders it read-only so the page's
 * gates can be tested on their own; Tasks 4-7 add the controls.
 *
 * `import type` for ToolsDirectory, never a value import: lib/tools-directory
 * begins with `import "server-only"` and this is a client component. tsc
 * cannot tell the two apart — only the bundler can, which is why Step 8 runs
 * the build.
 */
export function ToolsManager({ directory }: { directory: ToolsDirectory }) {
  return (
    <div className="flex flex-col gap-6">
      {directory.groups.map((group) => {
        const tools = directory.tools.filter((tool) => tool.groupKey === group.key);
        return (
          <section key={group.key} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {group.label}
            </h3>
            {tools.length === 0 ? (
              // Shown here and NOT on the home page, deliberately — see the
              // comment in components/internal-tools.tsx. A group you just
              // created is empty, and hiding it would make creation look like
              // it silently failed.
              <p className="text-sm text-muted-foreground">No tools in this group yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {tools.map((tool) => (
                  <li key={tool.id} className="text-sm">
                    <span className="font-medium">{tool.name}</span>{" "}
                    <span className="text-muted-foreground">{tool.subdomain}</span>
                    {tool.note ? (
                      <span className="block text-xs text-muted-foreground">{tool.note}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 8: Run the tests, lint and build**

```
npm run test:unit -- "app/(console)/platform/tools/page.render.test.tsx"
npm run lint
npm run build
```
Expected: 4 PASS, lint clean, build green. The build matters: this is the first
client component importing a type from the `server-only` loader.

- [ ] **Step 9: Commit**

```bash
git add packages/console-core/src/routes.ts packages/console-core/src/routes.test.ts \
        "apps/console/app/(console)/platform/tools/" apps/console/components/tools-admin/
git commit -m "feat(console): add a gated tools directory management surface"
```

---

## Task 2: The write seam

**Files:**
- Create: `apps/console/lib/tools-write.ts`
- Test: `apps/console/lib/tools-write.test.ts`

**Interfaces:**
- Consumes: `platformRequestWithMeta` from `@/lib/platform-api`; `PlatformApiError` from `@/lib/platform-api-error`; `checkOperatorCapability` from `@/lib/auth/operator`; `getCurrentSession`, `CapabilityError` from `@tesserix/platform-auth`.
- Produces: `type ToolsWriteResult = { ok: true } | { ok: false; message: string; field?: string }`, `interface ToolInput`, and `createTool`, `updateTool`, `deleteTool`, `createGroup`, `updateGroup`, `deleteGroup`.

- [ ] **Step 1: Write the failing test**

Create `apps/console/lib/tools-write.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/auth/operator", () => ({ checkOperatorCapability: vi.fn() }));
vi.mock("@/lib/platform-api", () => ({
  platformApiOrigin: vi.fn(() => "https://api.test"),
  platformRequestWithMeta: vi.fn(),
}));

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import { createTool, deleteGroup, updateTool } from "./tools-write";

afterEach(() => vi.resetAllMocks());

function signedIn() {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "op-1", email: "op@t.test", roles: ["platform"],
  } as never);
  vi.mocked(checkOperatorCapability).mockReturnValue(undefined as never);
}

const TOOL = {
  name: "Tempo", subdomain: "tempo", purpose: "Traces.",
  note: null, groupKey: "observability",
};

describe("the tools write seam", () => {
  it("creates a tool and reports success", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: {}, meta: null });

    const result = await createTool(TOOL);

    expect(result).toEqual({ ok: true });
    const [, path, init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
    expect(path).toBe("/v1/platform/tools");
    expect(init?.method).toBe("POST");
  });

  it("refuses without the capability, and never calls the API", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue({ sub: "op-2", roles: ["crm"] } as never);
    vi.mocked(checkOperatorCapability).mockImplementation(() => {
      throw new CapabilityError("platform");
    });

    const result = await createTool(TOOL);

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/permission/i) });
    // The API is the real boundary and would refuse anyway. This asserts the
    // console does not send a request it knows will be refused.
    expect(platformRequestWithMeta).not.toHaveBeenCalled();
  });

  it("turns a 422 into a field error carrying the API's own message", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError(
        "tools: VALIDATION_ERROR — a subdomain must be a single DNS label — lower-case letters, digits and hyphens",
        422,
      ),
    );

    const result = await createTool({ ...TOOL, subdomain: "https://grafana.example" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The API's sentence survives intact, INCLUDING its own em-dash. Stripping
    // the label and the SCREAMING_SNAKE code must not eat the message.
    expect(result.message).toBe(
      "a subdomain must be a single DNS label — lower-case letters, digits and hyphens",
    );
    expect(result.field).toBe("subdomain");
  });

  it("turns a 409 into a duplicate-subdomain message", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError("tools: CONFLICT — a tool with this subdomain already exists", 409),
    );

    const result = await createTool({ ...TOOL, subdomain: "auth" });

    expect(result).toEqual({
      ok: false,
      message: "A tool with this subdomain already exists.",
      field: "subdomain",
    });
  });

  it("turns a 404 into something that tells the operator to reload", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError("tools: NOT_FOUND — no tool with this id", 404),
    );

    const result = await updateTool("missing-id", { name: "x" });

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/removed.*reload/i) });
  });

  it("explains a group that still has tools rather than echoing the API", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError("tools: CONFLICT — the group still has tools in it", 409),
    );

    const result = await deleteGroup("identity");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/move or remove/i);
  });

  it("does not leak an unexpected failure's text to the operator", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:8080"));

    const result = await createTool(TOOL);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toMatch(/ECONNREFUSED/);
  });

  it("sends an explicit null note as null, so the API clears it", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: {}, meta: null });

    await updateTool("t1", { note: null });

    const [, , init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
    // Three states must survive the trip: absent leaves the note alone, null
    // clears it, a string sets it. Serialising an explicit null as "absent"
    // would make a note impossible to remove.
    expect(JSON.parse(String(init?.body))).toEqual({ note: null });
  });

  it("omits an absent note entirely rather than sending null", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: {}, meta: null });

    await updateTool("t1", { name: "Renamed" });

    const [, , init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Renamed" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
npm run test:unit -- lib/tools-write.test.ts
```
Expected: cannot resolve `./tools-write`.

- [ ] **Step 3: Write the seam**

Create `apps/console/lib/tools-write.ts`:

```ts
// `server-only`: this reads the operator's session and their platform API
// token. A client component importing it must fail the build.
import "server-only";

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";

/**
 * Every write to the internal tools directory goes through here.
 *
 * # Why this is a SIBLING of withCrmWrite and not a caller of it
 *
 * `lib/crm-write.ts` wraps `auditedOperation`, because a CRM write reaches
 * Postgres directly and nothing else would record it. A tools write does not:
 * the Go module records the audit row INSIDE `write.Perform`'s transaction,
 * bound to the row change and the idempotency record, so it cannot survive a
 * rollback of the thing it describes.
 *
 * Reusing withCrmWrite here would write TWO rows to console_audit_log for one
 * edit — and the second would be the less trustworthy of the pair. So this
 * wrapper does session, capability, request and error mapping, and no audit.
 *
 * # Why the capability is checked here as well as by the API
 *
 * The API is the authorisation boundary and answers 403 regardless. This check
 * exists so the console does not send a request it already knows will be
 * refused, and so the failure reads as "you do not have permission" rather
 * than as a transport error.
 */
export type ToolsWriteResult =
  | { ok: true }
  /** `field` names the form input to attach the message to, when the API's
   *  refusal is about one. Absent means it belongs at the form level. */
  | { ok: false; message: string; field?: string };

const NO_PERMISSION = "You do not have permission to change the tools directory.";
const NOT_SAVED = "That change was not saved. Try again shortly.";
const GONE = "That entry may have been removed — reload the page.";
const DUPLICATE_SUBDOMAIN = "A tool with this subdomain already exists.";
const DUPLICATE_GROUP = "A group with this key already exists.";
const GROUP_NOT_EMPTY = "Move or remove the tools in this group first.";

/**
 * Recover the API's own sentence from a PlatformApiError.
 *
 * `unwrapEnvelope` formats as `${label}: ${CODE} — ${message}`, and OUR
 * messages contain em-dashes of their own ("a subdomain must be a single DNS
 * label — lower-case letters..."), so splitting on the first " — " would
 * truncate them. The code is SCREAMING_SNAKE and our messages start
 * lower-case, so anchoring on the code is unambiguous where splitting is not.
 */
function apiMessage(error: PlatformApiError, label: string): string | undefined {
  const withoutLabel = error.message.startsWith(`${label}: `)
    ? error.message.slice(label.length + 2)
    : error.message;
  const match = /^[A-Z_]+ — (.+)$/s.exec(withoutLabel);
  return match?.[1];
}

/**
 * Which form field a 422 belongs to, inferred from the API's message.
 *
 * A guess, and deliberately a shallow one: the API does not say which field it
 * refused (its `details` carries request PARAMETERS; these are body fields).
 * Guessing wrong costs a message shown at form level instead of under an
 * input; not guessing costs every validation error appearing in the wrong
 * place. Confined to the two prefixes that are unmistakable.
 */
function fieldFor(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (message.startsWith("a subdomain")) return "subdomain";
  if (message.startsWith("a group key")) return "key";
  return undefined;
}

const LABEL = "tools";

async function withToolsWrite(
  run: () => Promise<unknown>,
  mapConflict: (message: string | undefined) => { message: string; field?: string },
): Promise<ToolsWriteResult> {
  try {
    const session = await getCurrentSession();
    checkOperatorCapability(session, "platform");
    await run();
    return { ok: true };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION };
    }
    if (cause instanceof PlatformApiError) {
      const message = apiMessage(cause, LABEL);
      switch (cause.status) {
        case 422:
          // The API's own words. It knows which rule was broken and says so in
          // a sentence an operator can act on; paraphrasing here would put a
          // second, staler copy of every validation message in the console.
          return { ok: false, message: message ?? NOT_SAVED, field: fieldFor(message) };
        case 409:
          return { ok: false, ...mapConflict(message) };
        case 404:
          return { ok: false, message: GONE };
        default:
          return { ok: false, message: NOT_SAVED };
      }
    }
    // Anything else — a transport failure, a bug — is not shown verbatim. An
    // operator cannot act on ECONNREFUSED and it names infrastructure.
    return { ok: false, message: NOT_SAVED };
  }
}

function write(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) {
  return platformRequestWithMeta(LABEL, path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

export interface ToolInput {
  name: string;
  subdomain: string;
  purpose: string;
  note: string | null;
  groupKey: string;
  sortOrder?: number;
}

export function createTool(input: ToolInput): Promise<ToolsWriteResult> {
  return withToolsWrite(
    () =>
      write("/v1/platform/tools", "POST", {
        name: input.name,
        subdomain: input.subdomain,
        purpose: input.purpose,
        note: input.note,
        group_key: input.groupKey,
        ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
      }),
    () => ({ message: DUPLICATE_SUBDOMAIN, field: "subdomain" }),
  );
}

/**
 * A partial change.
 *
 * `note` carries three states and all three must survive: absent leaves it
 * alone, an explicit `null` clears it, a string sets it. Hence the
 * `"note" in patch` test rather than a truthiness check — `null` is falsy and
 * would otherwise be dropped, making a note impossible to remove.
 */
export function updateTool(
  id: string,
  patch: Partial<Omit<ToolInput, "note">> & { note?: string | null },
): Promise<ToolsWriteResult> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.subdomain !== undefined) body.subdomain = patch.subdomain;
  if (patch.purpose !== undefined) body.purpose = patch.purpose;
  if (patch.groupKey !== undefined) body.group_key = patch.groupKey;
  if ("note" in patch) body.note = patch.note;
  if (patch.sortOrder !== undefined) body.sort_order = patch.sortOrder;

  return withToolsWrite(
    () => write(`/v1/platform/tools/${encodeURIComponent(id)}`, "PATCH", body),
    () => ({ message: DUPLICATE_SUBDOMAIN, field: "subdomain" }),
  );
}

export function deleteTool(id: string): Promise<ToolsWriteResult> {
  return withToolsWrite(
    () => write(`/v1/platform/tools/${encodeURIComponent(id)}`, "DELETE"),
    (message) => ({ message: message ?? NOT_SAVED }),
  );
}

export function createGroup(input: {
  key: string;
  label: string;
  sortOrder?: number;
}): Promise<ToolsWriteResult> {
  return withToolsWrite(
    () =>
      write("/v1/platform/tool-groups", "POST", {
        key: input.key,
        label: input.label,
        ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
      }),
    () => ({ message: DUPLICATE_GROUP, field: "key" }),
  );
}

/** The key is not changeable — every tool references it, and the API answers
 *  400 explaining what to do instead. Only label and position move. */
export function updateGroup(
  key: string,
  patch: { label?: string; sortOrder?: number },
): Promise<ToolsWriteResult> {
  const body: Record<string, unknown> = {};
  if (patch.label !== undefined) body.label = patch.label;
  if (patch.sortOrder !== undefined) body.sort_order = patch.sortOrder;

  return withToolsWrite(
    () => write(`/v1/platform/tool-groups/${encodeURIComponent(key)}`, "PATCH", body),
    (message) => ({ message: message ?? NOT_SAVED }),
  );
}

export function deleteGroup(key: string): Promise<ToolsWriteResult> {
  return withToolsWrite(
    () => write(`/v1/platform/tool-groups/${encodeURIComponent(key)}`, "DELETE"),
    () => ({ message: GROUP_NOT_EMPTY }),
  );
}
```

Confirm `checkOperatorCapability`'s signature in
`apps/console/lib/auth/operator.ts` — `crm-write.ts` calls it as
`checkOperatorCapability(session, capability)`, so it should match.

- [ ] **Step 4: Run the tests**

```
npm run test:unit -- lib/tools-write.test.ts
```
Expected: 9 PASS.

- [ ] **Step 5: Prove the em-dash handling is not accidental**

Temporarily replace `apiMessage`'s regex with a split on the first `" — "`
(`withoutLabel.split(" — ")[1]`). Re-run and confirm the 422 test FAILS by
truncating the message at the second em-dash. Restore. Report what failed — a
green suite after a fix is not evidence the fix was needed.

- [ ] **Step 6: Lint and commit**

```
npm run lint
git add apps/console/lib/tools-write.ts apps/console/lib/tools-write.test.ts
git commit -m "feat(console): add the tools directory write seam, without a second audit row"
```

---

## Task 3: The server actions

**Files:**
- Create: `apps/console/app/(console)/platform/tools/actions.ts`
- Test: `apps/console/app/(console)/platform/tools/actions.test.ts`

**Interfaces:**
- Consumes: every export of `@/lib/tools-write` (Task 2).
- Produces: `addToolAction`, `editToolAction`, `removeToolAction`, `moveToolAction`, `addGroupAction`, `renameGroupAction`, `removeGroupAction`, `moveGroupAction`, each returning `Promise<ToolsWriteResult>`.

- [ ] **Step 1: Write the failing test**

Create `apps/console/app/(console)/platform/tools/actions.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/tools-write", () => ({
  createTool: vi.fn(), updateTool: vi.fn(), deleteTool: vi.fn(),
  createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { createTool, deleteTool, updateTool } from "@/lib/tools-write";
import { addToolAction, moveToolAction, removeToolAction } from "./actions";

afterEach(() => vi.resetAllMocks());

const TOOL = {
  name: "Tempo", subdomain: "tempo", purpose: "Traces.",
  note: null, groupKey: "observability",
};

describe("the tools management actions", () => {
  it("revalidates BOTH the management page and the home page after a write", async () => {
    vi.mocked(createTool).mockResolvedValue({ ok: true });

    await addToolAction(TOOL);

    const paths = vi.mocked(revalidatePath).mock.calls.map(([p]) => p);
    // The home page renders the same directory. Revalidating only this page
    // leaves the cards stale until something else evicts them, which reads as
    // "the edit did not work".
    expect(paths).toContain("/platform/tools");
    expect(paths).toContain("/");
  });

  it("does NOT revalidate when the write failed", async () => {
    vi.mocked(createTool).mockResolvedValue({ ok: false, message: "nope" });

    const result = await addToolAction(TOOL);

    expect(result).toEqual({ ok: false, message: "nope" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("passes the seam's field through so a form can place the message", async () => {
    vi.mocked(createTool).mockResolvedValue({ ok: false, message: "bad", field: "subdomain" });

    const result = await addToolAction({ ...TOOL, subdomain: "!!" });

    expect(result).toEqual({ ok: false, message: "bad", field: "subdomain" });
  });

  it("swaps two tools' STORED sort orders, in two calls", async () => {
    vi.mocked(updateTool).mockResolvedValue({ ok: true });

    await moveToolAction({ id: "a", sortOrder: 10 }, { id: "b", sortOrder: 20 });

    // The real stored values, not render indices — see Task 6. Asserting BOTH
    // legs with swapped values is what stops a half-move shipping unnoticed.
    expect(updateTool).toHaveBeenCalledWith("a", { sortOrder: 20 });
    expect(updateTool).toHaveBeenCalledWith("b", { sortOrder: 10 });
  });

  it("reports the first failure of a move and does not revalidate", async () => {
    vi.mocked(updateTool)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, message: "second leg failed" });

    const result = await moveToolAction({ id: "a", sortOrder: 10 }, { id: "b", sortOrder: 20 });

    expect(result).toEqual({ ok: false, message: "second leg failed" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("removes a tool and revalidates", async () => {
    vi.mocked(deleteTool).mockResolvedValue({ ok: true });

    const result = await removeToolAction("tool-1");

    expect(result).toEqual({ ok: true });
    expect(deleteTool).toHaveBeenCalledWith("tool-1");
    expect(revalidatePath).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```
npm run test:unit -- "app/(console)/platform/tools/actions.test.ts"
```
Expected: cannot resolve `./actions`.

- [ ] **Step 3: Write the actions**

Create `apps/console/app/(console)/platform/tools/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import {
  createGroup,
  createTool,
  deleteGroup,
  deleteTool,
  updateGroup,
  updateTool,
  type ToolInput,
  type ToolsWriteResult,
} from "@/lib/tools-write";

/**
 * The eight writes this surface performs.
 *
 * Each is a thin shell: the seam owns the capability check, the request and
 * the error mapping, and these own revalidation. Revalidation covers BOTH this
 * page and "/" because the home page renders the same directory from the same
 * loader — refreshing only this page would leave the cards stale and make a
 * successful edit look like a failed one.
 *
 * Nothing here audits. The Go module already recorded the row; see
 * lib/tools-write.ts.
 */
function refresh(): void {
  revalidatePath("/platform/tools");
  revalidatePath("/");
}

/** Revalidate on success only. A failed write changed nothing, and evicting
 *  the cache would send every reader back to the API for the same answer. */
function settle(result: ToolsWriteResult): ToolsWriteResult {
  if (result.ok) refresh();
  return result;
}

export async function addToolAction(input: ToolInput): Promise<ToolsWriteResult> {
  return settle(await createTool(input));
}

export async function editToolAction(
  id: string,
  patch: Partial<Omit<ToolInput, "note">> & { note?: string | null },
): Promise<ToolsWriteResult> {
  return settle(await updateTool(id, patch));
}

export async function removeToolAction(id: string): Promise<ToolsWriteResult> {
  return settle(await deleteTool(id));
}

/**
 * Swap two tools' positions by exchanging their stored `sort_order`.
 *
 * TWO PATCHes, and deliberately not atomic — the API has no reorder endpoint.
 * If the second fails, both rows briefly share a sort_order; the API orders by
 * `g.sort_order, t.sort_order, t.name`, so the tie breaks by name and the page
 * still renders deterministically. The operator retries. Stated in the spec
 * rather than discovered in production.
 */
export async function moveToolAction(
  moving: { id: string; sortOrder: number },
  neighbour: { id: string; sortOrder: number },
): Promise<ToolsWriteResult> {
  const first = await updateTool(moving.id, { sortOrder: neighbour.sortOrder });
  if (!first.ok) return first;
  const second = await updateTool(neighbour.id, { sortOrder: moving.sortOrder });
  if (!second.ok) return second;
  refresh();
  return { ok: true };
}

export async function addGroupAction(input: {
  key: string;
  label: string;
}): Promise<ToolsWriteResult> {
  return settle(await createGroup(input));
}

export async function renameGroupAction(key: string, label: string): Promise<ToolsWriteResult> {
  return settle(await updateGroup(key, { label }));
}

export async function removeGroupAction(key: string): Promise<ToolsWriteResult> {
  return settle(await deleteGroup(key));
}

/** The group equivalent of moveToolAction, with the same non-atomicity. */
export async function moveGroupAction(
  moving: { key: string; sortOrder: number },
  neighbour: { key: string; sortOrder: number },
): Promise<ToolsWriteResult> {
  const first = await updateGroup(moving.key, { sortOrder: neighbour.sortOrder });
  if (!first.ok) return first;
  const second = await updateGroup(neighbour.key, { sortOrder: moving.sortOrder });
  if (!second.ok) return second;
  refresh();
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests and lint**

```
npm run test:unit -- "app/(console)/platform/tools/actions.test.ts"
npm run lint
```
Expected: 6 PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/(console)/platform/tools/actions.ts" \
        "apps/console/app/(console)/platform/tools/actions.test.ts"
git commit -m "feat(console): add the tools directory server actions"
```

---

## Task 4: The tool form and row controls

**Files:**
- Create: `apps/console/components/tools-admin/tool-form.tsx`
- Modify: `apps/console/components/tools-admin/tools-manager.tsx`
- Test: `apps/console/components/tools-admin/tools-manager.render.test.tsx`

**Interfaces:**
- Consumes: `addToolAction`, `editToolAction`, `removeToolAction` (Task 3); `ToolsDirectory`, `DirectoryTool`, `DirectoryGroup` (type-only).
- Produces: `<ToolForm />`, and a `ToolsManager` with per-tool Edit and Delete.

- [ ] **Step 1: Write the failing render test**

Create `apps/console/components/tools-admin/tools-manager.render.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(console)/platform/tools/actions", () => ({
  addToolAction: vi.fn(async () => ({ ok: true })),
  editToolAction: vi.fn(async () => ({ ok: true })),
  removeToolAction: vi.fn(async () => ({ ok: true })),
  moveToolAction: vi.fn(async () => ({ ok: true })),
  addGroupAction: vi.fn(async () => ({ ok: true })),
  renameGroupAction: vi.fn(async () => ({ ok: true })),
  removeGroupAction: vi.fn(async () => ({ ok: true })),
  moveGroupAction: vi.fn(async () => ({ ok: true })),
}));

import { addToolAction, removeToolAction } from "@/app/(console)/platform/tools/actions";
import { ToolsManager } from "./tools-manager";
import type { ToolsDirectory } from "@/lib/tools-directory";

const DIRECTORY: ToolsDirectory = {
  source: "platform-api",
  groups: [
    { key: "identity", label: "Identity and secrets", sortOrder: 10 },
    { key: "empty", label: "Nothing here yet", sortOrder: 20 },
  ],
  tools: [
    {
      id: "t1", name: "Zitadel", subdomain: "auth", purpose: "Identity platform.",
      note: null, groupKey: "identity", sortOrder: 10,
    },
    {
      id: "t2", name: "Secret service", subdomain: "secret-service", purpose: "Secrets.",
      note: "Separate login.", groupKey: "identity", sortOrder: 20,
    },
  ],
};

afterEach(() => vi.resetAllMocks());

describe("ToolsManager", () => {
  it("shows an empty group rather than hiding it", () => {
    render(<ToolsManager directory={DIRECTORY} />);

    // The home page skips empty groups; this surface must not. A group you
    // just created is empty, and hiding it makes creation look like it failed.
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByText(/no tools in this group yet/i)).toBeInTheDocument();
  });

  it("renders a tool's note where it has one", () => {
    render(<ToolsManager directory={DIRECTORY} />);
    expect(screen.getByText("Separate login.")).toBeInTheDocument();
  });

  it("adds a tool through the action", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getAllByRole("button", { name: /add tool/i })[0]);
    await user.type(screen.getByLabelText(/name/i), "Tempo");
    await user.type(screen.getByLabelText(/subdomain/i), "tempo");
    await user.type(screen.getByLabelText(/purpose/i), "Distributed traces.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(addToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Tempo", subdomain: "tempo", purpose: "Distributed traces.",
      }),
    );
  });

  it("sends an empty note as null rather than an empty string", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getAllByRole("button", { name: /add tool/i })[0]);
    await user.type(screen.getByLabelText(/name/i), "Tempo");
    await user.type(screen.getByLabelText(/subdomain/i), "tempo");
    await user.type(screen.getByLabelText(/purpose/i), "Traces.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(addToolAction).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  it("puts a field-scoped refusal under the field it names", async () => {
    const user = userEvent.setup();
    vi.mocked(addToolAction).mockResolvedValue({
      ok: false,
      message: "a subdomain must be a single DNS label",
      field: "subdomain",
    });
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getAllByRole("button", { name: /add tool/i })[0]);
    await user.type(screen.getByLabelText(/name/i), "Bad");
    await user.type(screen.getByLabelText(/subdomain/i), "https://x.example");
    await user.type(screen.getByLabelText(/purpose/i), "x");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Beside the input, not at the top of the form — the whole point of the
    // seam carrying `field`.
    const field = screen.getByLabelText(/subdomain/i).closest("div");
    expect(within(field as HTMLElement).getByText(/single DNS label/i)).toBeInTheDocument();
  });

  it("confirms before deleting, and names the tool", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    const row = screen.getByText("Zitadel").closest("li");
    await user.click(within(row as HTMLElement).getByRole("button", { name: /^delete$/i }));

    // A confirmation that does not name the thing is a confirmation nobody
    // reads.
    expect(screen.getByText(/Zitadel/)).toBeInTheDocument();
    expect(removeToolAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^delete tool$/i }));
    expect(removeToolAction).toHaveBeenCalledWith("t1");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```
npm run test:unit -- components/tools-admin/tools-manager.render.test.tsx
```
Expected: failures — no Add tool button, no controls.

- [ ] **Step 3: Build `ToolForm`**

Create `apps/console/components/tools-admin/tool-form.tsx`, a client component
rendering a dialog with a `<form>` containing labelled inputs for **name,
subdomain, purpose, note (optional)** and a **group** `<select>` over the
supplied groups, plus Save and Cancel.

Every requirement below is depended on by a test above:

- Each input has a `<label htmlFor>` so `getByLabelText` finds it.
- **No pattern validation on subdomain.** `required` on name, subdomain and
  purpose is the whole of client-side validation — see the Global Constraints.
- On submit call the action prop; when the result is `{ ok: false, field }`,
  render `message` inside the same wrapper `<div>` as that field's input, and
  when there is no `field`, at the top of the form.
- **An empty note submits as `null`, never `""`.**
- Save is disabled while the action is in flight.

Use `@tesserix/web`'s `button`, `dialog`, `input`, `label` and `select` — all
verified present under `node_modules/@tesserix/web/dist/components`. Follow how
an existing console form imports them, e.g. under `app/(console)/platform/crm/`.

- [ ] **Step 4: Add controls to `ToolsManager`**

Per group, an "Add tool" button opening `ToolForm` in add mode with that group
preselected. Per tool row, "Edit" (opens `ToolForm` in edit mode) and "Delete"
(opens a confirmation naming the tool, whose confirm button is labelled exactly
"Delete tool"). Keep the empty-group branch and its comment from Task 1.

- [ ] **Step 5: Run the tests, lint, build**

```
npm run test:unit -- components/tools-admin/tools-manager.render.test.tsx
npm run lint
npm run build
```
Expected: 6 PASS, lint clean, build green.

- [ ] **Step 6: Commit**

```bash
git add apps/console/components/tools-admin/
git commit -m "feat(console): add, edit and remove a tool from the console"
```

---

## Task 5: Group management

**Files:**
- Create: `apps/console/components/tools-admin/group-form.tsx`
- Modify: `apps/console/components/tools-admin/tools-manager.tsx`
- Modify: `apps/console/components/tools-admin/tools-manager.render.test.tsx`
- Modify: `apps/console/components/internal-tools.tsx` (comment only)

**Interfaces:**
- Consumes: `addGroupAction`, `renameGroupAction`, `removeGroupAction` (Task 3).
- Produces: `<GroupForm />`, and group-level controls in `ToolsManager`.

- [ ] **Step 1: Add the failing tests**

Add `addGroupAction`, `renameGroupAction`, `removeGroupAction` to the imports
from the mocked actions module, then append to
`tools-manager.render.test.tsx`:

```tsx
describe("group management", () => {
  it("adds a group", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getByRole("button", { name: /add group/i }));
    await user.type(screen.getByLabelText(/^key$/i), "security");
    await user.type(screen.getByLabelText(/label/i), "Security");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(addGroupAction).toHaveBeenCalledWith({ key: "security", label: "Security" });
  });

  it("renames a group without offering to change its key", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    const section = screen.getByText("Identity and secrets").closest("section");
    await user.click(within(section as HTMLElement).getByRole("button", { name: /rename/i }));

    // The key is a foreign key every tool in the group references. The API
    // refuses to change it with a 400 explaining the remedy; offering an
    // editable field here would invite that refusal on every rename.
    expect(screen.queryByLabelText(/^key$/i)).not.toBeInTheDocument();

    const input = screen.getByLabelText(/label/i);
    await user.clear(input);
    await user.type(input, "Identity");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(renameGroupAction).toHaveBeenCalledWith("identity", "Identity");
  });

  it("surfaces the API's refusal to delete a populated group", async () => {
    const user = userEvent.setup();
    vi.mocked(removeGroupAction).mockResolvedValue({
      ok: false,
      message: "Move or remove the tools in this group first.",
    });
    render(<ToolsManager directory={DIRECTORY} />);

    const section = screen.getByText("Identity and secrets").closest("section");
    await user.click(within(section as HTMLElement).getByRole("button", { name: /delete group/i }));
    await user.click(screen.getByRole("button", { name: /^delete group$/i }));

    expect(await screen.findByText(/move or remove the tools/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```
npm run test:unit -- components/tools-admin/tools-manager.render.test.tsx
```
Expected: 3 new failures.

- [ ] **Step 3: Build `GroupForm` and the group controls**

`group-form.tsx`: a client dialog with **key** (add mode only) and **label**
inputs, plus Save and Cancel. In rename mode the key is **not rendered at all**
— not disabled, not read-only, absent — because the API refuses the change and
a visible-but-inert field invites the question of why.

In `tools-manager.tsx`: a page-level "Add group" button, and per group header
"Rename" and "Delete group" (the latter behind a confirmation whose confirm
button is labelled exactly "Delete group"). Render a failed group action's
message beside that group's heading.

- [ ] **Step 4: State the divergence in the home page component**

In `apps/console/components/internal-tools.tsx`, extend the comment on the
empty-group skip:

```tsx
        // A declared-but-empty group would render as a heading over nothing,
        // which reads as a loading failure rather than an absence.
        //
        // The MANAGEMENT surface deliberately does the opposite and shows
        // empty groups (components/tools-admin/tools-manager.tsx): a group an
        // operator just created is empty, and hiding it there would make
        // creation look like it silently failed. Two surfaces, two audiences,
        // one deliberate divergence — not an inconsistency to reconcile.
        if (tools.length === 0) return null;
```

- [ ] **Step 5: Run everything, lint, build**

```
npm run test:unit
npm run lint
npm run build
```
Expected: all PASS, lint clean, build green.

- [ ] **Step 6: Commit**

```bash
git add apps/console/components/tools-admin/ apps/console/components/internal-tools.tsx
git commit -m "feat(console): manage tool groups, and record why empty ones show here"
```

---

## Task 6: Carry `sort_order` through the loader

**Files:**
- Modify: `apps/console/lib/tools-directory.ts`
- Modify: `apps/console/lib/tools-directory.test.ts`

**Interfaces:**
- Produces: `DirectoryTool.sortOrder: number` and `DirectoryGroup.sortOrder: number`.

**Why this task exists.** `DirectoryTool` and `DirectoryGroup` currently drop
`sort_order` — the loader reads it off the wire and throws it away, because
until now the console only rendered rows in the order the API returned them.
Reordering needs the real values, and deriving them from the render index is
**wrong, not merely implicit**:

> Stored `sort_order` values `100, 200, 300`. Move the middle tool down. An
> index-derived swap writes `2` and `3` to those two rows, leaving
> `100, 3, 2` — so the tool that was FIRST is now last. The bug hides only
> while the stored values happen to be small and gapless, which they are today
> and will not be after the first explicit `sort_order` on create.

- [ ] **Step 1: Add the failing tests**

In `apps/console/lib/tools-directory.test.ts`, give the platform-api success
test's fixture **non-contiguous** positions — tools at `sort_order` 10 and 20,
groups at 5 and 15 — then assert they survive:

```ts
expect(directory.tools.map((t) => t.sortOrder)).toEqual([10, 20]);
expect(directory.groups.map((g) => g.sortOrder)).toEqual([5, 15]);
```

Non-contiguous on purpose: `[1, 2]` would pass even if the loader invented the
values from the array index, which is the exact bug this task prevents.

Add one for the fallback:

```ts
it("gives the built-in list positions too, so the type has no hole", async () => {
  delete process.env.PLATFORM_API_ORIGIN;
  const { readToolsDirectory } = await load();

  const directory = await readToolsDirectory();

  // 1-based declaration order. The built-in list is never editable — the
  // surface is hidden when the origin is unset — but a reader should not have
  // to reason about a missing field.
  expect(directory.groups[0].sortOrder).toBe(1);
  expect(directory.tools[0].sortOrder).toBe(1);
});
```

- [ ] **Step 2: Run and watch them fail**

```
npm run test:unit -- lib/tools-directory.test.ts
```
Expected: failures on `sortOrder` being `undefined`.

- [ ] **Step 3: Carry the field**

Add `readonly sortOrder: number;` to both `DirectoryTool` and
`DirectoryGroup`. In `parse()`, read it with a new `num(row, key)` helper that
throws when the value is not a number — matching how `str` and `nullableStr`
already validate rather than cast, so a malformed payload becomes the labelled
fallback instead of `NaN` reaching a swap:

```ts
function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`\`${key}\` is ${typeof value}, expected a number`);
  }
  return value;
}
```

In `builtin()`, assign the 1-based index within the literal.

- [ ] **Step 4: Run the tests, lint, build**

```
npm run test:unit -- lib/tools-directory.test.ts
npm run lint
npm run build
```
Expected: PASS, clean, green.

- [ ] **Step 5: Prove the new field is genuinely covered**

Break it: make `parse()` return `sortOrder: 0` for every tool. Confirm a test
fails. Restore, and report which one caught it. The non-contiguous fixture
exists precisely so this mutation cannot slip through.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/tools-directory.ts apps/console/lib/tools-directory.test.ts
git commit -m "feat(console): carry sort_order through the tools directory loader"
```

---

## Task 7: Reordering, and the whole-system check

**Files:**
- Modify: `apps/console/components/tools-admin/tools-manager.tsx`
- Modify: `apps/console/components/tools-admin/tools-manager.render.test.tsx`

**Interfaces:**
- Consumes: `moveToolAction`, `moveGroupAction` (Task 3); `DirectoryTool.sortOrder`, `DirectoryGroup.sortOrder` (Task 6).
- Produces: nothing new; this completes the surface.

- [ ] **Step 1: Add the failing tests**

Add `moveToolAction` and `moveGroupAction` to the imports from the mocked
actions module, then append:

```tsx
describe("reordering", () => {
  it("moves a tool down by swapping stored sort orders with the row below", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    const row = screen.getByText("Zitadel").closest("li");
    await user.click(within(row as HTMLElement).getByRole("button", { name: /move down/i }));

    // The fixture's REAL values — 10 and 20, deliberately not 1 and 2. An
    // implementation that passed render indices would call this with 1 and 2
    // and fail here, which is the whole point of the fixture.
    expect(moveToolAction).toHaveBeenCalledWith(
      { id: "t1", sortOrder: 10 },
      { id: "t2", sortOrder: 20 },
    );
  });

  it("does not offer to move the first tool up or the last one down", () => {
    render(<ToolsManager directory={DIRECTORY} />);

    const first = screen.getByText("Zitadel").closest("li");
    const last = screen.getByText("Secret service").closest("li");

    // A control that cannot do anything is worse than no control: it invites a
    // click and answers with nothing.
    expect(within(first as HTMLElement).queryByRole("button", { name: /move up/i })).toBeNull();
    expect(within(last as HTMLElement).queryByRole("button", { name: /move down/i })).toBeNull();
  });

  it("moves a group among its peers", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    const section = screen.getByText("Identity and secrets").closest("section");
    await user.click(within(section as HTMLElement).getByRole("button", { name: /move group down/i }));

    expect(moveGroupAction).toHaveBeenCalledWith(
      { key: "identity", sortOrder: 10 },
      { key: "empty", sortOrder: 20 },
    );
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```
npm run test:unit -- components/tools-admin/tools-manager.render.test.tsx
```
Expected: 3 new failures.

- [ ] **Step 3: Add the controls**

In `tools-manager.tsx`, per tool row render "Move up" and "Move down", each
omitted at the respective boundary of its group. Per group header render "Move
group up" / "Move group down", omitted at the boundaries of the group list.

**The values passed to the actions are the rows' REAL `sortOrder`** (Task 6),
never the render index — a group stored at `10, 20, 30` must stay correctly
ordered relative to everything else.

- [ ] **Step 4: Run the whole system**

```
cd apps/console && npm run test:unit && npm run lint && npm run build
cd ../../packages/console-core && npx vitest run && npm run build
cd ../../platform-api && go build ./... && go vet ./... && \
  golangci-lint run ./internal/modules/tools/... && go test ./...
```

The Go side is unchanged by this plan, and it is run to prove exactly that:
this surface's whole premise is that the API already does the work. Database
tests skip silently without the env — export it and confirm **zero skips**:

```
export TESSERIX_TEST_DB_HOST=127.0.0.1 TESSERIX_TEST_DB_PORT=55432 \
       TESSERIX_TEST_DB_USER=postgres TESSERIX_TEST_DB_PASSWORD=test
```

Ignore the pre-existing `staticcheck` complaint in `internal/modules/aiusage`
— it is on `origin/main` already.

- [ ] **Step 5: Commit**

```bash
git add apps/console/components/tools-admin/
git commit -m "feat(console): reorder tools and groups from the console"
```

---

## Self-Review

**Spec coverage.** D1 (own surface) → Task 1. D2 (tools and groups, empty
groups shown) → Tasks 4, 5, and the divergence comment at Task 5 Step 4. D3
(up/down, non-atomic swap) → Tasks 3, 6, 7. D4 (hidden when switched off,
degraded distinguished) → Task 1's four render tests. "Must not audit" → Task 2
and its doc comment. "Must not validate client-side" → Task 4 Step 3. "Must not
introduce status" → nothing adds one; the Global Constraints say so. Testing →
every task ends with tests; Task 7 runs the whole system. Definition-of-done
1-5 → Tasks 4/7, 1, 1, 2, 5.

**Ordering note.** Task 6 comes after the UI tasks because Tasks 4 and 5 do not
need `sortOrder` and the fixtures carry it harmlessly from the start. Task 7 is
the only consumer, so the loader change sits immediately before it. An
implementer doing Task 7 before Task 6 will find `sortOrder` missing from the
type and should stop rather than reach for the render index.

**Known soft spots, named rather than hidden.**

1. **`fieldFor` guesses which field a 422 belongs to** by matching the start of
   the API's message. The API does not say. The guess is confined to two
   unmistakable prefixes and degrades to a form-level message, which is why it
   is acceptable rather than clever.
2. **`checkOperatorCapability`'s exact signature is taken from `crm-write.ts`'s
   call site**, not from reading its definition. Task 2 Step 3 says to confirm.
3. **Whether `@tesserix/web`'s dialog primitives suit a confirmation as well as
   a form** is unverified — the components exist, their ergonomics are not
   checked. If a confirmation is awkward, a plain `<dialog>` is acceptable so
   long as the button labels match what the tests query.
