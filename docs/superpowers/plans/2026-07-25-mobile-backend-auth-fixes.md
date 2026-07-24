# Mobile Admin — Backend Auth Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Expo mobile admin app's data layer work by fixing two backend bugs in `apps/web` that block every bearer-authenticated (mobile) request: reads 401 and writes 403.

**Architecture:** The mobile app authenticates by `Authorization: Bearer <encrypted-session>` (the same JWE the web cookie carries, minted by `/api/auth/mobile/google`). Middleware *auth* already accepts the bearer, but (1) `csrfCheck` rejects the mutation before auth because RN sends no `Origin`/`Referer`, and (2) the HomeChef gateway re-derives identity via `getCurrentSession()`, which reads only the cookie. Both fixes route through a single edge-safe `bearerToken` helper so parsing is shared and unit-tested.

**Tech Stack:** Next.js 16, TypeScript, Vitest, jose (JWE sessions).

## Global Constraints

- **Security-correct, not just working.** The bearer IS the encrypted session (`verifySession` validates it); bearer auth is not cookie-based, so exempting it from CSRF is correct (a bearer can't be silently attached cross-site the way a cookie can). Mirror the existing `/api/internal/` exemption rationale in `apps/web/middleware.ts`.
- **No new attack surface.** Only requests carrying a valid `Authorization: Bearer` are exempted from CSRF; verification still happens (middleware auth + `verifySession`). Do not weaken cookie-path CSRF.
- **Edge-safe.** `apps/web/middleware.ts` runs in the middleware runtime — the shared `bearerToken` helper must have NO Node-only imports (no `node:crypto`). Keep it in its own file, separate from `session-jwt.ts` (which uses `node:crypto`).
- **Bearer parsing must match the existing inline form** in `middleware.ts:166-170`: case-insensitive `bearer `, then `slice(7).trim()`.
- **Tests:** Vitest picks up `apps/web/lib/**/*.test.ts` only (see `apps/web/vitest.config.ts`). All new tests live under `lib/`. Follow the existing style in `apps/web/lib/api/homechef-admin.test.ts` (`import { describe, expect, it } from "vitest"`).
- **No behavior change for the web/cookie path** — existing web admin must keep working (the cookie is checked first).
- **Deploy dependency:** these fixes only help the live app once merged to `main` and promoted to prod (Kargo). Validation via real Google sign-in also needs the P1 config in Task 4's runbook.

## File Structure

```
apps/web/lib/auth/bearer.ts            NEW — edge-safe `bearerToken(header)` (shared)
apps/web/lib/auth/bearer.test.ts       NEW — unit tests for bearerToken
apps/web/lib/auth/session-jwt.ts       MODIFY — getCurrentSession falls back to bearer
apps/web/lib/auth/session-jwt.test.ts  NEW — getCurrentSession bearer-fallback test
apps/web/lib/security/csrf.ts          NEW — extracted csrfCheck + bearer exemption
apps/web/lib/security/csrf.test.ts     NEW — csrf decision tests
apps/web/middleware.ts                 MODIFY — import evaluateCsrf + bearerToken
apps/web/.env.example                  MODIFY — document GOOGLE_MOBILE_CLIENT_IDS
docs/mobile-admin-runbook.md           NEW — prod Google-auth validation runbook
```

---

### Task 1: Shared edge-safe `bearerToken` helper (TDD)

**Files:**
- Create: `apps/web/lib/auth/bearer.ts`
- Create: `apps/web/lib/auth/bearer.test.ts`

**Interfaces:**
- Produces: `bearerToken(authHeader: string | null | undefined): string | null` — returns the token from a case-insensitive `Bearer ` header, else null.

- [ ] **Step 1: Write the failing test** — `apps/web/lib/auth/bearer.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { bearerToken } from "./bearer";

describe("bearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });
  it("is case-insensitive on the scheme", () => {
    expect(bearerToken("bearer xyz")).toBe("xyz");
    expect(bearerToken("BEARER xyz")).toBe("xyz");
  });
  it("trims surrounding whitespace", () => {
    expect(bearerToken("  Bearer   tok  ")).toBe("tok");
  });
  it("returns null for missing / empty / wrong scheme", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web exec vitest run lib/auth/bearer.test.ts`
Expected: FAIL — cannot resolve `./bearer`.

- [ ] **Step 3: Create `apps/web/lib/auth/bearer.ts`**

```ts
// Edge-safe extraction of an `Authorization: Bearer <token>` value.
// Kept free of Node-only imports so apps/web/middleware.ts can use it.
export function bearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (!/^bearer\s+/i.test(trimmed)) return null;
  const token = trimmed.replace(/^bearer\s+/i, "").trim();
  return token.length > 0 ? token : null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter web exec vitest run lib/auth/bearer.test.ts`
Expected: PASS (all cases), pristine output.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/auth/bearer.ts apps/web/lib/auth/bearer.test.ts
git commit -m "feat(web): edge-safe bearerToken helper for shared Authorization parsing"
```

---

### Task 2: Fix #1 — `getCurrentSession` falls back to the bearer (401 on reads)

The HomeChef gateway's `homechefAdmin` derives the actor from `getCurrentSession()`, which today reads only the cookie. Make it fall back to the bearer so mobile reads resolve an identity.

**Files:**
- Modify: `apps/web/lib/auth/session-jwt.ts:102-111` (`getCurrentSession`)
- Create: `apps/web/lib/auth/session-jwt.test.ts`

**Interfaces:**
- Consumes: `bearerToken` (Task 1), `verifySession`, `signSession` (existing).
- Produces: `getCurrentSession()` unchanged signature (`Promise<VerifiedSession | null>`), now cookie-or-bearer.

- [ ] **Step 1: Write the failing test** — `apps/web/lib/auth/session-jwt.test.ts`

```ts
import { beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "./session-jwt";

beforeAll(() => {
  process.env.SESSION_ENCRYPT_KEY = "test-session-key-please-change-32b";
});

// Helper to (re)load getCurrentSession with a mocked next/headers.
async function loadGetCurrentSession(opts: {
  cookie?: string;
  authorization?: string;
}) {
  vi.resetModules();
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) =>
        opts.cookie && name === (process.env.SESSION_COOKIE_NAME ?? "tx_session")
          ? { value: opts.cookie }
          : undefined,
    }),
    headers: async () => ({
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? opts.authorization ?? null : null,
    }),
  }));
  const mod = await import("./session-jwt");
  return mod.getCurrentSession;
}

describe("getCurrentSession", () => {
  it("resolves the session from an Authorization: Bearer token when no cookie is present", async () => {
    const token = await signSession({ sub: "u-1", email: "ops@tesserix.com", name: "Ops" });
    const getCurrentSession = await loadGetCurrentSession({ authorization: `Bearer ${token}` });
    const session = await getCurrentSession();
    expect(session?.email).toBe("ops@tesserix.com");
    expect(session?.sub).toBe("u-1");
  });

  it("still resolves from the cookie (web path unchanged)", async () => {
    const token = await signSession({ sub: "u-2", email: "web@tesserix.com" });
    const getCurrentSession = await loadGetCurrentSession({ cookie: token });
    const session = await getCurrentSession();
    expect(session?.email).toBe("web@tesserix.com");
  });

  it("returns null when neither cookie nor bearer is present", async () => {
    const getCurrentSession = await loadGetCurrentSession({});
    expect(await getCurrentSession()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web exec vitest run lib/auth/session-jwt.test.ts`
Expected: FAIL on the first case (bearer path returns null today).

- [ ] **Step 3: Modify `getCurrentSession` in `apps/web/lib/auth/session-jwt.ts`**

Add the import near the top (below the `jose` import):
```ts
import { bearerToken } from "./bearer";
```

Replace the body of `getCurrentSession` (currently lines 102-111) with:
```ts
export async function getCurrentSession(): Promise<VerifiedSession | null> {
  // Lazy import keeps this usable only inside RSC / route-handler contexts,
  // where cookies() and headers() are available.
  const { cookies, headers } = await import("next/headers");
  const jar = await cookies();
  const cookieToken = jar.get(sessionCookieName())?.value;
  if (cookieToken) return verifySession(cookieToken);
  // Mobile clients hold no .tesserix.app cookie — they present the same
  // encrypted session (minted by /api/auth/mobile/google) as a bearer token.
  const bearer = bearerToken((await headers()).get("authorization"));
  if (bearer) return verifySession(bearer);
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter web exec vitest run lib/auth/session-jwt.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/auth/session-jwt.ts apps/web/lib/auth/session-jwt.test.ts
git commit -m "fix(web): getCurrentSession resolves the mobile bearer (fixes homechef gw 401)"
```

---

### Task 3: Fix #2 — exempt bearer requests from CSRF (403 on writes)

Extract `csrfCheck` into a testable module and add the bearer exemption, then wire it into middleware.

**Files:**
- Create: `apps/web/lib/security/csrf.ts`
- Create: `apps/web/lib/security/csrf.test.ts`
- Modify: `apps/web/middleware.ts` (replace the inline `csrfCheck` with the imported `evaluateCsrf`; keep everything else)

**Interfaces:**
- Consumes: `bearerToken` (Task 1).
- Produces: `evaluateCsrf(request: CsrfRequest): CsrfDecision` and `interface CsrfDecision { blocked: boolean; message?: string }`, where `CsrfRequest` is `{ method: string; nextUrl: { pathname: string }; headers: { get(name: string): string | null } }` (NextRequest satisfies it structurally).

- [ ] **Step 1: Write the failing test** — `apps/web/lib/security/csrf.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateCsrf } from "./csrf";

function req(opts: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}) {
  const h = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method: opts.method ?? "POST",
    nextUrl: { pathname: opts.path ?? "/api/admin/apps/homechef/gw/orders" },
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("evaluateCsrf", () => {
  it("allows non-mutating and non-api requests", () => {
    expect(evaluateCsrf(req({ method: "GET" })).blocked).toBe(false);
    expect(evaluateCsrf(req({ method: "POST", path: "/admin/dashboard" })).blocked).toBe(false);
  });

  it("BLOCKS a mutating api request with no Origin/Referer and no bearer", () => {
    const d = evaluateCsrf(req({ headers: { host: "home.tesserix.app" } }));
    expect(d.blocked).toBe(true);
    expect(d.message).toContain("Origin header required");
  });

  it("ALLOWS a mutating api request that carries a valid Bearer token (mobile)", () => {
    const d = evaluateCsrf(
      req({ headers: { host: "home.tesserix.app", authorization: "Bearer abc.def.ghi" } }),
    );
    expect(d.blocked).toBe(false);
  });

  it("still allows /api/internal/ (existing exemption)", () => {
    expect(evaluateCsrf(req({ path: "/api/internal/tickets" })).blocked).toBe(false);
  });

  it("blocks a cross-origin mutation and allows a same-host one", () => {
    vi.stubEnv("CSRF_ALLOWED_DOMAINS", "home.tesserix.app");
    expect(
      evaluateCsrf(req({ headers: { host: "home.tesserix.app", origin: "https://evil.com" } })).blocked,
    ).toBe(true);
    expect(
      evaluateCsrf(req({ headers: { host: "home.tesserix.app", origin: "https://home.tesserix.app" } })).blocked,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web exec vitest run lib/security/csrf.test.ts`
Expected: FAIL — cannot resolve `./csrf`.

- [ ] **Step 3: Create `apps/web/lib/security/csrf.ts`** (the current `csrfCheck` body verbatim + the bearer exemption)

```ts
import { bearerToken } from "@/lib/auth/bearer";

export interface CsrfDecision {
  blocked: boolean;
  message?: string;
}

export interface CsrfRequest {
  method: string;
  nextUrl: { pathname: string };
  headers: { get(name: string): string | null };
}

export function evaluateCsrf(request: CsrfRequest): CsrfDecision {
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");
  const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(request.method);
  if (!isApiRoute || !isMutating) {
    return { blocked: false };
  }
  // /api/internal/* is server-to-server bearer-token auth — CSRF is irrelevant
  // for non-cookie auth.
  if (request.nextUrl.pathname.startsWith("/api/internal/")) {
    return { blocked: false };
  }
  // Bearer-authenticated requests (the native mobile admin app) are not
  // cookie-based, so CSRF — a cookie-riding-attack defense — does not apply.
  // Same rationale as /api/internal above; React Native sends no Origin/Referer.
  // Verification still happens downstream (middleware auth + verifySession).
  if (bearerToken(request.headers.get("authorization"))) {
    return { blocked: false };
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  const allowedHostnames = new Set<string>();
  const host = request.headers.get("host");
  if (host) allowedHostnames.add(host.split(":")[0]);
  const fwdHost = request.headers.get("x-forwarded-host");
  if (fwdHost) allowedHostnames.add(fwdHost.split(",")[0].trim().split(":")[0]);
  const csrfDomains = process.env.CSRF_ALLOWED_DOMAINS;
  if (csrfDomains) {
    csrfDomains.split(",").forEach((d) => allowedHostnames.add(d.trim()));
  }
  if (allowedHostnames.size === 0) {
    return { blocked: false };
  }

  const matches = (raw: string | null): boolean => {
    if (!raw) return false;
    try {
      return allowedHostnames.has(new URL(raw).hostname);
    } catch {
      return false;
    }
  };

  if (origin && !matches(origin)) {
    return { blocked: true, message: "CSRF check failed" };
  }
  if (!origin && referer && !matches(referer)) {
    return { blocked: true, message: "CSRF check failed" };
  }
  if (!origin && !referer && !request.nextUrl.pathname.startsWith("/api/auth")) {
    return { blocked: true, message: "CSRF check failed: Origin header required" };
  }
  return { blocked: false };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter web exec vitest run lib/security/csrf.test.ts`
Expected: PASS (all cases), pristine output.

- [ ] **Step 5: Wire `apps/web/middleware.ts` to use the extracted function**

Add these imports near the other imports at the top of `apps/web/middleware.ts`:
```ts
import { evaluateCsrf } from "@/lib/security/csrf";
import { bearerToken } from "@/lib/auth/bearer";
```

Delete the local `interface CsrfDecision { ... }` and the entire local `function csrfCheck(request: NextRequest): CsrfDecision { ... }` block (the one spanning the CSRF logic). Replace every call site `csrfCheck(request)` with `evaluateCsrf(request)`. If any remaining line in `middleware.ts` still references the `CsrfDecision` type by name (e.g. an explicit annotation), also add `type CsrfDecision` to the csrf import; otherwise do NOT import it (an unused import fails `--max-warnings 0`).

Also (DRY) replace the inline bearer parse in the auth section (currently `apps/web/middleware.ts:166-170`):
```ts
  const authHeader = request.headers.get("authorization");
  const bearer =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
```
with:
```ts
  const bearer = bearerToken(request.headers.get("authorization"));
```

- [ ] **Step 6: Verify web lint, typecheck, full unit tests, and build**

Run:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web test:unit && pnpm --filter web build
```
Expected: all green — lint clean (`--max-warnings 0`), typecheck 0 errors, all vitest tests pass (bearer + session-jwt + csrf + existing homechef-admin), build succeeds. The `middleware.ts` refactor must not change any non-CSRF/non-bearer behavior.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/security/csrf.ts apps/web/lib/security/csrf.test.ts apps/web/middleware.ts
git commit -m "fix(web): exempt bearer-authenticated requests from CSRF (fixes mobile write 403)"
```

---

### Task 4: Config + prod Google-auth validation runbook

The code fixes make the data layer work once a valid session exists. To validate via real Google sign-in against prod (per the chosen validation path), document the required config — it is operator/GCP work, not code, so nothing secret is committed.

**Files:**
- Modify: `apps/web/.env.example` (document `GOOGLE_MOBILE_CLIENT_IDS`)
- Create: `docs/mobile-admin-runbook.md`

- [ ] **Step 1: Document `GOOGLE_MOBILE_CLIENT_IDS` in `apps/web/.env.example`**

Add (near the other auth/Google vars; keep existing content):
```bash
# Comma-separated Google OAuth *client IDs* accepted as the id_token `aud` for
# native mobile sign-in (/api/auth/mobile/google). Must include the iOS AND web
# client IDs created for the app.tesserix.admin bundle. If unset, mobile sign-in
# returns 503 "mobile sign-in is not configured".
GOOGLE_MOBILE_CLIENT_IDS=
```

- [ ] **Step 2: Create `docs/mobile-admin-runbook.md`** — the end-to-end validation runbook

```markdown
# Mobile Admin — Prod Google-Auth Validation Runbook

Prereq: the two backend auth fixes (getCurrentSession bearer fallback + CSRF
bearer exemption) are merged to `main` and promoted to prod (Kargo → Argo).

## 1. Create Google OAuth clients (GCP / Firebase console, `app.tesserix.admin`)
- An **iOS** OAuth client → gives `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and a
  reversed-client-id (`com.googleusercontent.apps.XXXX`).
- A **Web** OAuth client → gives `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (used as the
  id_token audience for `useIdTokenAuthRequest`).

## 2. Backend config (tesserix-home prod)
- Set `GOOGLE_MOBILE_CLIENT_IDS` = the iOS + web client IDs (comma-separated) in
  the prod secret (Secret Manager → ExternalSecret in tesserix-k8s), so the
  id_token `aud` is accepted by `/api/auth/mobile/google`.
- Ensure `SESSION_ENCRYPT_KEY` and `ALLOWED_ADMIN_EMAILS` are set (already
  required for web admin). Your validating Google account must be in the allowlist.

## 3. Mobile app config
- Put the client IDs in the mobile env: `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`,
  `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`; `EXPO_PUBLIC_API_BASE=https://home.tesserix.app`;
  `EXPO_PUBLIC_DEV_AUTH_BYPASS=false`.
- For a **standalone/dev build** (not Expo Go), add the iOS reversed-client-id to
  `apps/mobile/app.json` so the OAuth redirect returns to the app:
  ```json
  "ios": {
    "bundleIdentifier": "app.tesserix.admin",
    "infoPlist": {
      "CFBundleURLTypes": [
        { "CFBundleURLSchemes": ["com.googleusercontent.apps.XXXX"] }
      ]
    }
  }
  ```
  (Expo Go demos do not need this.)

## 4. Validate
1. `cd apps/mobile && npx expo start` (or a dev build for the native URL scheme).
2. Tap "Continue with Google" → sign in with an allowlisted admin account.
3. Confirm: the dashboard (`index`), `chefs`, `orders` populate (proves the
   read path / bearer → gateway → Go API works), and an admin action
   (e.g. resolve a cancellation) succeeds (proves the write path / CSRF fix).
4. If reads 401 → the getCurrentSession fix isn't deployed. If writes 403 →
   the CSRF fix isn't deployed. If sign-in 503 → `GOOGLE_MOBILE_CLIENT_IDS`
   is unset/mismatched. If the button is disabled → mobile client IDs are empty.

## Out of this repo
The HomeChef **Go** `/api/v1/admin/*` endpoints each screen calls (and
`HOMECHEF_API_URL` / `HOMECHEF_BFF_HMAC_KEY`) live in a separate service — if a
specific screen 404/500s after auth works, verify that endpoint exists there.
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/.env.example docs/mobile-admin-runbook.md
git commit -m "docs: document GOOGLE_MOBILE_CLIENT_IDS + mobile admin prod validation runbook"
```

---

### Task 5: Ship

- [ ] **Step 1: Push and open a PR**

```bash
git push -u origin feat/mobile-auth-fixes
```
CI runs install/lint/test only (branch push no longer builds/deploys — the guard is `main`-only). Open a PR to `main`.

- [ ] **Step 2: After merge → prod, hand off to the runbook**

Merging to `main` builds + promotes to prod (Kargo). Then follow `docs/mobile-admin-runbook.md` to wire the GCP OAuth config and validate the app end-to-end with real Google sign-in.

## Out of scope (not blocking the data layer)
- Populating real Google OAuth client IDs / secrets (operator + GCP console — Task 4 documents it).
- The Platform tab (`app/(tabs)/platform.tsx`) — intentional "Soon" stubs; the `plat` client is currently unused.
- The HomeChef **Go** `/api/v1/admin/*` endpoints (separate repo).
```
