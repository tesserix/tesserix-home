import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
// Imported from `surface-state` and NOT from `states`: this is a server
// component, and `states.tsx` carries a load-bearing `"use client"` that turns
// every one of its exports into a client reference. Calling `resolveState`
// through that reference throws at runtime while tsc, `next build` and jsdom
// tests all pass — see `secrets/page.tsx`'s identical note, which is where
// this surface's shape is copied from.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
// `SurfaceStateView` is the one thing taken from `states.tsx`, and it is safe
// for the reason the note above does NOT cover: it is a COMPONENT, so React
// renders the client reference rather than this module invoking it. That is
// the same thing `ConsolePageHeader` (also `"use client"`, also `@tesserix/web`
// underneath) does one line up. The rule is about CALLING a client module's
// exports on the server, not about rendering them.
import { SurfaceStateView } from "@/components/kit/states";
import { requiresCapability } from "@/lib/internal-access";
import { fetchSecretStores } from "@/lib/secrets-api";
import type { SecretStore } from "@/lib/secrets";
// The 501 copy is imported rather than restated: `secretsReadError` carries
// `SECRETS_UNAVAILABLE_TITLE`/`SECRETS_UNAVAILABLE_MESSAGE` with it, and a
// second copy of those two strings would be a second place for them to drift
// from the inventory that an operator reaches this page from.
import { secretsReadError } from "../page";
import { CreateSecretForm } from "./create-secret-form";

/**
 * Creating a secret — the route the write form's create mode never had.
 *
 * `WriteSecretForm` has always had a create mode (no `ifVersion`), and
 * nothing could reach it: `[...path]/page.tsx` turns a 404 into `notFound()`,
 * so a path holding nothing has no detail page to offer it from. This route
 * is the way in, and the inventory's header action is the way to this route.
 *
 * # `/platform/secrets/new` shadows one thing, knowingly
 *
 * `new` is a STATIC segment, and Next resolves a static segment before a
 * catch-all — so `/platform/secrets/new` reaches this page and never
 * `[...path]/page.tsx`. Exactly one real secret is made unreachable by that:
 * a Google Secret Manager secret whose entire id is the single segment
 * `new`. GSM secrets created outside this console carry no namespace and no
 * app (`gcpsm.secretRef` — a flat id), so a one-segment path is a shape that
 * store genuinely produces. OpenBao cannot collide at all: a describe there
 * needs at least three segments (`<namespace>/<app>/<name>`), and that
 * constraint lives in the API, not here — `secrets-api`'s
 * `internal/secrets/path.go`'s `ParseSecretRef` rejects a path of fewer than
 * three segments, and `internal/bao/kv.go`'s `Describe` parses through it
 * before it touches the store. Deliberately NOT cited to this console's
 * `validateSecretPathForCreate`, which enforces the same shape and has no
 * authority over it: that is a create-side validator, and loosening or
 * deleting it would not make a one-segment OpenBao describe start working.
 *
 * Accepted deliberately: `/…/new` is the ordinary shape for a create route,
 * the collision needs a secret literally named `new`, and the alternatives
 * (a query param, a `/create` segment that shadows a differently-named
 * secret instead) trade a rare collision for a route every operator reads
 * wrong. This is written down so a future reader holding an unreachable
 * GSM secret named `new` finds the reason here instead of rediscovering it.
 *
 * # Why the fetch is caught
 *
 * A 501 from `secretsRequest` means `SECRETS_API_ORIGIN` is not set for this
 * deployment — the inventory's calm "not configured" state, not a failure —
 * and an uncaught rejection would render the route error boundary instead,
 * replacing that with a stack trace's worth of nothing. Same reasoning, same
 * copy, as `secrets/page.tsx`.
 */

/**
 * Copy for an operator who may look but may not write.
 *
 * Exported so the test asserts the shipped string rather than a paraphrase.
 */
export const CANNOT_CREATE_MESSAGE =
  "You do not have permission to create a secret. It needs the platform and " +
  "rotate-credentials capabilities together.";

/**
 * Copy for a rejection that carried nothing to say — `throw undefined` and
 * friends, which `toSurfaceError` narrows to `null`.
 *
 * Exported so the test asserts the shipped string.
 */
export const STORE_READ_FAILED_MESSAGE =
  "The console could not read which secret stores are enabled.";

/**
 * Which state the create surface is in.
 *
 * Only ever called after the fetch rejected, and the `?? { message }` is what
 * keeps that true all the way through: `toSurfaceError` returns `null` for a
 * rejection carrying `null` or `undefined`, and a null error would send
 * `resolveState` on to `rows` and back with `empty` — the one state whose
 * copy says no store is ENABLED, which is a claim about configuration this
 * page has no evidence for after a failed read.
 *
 * `rows` is therefore `[]` and unreachable by construction. Zero enabled
 * stores is NOT an empty state here either — `CreateSecretForm` renders its
 * own "nowhere to create a secret" callout for that, because the store list
 * is the form's input, not this surface's content.
 */
function createSecretState(error: unknown): SurfaceState {
  return resolveState({
    // The page awaits its fetch before rendering, so there is no client-side
    // pending window — Suspense fallbacks, not this state, cover the wait.
    isLoading: false,
    error: secretsReadError(error) ?? { message: STORE_READ_FAILED_MESSAGE },
    rows: [],
    filtered: false,
  });
}

export default async function NewSecretPage() {
  // THE RENDER PATH, NOT THE CONTROL. Writing requires `platform` AND
  // `rotate-credentials` together — `secrets-api` enforces that itself on
  // `PUT /api/secrets/*path` (that route sits in its `live` tier), so a
  // `platform`-only operator gets refused by the API regardless of what this
  // page draws. This check exists only so the console does not offer a
  // control that is guaranteed to 403 — it is the same
  // `!requiresCapability() || hasCapability(session?.roles, …)` shape every
  // other render-path gate in this console uses (`secrets/[...path]/page.tsx`,
  // `tickets/[id]/page.tsx`), reading the session cookie's snapshot
  // synchronously rather than the live gate: hiding a form is UX, not
  // authorization, and `render-path-capabilities.test.ts` is what keeps that
  // distinction from drifting.
  const session = await getCurrentSession();
  const canCreate =
    !requiresCapability() ||
    (hasCapability(session?.roles, "platform") &&
      hasCapability(session?.roles, "rotate-credentials"));

  if (!canCreate) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">{CANNOT_CREATE_MESSAGE}</p>
      </Shell>
    );
  }

  let stores: readonly SecretStore[] = [];
  let preferred: SecretStore | null = null;
  let error: unknown = null;
  // A separate flag rather than `error !== null`, because a rejection is not
  // guaranteed to be a value that reads as one. `throw null` is legal, and
  // `error !== null` reads it as a success: the page would render the form
  // over `stores = []`, drawing the form's own "no store is enabled" copy —
  // a claim about CONFIGURATION made on the strength of a read that failed.
  // (`throw undefined` does enter the narrow branch; what it defeats is
  // `resolveState`, handled in `createSecretState` above.) The flag records
  // the only thing actually known here: that the `catch` ran.
  let failed = false;
  try {
    const choices = await fetchSecretStores();
    stores = choices.enabled;
    preferred = choices.preferred;
  } catch (caught: unknown) {
    error = caught;
    failed = true;
  }

  if (failed) {
    return (
      <Shell>
        <SurfaceStateView
          state={createSecretState(error)}
          // Genuinely unreachable, and `createSecretState` is what makes it so
          // — it never hands `resolveState` a null error, so `empty` (the only
          // state that reads this prop) cannot be returned. Required by the
          // component's props, so it says what it would say rather than "".
          emptyMessage="No secret store is enabled for this deployment."
          reauthReturnTo="/platform/secrets/new"
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <CreateSecretForm stores={stores} preferred={preferred} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        breadcrumbs={[
          { label: "Secrets", href: "/platform/secrets" },
          { label: "New secret" },
        ]}
        title="New secret"
        // Spec §5's lede, stated before the operator fills anything in:
        // creation completes on its own. Every clause is load-bearing — the
        // dialog this replaces fused a KV write with a Git proposal and left
        // operators unsure which of the two had actually happened.
        description="Writes a version to the store you pick. It touches Git not at all, and it grants no application access — when this says the secret exists, it exists."
      />
      {children}
    </div>
  );
}
