import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The split tesserix-home#285 preserves, asserted against the files.
 *
 * There are two capability checks in this console and they answer different
 * questions:
 *
 *   THE RENDER PATH decides which buttons and surfaces to draw. It reads the
 *   SESSION COOKIE, synchronously, and it must keep doing so. Next forbids
 *   setting cookies during render, so a server component cannot re-issue a
 *   stale session anyway; and putting a database read — plus, every five
 *   minutes, a Zitadel round trip — behind every rendered page would move an
 *   IdP dependency onto the console's critical path to change nothing an
 *   operator can act on. Hiding a button is UX, not a control.
 *
 *   THE VERB GATE decides whether a mutation may proceed. That is the control,
 *   and it is what was made live.
 *
 * The risk this file covers is a plausible future edit: someone reads "the
 * capabilities are live now" and converts the render path too, quietly adding
 * I/O to every page render. These assertions read the source, because the
 * property is about WHICH FUNCTION IS CALLED WHERE and no amount of rendering
 * a component reveals it.
 */

const CONSOLE_ROOT = path.resolve(__dirname, "../..");

/** Every render-path check in this console. Each hides a surface or a
 *  button and none of them authorises anything. Keep this list exhaustive —
 *  it is not derived from anything, so a page with its own
 *  `hasCapability(session?.roles, …)` gate that is missing here is
 *  unprotected against the regression this file exists to catch. */
const RENDER_PATH_FILES = [
  "app/(console)/platform/tickets/[id]/page.tsx",
  "app/(console)/platform/tools/page.tsx",
  "app/(console)/platform/crm/[organisation]/page.tsx",
  "app/(console)/platform/billing/catalog/page.tsx",
  "app/(console)/platform/secrets/[...path]/page.tsx",
  "app/(console)/platform/secrets/reviews/[number]/page.tsx",
] as const;

function source(relative: string): string {
  return readFileSync(path.join(CONSOLE_ROOT, relative), "utf-8");
}

describe("the render path stays on the cookie", () => {
  it.each(RENDER_PATH_FILES)(
    "%s still reads session.roles synchronously",
    (file) => {
      const text = source(file);
      expect(text).toContain("hasCapability(session?.roles,");
    },
  );

  it.each(RENDER_PATH_FILES)("%s does not call the live gate", (file) => {
    // If this fails, a page render now reads Postgres and can call Zitadel.
    // That is not a capability improvement; it is an availability regression on
    // a check that only decides whether a button is drawn.
    expect(source(file)).not.toContain("checkOperatorCapabilityLive");
  });
});

describe("the verb gate is live everywhere it decides a mutation", () => {
  /** Every server action and route handler that gates a write. Logout and
   *  the secrets write action are the two deliberate exceptions, both
   *  asserted separately below. */
  const GATED_FILES = [
    "app/(console)/platform/crm/import/actions.ts",
    "app/(console)/platform/tickets/[id]/actions.ts",
    "app/(console)/platform/billing/catalog/actions.ts",
    "app/api/internal/parity-check/route.ts",
    "app/api/notifications/route.ts",
    "app/api/search/route.ts",
    "lib/crm-write.ts",
    "lib/tools-write.ts",
    "lib/tenant-lifecycle-write.ts",
    "app/(console)/platform/secrets/[...path]/access-actions.ts",
    "app/(console)/platform/secrets/reviews/[number]/actions.ts",
  ] as const;

  it.each(GATED_FILES)("%s awaits the live gate", (file) => {
    const text = source(file);
    expect(text).toContain("await checkOperatorCapabilityLive(");
  });

  it.each(GATED_FILES)(
    "%s does not still call the cookie-only gate",
    (file) => {
      // The regression this whole issue is about: a mutation decided on a
      // seven-day-old snapshot cannot be revoked.
      const calls = source(file).match(/(?<!Live)\bcheckOperatorCapability\(/g);
      expect(calls).toBeNull();
    },
  );

  it("logout is the one exception, and stays synchronous on purpose", () => {
    // Signing out must not depend on the database or on Zitadel, and revoking
    // `read` must not strand an operator with a cookie they cannot clear. The
    // reasoning is written out at the call site.
    const text = source("app/auth/logout/route.ts");
    expect(text).toContain('checkOperatorCapability(session, "read")');
    // The exception is written down, not merely present: a reader who finds
    // the odd one out must find the reason beside it rather than assume it was
    // missed. (The name appears in that comment, so the assertion is on the
    // CALL, not on the string.)
    expect(text).not.toContain("await checkOperatorCapabilityLive(");
    expect(text).toContain("DELIBERATELY");
  });

  it("the secrets write action is the other exception, and stays that way on purpose", () => {
    // Unlike every other GATED_FILES entry, this action never calls the live
    // gate at all — not synchronous, not live, nothing. That is correct: the
    // API refuses the write on the operator's own token regardless of what
    // this action does (`resolvePlatformApiToken` resolves the OPERATOR'S OWN
    // Zitadel token here, not a shared service principal, and `PUT
    // /api/secrets/*path` sits in secrets-api's `Live` group, requiring
    // `rotate-credentials` — pinned by
    // `TestPlatformOnlyPrincipalCannotReachLiveRoutes`). A console-side check
    // here would be a duplicate of that gate, not a second layer of defence.
    const text = source("app/(console)/platform/secrets/[...path]/actions.ts");
    expect(text).not.toContain("await checkOperatorCapabilityLive(");
    // The exception is written down, not merely present — same requirement
    // as logout's above: a reader who finds the odd one out must find the
    // reason beside it in the source, not just in this test.
    expect(text).toContain("DELIBERATE EXCEPTION");
  });
});
