# Console Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A console header carrying operator identity, capabilities and sign-out, with the notification bell moved into it from the sidebar footer.

**Architecture:** The `(console)` layout is a server component, so it reads the session there and passes plain props into a client header. Sign-out is a route handler that clears the shared `.tesserix.app` cookie and — only when configured — ends the Zitadel session too.

**Tech Stack:** Next.js 16 App Router (server layout + client components + route handler), `@tesserix/platform-auth`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-16-console-header-design.md` — read it; D1–D7 argue every decision below.

**Branch:** `feat/console-header`, off `origin/main` (which now carries #181, #183 and #176).

## Global Constraints

- Every verb asserts a capability in the same change that adds it. Sign-out's verb asserts **`read`** (spec D5).
- Sign-out clears the cookie **before** any redirect, so the local session ends even if Zitadel refuses the request (spec D4).
- RP-initiated logout happens **only** when `ZITADEL_POST_LOGOUT_REDIRECT_URI` is set. Unset, behave exactly like `apps/web/app/auth/logout/route.ts`.
- The bell's logic does not change — only where it mounts (spec D7).
- Pages render their own `ConsolePageHeader`; the bar must not render a page title or breadcrumbs (spec D2).
- No `console.log`; explicit types on exports; immutable patterns; files well under 800 lines.
- Single-line conventional commits, no signatures.
- Verification per task from `apps/console/`: `npm run test:unit`; at the end also `npm run typecheck && npm run lint && npm run build`.
- Work in the worktree at `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/.claude/worktrees/m0-foundation` using **absolute paths** — the shell resets its cwd to a stale checkout between commands.

### Verified facts to build on

- `@tesserix/platform-auth` exports (all via its barrel): `getCurrentSession()`, `sessionCookieName()`, `sessionCookieOptions()` (→ `{ domain, maxAge }`), `toCapabilities(roles)`, `CAPABILITIES`, `type Capability`, `CapabilityError`, `hasCapability`.
- `@/lib/auth/operator` exports `checkOperatorCapability(session, required, provider?)`, which throws `CapabilityError` and fails closed on a null session.
- `@/lib/internal-access` exports `requiresCapability(provider?)` — true only when `AUTH_PROVIDER=zitadel`.
- Zitadel's discovery document gives `end_session_endpoint: https://auth.tesserix.app/oidc/v1/end_session`. `ZITADEL_ISSUER` and `ZITADEL_CLIENT_ID` are already set on the console pod.
- `apps/web/app/auth/logout/route.ts` is the reference: it clears the cookie with `maxAge: 0`, `httpOnly`, `secure`, `sameSite: "lax"`, the shared `domain`, `path: "/"`, then redirects.
- The bell currently mounts at `apps/console/components/nav/sidebar.tsx:295-296`, inside a `<div className="border-t border-sidebar-border p-3">` — that whole wrapper goes away.
- `apps/console/app/(console)/layout.tsx` is a server component rendering `<ConsoleSidebar />` in a fixed left column and `<main id="main-content">` with `px-6 py-8 sm:px-8` gutters.

---

### Task 1: Sign-out route

**Files:**
- Create: `apps/console/app/auth/logout/route.ts`
- Test: `apps/console/app/auth/logout/route.test.ts`

**Interfaces:**
- Consumes: `getCurrentSession`, `sessionCookieName`, `sessionCookieOptions` from `@tesserix/platform-auth`; `checkOperatorCapability` from `@/lib/auth/operator`; `publicOrigin` from `@/lib/public-origin`.
- Produces: `GET` and `POST` handlers at `/auth/logout`.

Both verbs behave identically. GET exists so a plain link works; POST exists so the menu can submit a form without relying on a navigation.

- [ ] **Step 1: Write the failing tests**

`apps/console/app/auth/logout/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { GET, POST } from "./route";

function request(): NextRequest {
  return new NextRequest("https://console.tesserix.app/auth/logout", {
    headers: { "x-forwarded-host": "console.tesserix.app", "x-forwarded-proto": "https" },
  });
}

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
  vi.stubEnv("SESSION_COOKIE_DOMAIN", ".tesserix.app");
  vi.stubEnv("ZITADEL_ISSUER", "https://auth.tesserix.app");
  vi.stubEnv("ZITADEL_CLIENT_ID", "386382971877196703");
  vi.stubEnv("ZITADEL_POST_LOGOUT_REDIRECT_URI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /auth/logout", () => {
  it("expires the shared session cookie on the parent domain", async () => {
    signIn(["read"]);
    const res = await GET(request());
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("tx_session=");
    expect(cookie.toLowerCase()).toContain("max-age=0");
    expect(cookie).toContain("Domain=.tesserix.app");
    expect(cookie).toContain("HttpOnly");
  });

  it("redirects to the console's own login when no IdP logout is configured", async () => {
    signIn(["read"]);
    const res = await GET(request());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://console.tesserix.app/auth/login",
    );
  });

  it("ends the Zitadel session when a post-logout redirect is configured", async () => {
    // Only when configured: Zitadel rejects a post_logout_redirect_uri that is
    // not registered against the application, and registering it is a change
    // this repo cannot make.
    signIn(["read"]);
    vi.stubEnv(
      "ZITADEL_POST_LOGOUT_REDIRECT_URI",
      "https://console.tesserix.app/auth/login",
    );
    const res = await GET(request());
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://auth.tesserix.app/oidc/v1/end_session");
    expect(location).toContain(
      "post_logout_redirect_uri=https%3A%2F%2Fconsole.tesserix.app%2Fauth%2Flogin",
    );
    expect(location).toContain("client_id=386382971877196703");
  });

  it("still expires the cookie when redirecting to the IdP", async () => {
    // The local session must end even if Zitadel refuses the request.
    signIn(["read"]);
    vi.stubEnv(
      "ZITADEL_POST_LOGOUT_REDIRECT_URI",
      "https://console.tesserix.app/auth/login",
    );
    const res = await GET(request());
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain(
      "max-age=0",
    );
  });

  it("refuses a session without the read capability", async () => {
    signIn([]);
    const res = await GET(request());
    expect(res.status).toBe(403);
  });

  it("refuses a null session", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(403);
  });
});

describe("POST /auth/logout", () => {
  it("behaves the same as GET", async () => {
    signIn(["read"]);
    const res = await POST(request());
    expect(res.status).toBe(307);
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain(
      "max-age=0",
    );
  });
});
```

- [ ] **Step 2: Run and watch it fail**

From `apps/console/`: `npm run test:unit -- app/auth/logout`
Expected: FAIL — `./route` does not exist.

- [ ] **Step 3: Implement the route**

```ts
import { NextResponse, type NextRequest } from "next/server";
import {
  CapabilityError,
  getCurrentSession,
  sessionCookieName,
  sessionCookieOptions,
} from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { publicOrigin } from "@/lib/public-origin";

/**
 * Sign out.
 *
 * Clears `tx_session`, which is scoped to `.tesserix.app` and therefore shared
 * with the web app — so this signs the operator out of both. That is the
 * honest meaning of the word; a console-only sign-out would leave them
 * authenticated on a surface they believed they had left.
 */

export const dynamic = "force-dynamic";

/**
 * Ending the Zitadel session as well, when configured.
 *
 * Without it, signing out and signing back in re-authenticates with no prompt,
 * because the IdP session outlives our cookie. On a shared machine the next
 * person to click sign-in lands here as the previous operator, holding their
 * capabilities.
 *
 * Gated on the variable because Zitadel rejects a `post_logout_redirect_uri`
 * that is not registered against the application, and registering it is a
 * change in Zitadel rather than in this repository. Unset, this behaves
 * exactly like apps/web's logout.
 */
function idpLogoutUrl(): string | null {
  const redirect = process.env.ZITADEL_POST_LOGOUT_REDIRECT_URI;
  const issuer = process.env.ZITADEL_ISSUER;
  const clientId = process.env.ZITADEL_CLIENT_ID;
  if (!redirect || !issuer || !clientId) return null;
  const url = new URL(`${issuer.replace(/\/$/, "")}/oidc/v1/end_session`);
  url.searchParams.set("post_logout_redirect_uri", redirect);
  url.searchParams.set("client_id", clientId);
  return url.toString();
}

async function signOut(request: NextRequest): Promise<NextResponse> {
  const session = await getCurrentSession();
  try {
    checkOperatorCapability(session, "read");
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw cause;
  }

  const destination = idpLogoutUrl() ?? `${publicOrigin(request)}/auth/login`;
  const response = NextResponse.redirect(destination);
  // Expire the cookie on the response that redirects, so the local session
  // ends even when the destination is Zitadel and Zitadel refuses us.
  response.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: sessionCookieOptions().domain,
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}
```

- [ ] **Step 4: Run — it must pass**

`npm run test:unit -- app/auth/logout` → PASS. If `NextResponse.redirect` rejects a relative or non-absolute URL, build the destination as an absolute URL first; do not change the assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/console/app/auth/logout
git commit -m "feat(console): sign out, clearing the shared session and optionally the IdP one"
```

---

### Task 2: The operator menu

**Files:**
- Create: `apps/console/components/nav/operator-menu.tsx`
- Test: `apps/console/components/nav/operator-menu.render.test.tsx`

**Interfaces:**
- Consumes: nothing at runtime beyond its props — the session is read server-side and passed in, so this component never touches auth itself.
- Produces:
  ```ts
  export interface OperatorMenuProps {
    readonly name: string;
    readonly email: string;
    readonly capabilities: readonly string[];
    /** False under the legacy provider, where sessions carry no roles and a
     *  capability list would be a misleading empty set. */
    readonly showCapabilities: boolean;
  }
  export function OperatorMenu(props: OperatorMenuProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing render tests**

`apps/console/components/nav/operator-menu.render.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OperatorMenu } from "./operator-menu";

const PROPS = {
  name: "Mahesh Sangawar",
  email: "mahesh.sangawar@tesserix.app",
  capabilities: ["read", "respond"],
  showCapabilities: true,
};

describe("OperatorMenu", () => {
  it("names the signed-in operator on the trigger", async () => {
    render(<OperatorMenu {...PROPS} />);
    expect(
      screen.getByRole("button", { name: /Mahesh Sangawar/ }),
    ).toBeInTheDocument();
  });

  it("falls back to the email when no name is on the session", () => {
    render(<OperatorMenu {...PROPS} name="" />);
    expect(
      screen.getByRole("button", { name: /mahesh\.sangawar@tesserix\.app/ }),
    ).toBeInTheDocument();
  });

  it("shows the email and held capabilities once opened", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    expect(
      screen.getByText("mahesh.sangawar@tesserix.app"),
    ).toBeInTheDocument();
    expect(screen.getByText("respond")).toBeInTheDocument();
  });

  it("offers sign out as a link to the logout route", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    expect(screen.getByRole("link", { name: /sign out/i })).toHaveAttribute(
      "href",
      "/auth/logout",
    );
  });

  it("says so rather than showing an empty list when capabilities are unknown", async () => {
    // Under the legacy provider a session carries no roles at all. An empty
    // list would read as "you hold nothing", which is a different claim.
    const user = userEvent.setup();
    render(
      <OperatorMenu {...PROPS} capabilities={[]} showCapabilities={false} />,
    );
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    expect(screen.queryByText("respond")).not.toBeInTheDocument();
    expect(screen.getByText(/not recorded on this session/i)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    expect(screen.getByRole("link", { name: /sign out/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: /sign out/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

`npm run test:unit -- operator-menu` → FAIL, module missing.

- [ ] **Step 3: Implement**

Requirements — write the component yourself, matching the house style:

- `"use client"`. Model the open/close behaviour on `RailSwitcher` in `apps/console/components/nav/sidebar.tsx`: a `useState` flag, a `useRef` wrapper, a `mousedown` listener that closes on an outside click, and a `keydown` listener that closes on Escape. Both listeners must be removed on unmount.
- Trigger: a `<button>` whose accessible name contains the display name (name, falling back to email), with `aria-haspopup="menu"` and `aria-expanded`.
- Panel: `role="menu"`, containing the email, then the capability block, then sign out.
- Capability block: when `showCapabilities` is true, render each capability as its own element so a test can find it by text; when false, render the sentence "Capabilities are not recorded on this session." Add a short line noting the list reflects the session, which can lag Zitadel until the next sign-in.
- Sign out: an `<a href="/auth/logout">` — a plain navigation, so it works with JavaScript unavailable and needs no client-side fetch. Give it `role="menuitem"`.
- Keep the visual language of the sidebar's existing menu (same border, radius and muted-foreground treatment). No animation.

- [ ] **Step 4: Run — it must pass**

`npm run test:unit -- operator-menu` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/components/nav/operator-menu.tsx apps/console/components/nav/operator-menu.render.test.tsx
git commit -m "feat(console): operator menu showing identity, capabilities and sign out"
```

---

### Task 3: The header, and moving the bell into it

**Files:**
- Create: `apps/console/components/nav/console-header.tsx`
- Test: `apps/console/components/nav/console-header.render.test.tsx`
- Modify: `apps/console/app/(console)/layout.tsx`
- Modify: `apps/console/components/nav/sidebar.tsx` (remove the footer)

**Interfaces:**
- Consumes: `NotificationBell` from `./notification-bell`, `OperatorMenu` from `./operator-menu` (Task 2).
- Produces:
  ```ts
  export interface ConsoleHeaderProps {
    readonly name: string;
    readonly email: string;
    readonly capabilities: readonly string[];
    readonly showCapabilities: boolean;
  }
  export function ConsoleHeader(props: ConsoleHeaderProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing render test**

`apps/console/components/nav/console-header.render.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleHeader } from "./console-header";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPS = {
  name: "Mahesh Sangawar",
  email: "mahesh.sangawar@tesserix.app",
  capabilities: ["read"],
  showCapabilities: true,
};

describe("ConsoleHeader", () => {
  it("carries both the bell and the operator menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ items: [], unread: 0, lastSeenAt: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<ConsoleHeader {...PROPS} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /notifications/i })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Mahesh Sangawar/ }),
    ).toBeInTheDocument();
  });

  it("renders no page title of its own", () => {
    // Pages render ConsolePageHeader; a title here would give every surface two.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 501 })));
    const { container } = render(<ConsoleHeader {...PROPS} />);
    expect(container.querySelector("h1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

`npm run test:unit -- console-header` → FAIL, module missing.

- [ ] **Step 3: Implement the header**

```tsx
"use client";

import { NotificationBell } from "./notification-bell";
import { OperatorMenu } from "./operator-menu";

export interface ConsoleHeaderProps {
  readonly name: string;
  readonly email: string;
  readonly capabilities: readonly string[];
  readonly showCapabilities: boolean;
}

/**
 * The console's global bar: identity and the bell, and later ⌘K.
 *
 * Deliberately carries no page title or breadcrumbs — every surface renders
 * its own ConsolePageHeader, and duplicating either here would give each page
 * two titles. The left side stays empty until ⌘K claims it (#135).
 */
export function ConsoleHeader({
  name,
  email,
  capabilities,
  showCapabilities,
}: ConsoleHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-end gap-2 border-b border-border bg-background/95 px-6 backdrop-blur sm:px-8">
      <NotificationBell />
      <OperatorMenu
        name={name}
        email={email}
        capabilities={capabilities}
        showCapabilities={showCapabilities}
      />
    </header>
  );
}
```

- [ ] **Step 4: Run — it must pass**

`npm run test:unit -- console-header` → PASS.

- [ ] **Step 5: Wire it into the layout**

`apps/console/app/(console)/layout.tsx` becomes a server component that reads the session. Keep the existing sidebar column and gutters exactly as they are; the header goes inside `<main>`, above the gutter container, so it spans the main column and sticks to the top.

```tsx
import { getCurrentSession, toCapabilities } from "@tesserix/platform-auth";
import { ConsoleSidebar } from "@/components/nav/sidebar";
import { ConsoleHeader } from "@/components/nav/console-header";
import { requiresCapability } from "@/lib/internal-access";

export default async function ConsoleLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Middleware has already refused anyone without a session, so this is only
  // ever null in a misconfiguration — render the header without identity
  // rather than failing the whole console.
  const session = await getCurrentSession();
  const showCapabilities = requiresCapability();

  return (
    <div className="flex min-h-screen">
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex">
        <ConsoleSidebar />
      </div>
      <main id="main-content" className="flex-1 lg:pl-56">
        <ConsoleHeader
          name={session?.name ?? ""}
          email={session?.email ?? ""}
          capabilities={showCapabilities ? toCapabilities(session?.roles ?? []) : []}
          showCapabilities={showCapabilities}
        />
        {/* Gutters, not a centred measure. An operator console is a dense
            full-width frame; centring a max-width column inside the space left
            by the sidebar reads as off-centre, with dead margin on both sides. */}
        <div className="w-full px-6 py-8 sm:px-8">{children}</div>
      </main>
    </div>
  );
}
```

Preserve the existing comments in that file rather than dropping them.

- [ ] **Step 6: Remove the bell from the sidebar**

In `apps/console/components/nav/sidebar.tsx`, delete the footer block at lines 295-296 (the whole `<div className="border-t border-sidebar-border p-3">` wrapper, not just its child) and remove the now-unused `NotificationBell` import at line 19. Leave everything else untouched.

- [ ] **Step 7: Full gate**

From `apps/console/`: `npm run test:unit && npm run typecheck && npm run lint`

`sidebar.render.test.tsx` may have asserted on the bell's presence — if it does, move that assertion to the header's test rather than deleting it, and note the change in your report. The act() warning that test previously emitted (from the bell's unmocked fetch) should now be gone; say whether it is.

- [ ] **Step 8: Commit**

```bash
git add apps/console/components/nav "apps/console/app/(console)/layout.tsx"
git commit -m "feat(console): header carrying identity and the notification bell"
```

---

### Task 4: Build and verify

- [ ] **Step 1: Build**

From `apps/console/`: `npm run build`. Must succeed; `/auth/logout` must appear in the route table. Paste the relevant lines.

- [ ] **Step 2: Smoke locally, max ~5 minutes**

Start the dev server on :3003 and check that `/auth/logout` responds — unauthenticated it will be refused by middleware (expect 401 or a redirect); say exactly what you saw. Kill the server and confirm it is dead.

Anything needing a real session — the header rendering with a real name, the menu opening, the cookie actually clearing in a browser, the Zitadel end-session round trip — is **not verifiable locally**. Record it plainly rather than forcing it.

- [ ] **Step 3: Commit any fix the build surfaced**, single-line message. If nothing needed fixing, make no commit.
